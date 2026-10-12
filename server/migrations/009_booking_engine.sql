-- =====================================================================
-- 009 Booking engine (shared by the Spa and the Content Studio)
--
--   Service-based: a treatment of fixed length that needs one resource of each
--                  role (e.g. a therapist AND a treatment room).
--   Slot-based:    a resource (e.g. a booth) rented in consecutive fixed slots.
--
-- Every booked resource holds a time range in appointment_resource. Booking locks
-- the candidate resource rows (FOR UPDATE, in id order) before checking, and an
-- exclusion constraint on (resource, time range) is the final guarantee that no
-- resource is ever booked twice.
-- =====================================================================

CREATE SCHEMA bk;
REVOKE ALL ON SCHEMA bk FROM PUBLIC;
GRANT USAGE ON SCHEMA bk TO giddy_app;

-- True when the user's only access to a unit comes from "self" roles (therapists, attendants):
-- they see their own schedule, not everyone's.
CREATE FUNCTION sec.is_self_only(p_bu uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM user_role_assignment a
      JOIN role r ON r.id = a.role_id
      JOIN role_permission rp ON rp.role_id = r.id AND rp.permission_code IN ('ops.read', 'ops.write')
      JOIN business_unit bu ON bu.id = p_bu
     WHERE a.user_id = sec.current_user_id() AND a.status = 'active' AND r.scope_level <> 'self'
       AND (a.business_unit_id = p_bu
            OR (a.business_unit_id IS NULL AND (bu.management_model = 'owner' OR r.partnership_visibility = 'read'))))
$$;

-- =====================================================================
-- Resources, opening hours, blocks (configuration)
-- =====================================================================
CREATE TYPE resource_kind AS ENUM ('staff', 'room', 'booth', 'equipment');

CREATE TABLE bookable_resource (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  kind              resource_kind NOT NULL,
  name              text NOT NULL CHECK (length(trim(name)) >= 2),
  user_id           uuid,               -- the staff member's own login, so they see their schedule
  is_active         boolean NOT NULL DEFAULT true,
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, name),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (user_id, tenant_id) REFERENCES app_user(id, tenant_id),
  CHECK (user_id IS NULL OR kind = 'staff')
);
CREATE UNIQUE INDEX bookable_resource_user_uq ON bookable_resource (business_unit_id, user_id) WHERE user_id IS NOT NULL;

-- Weekly hours in the unit's local time. weekday: 1 = Monday … 7 = Sunday (ISO).
-- A day may have several intervals (split shifts). closes may be 24:00.
CREATE TABLE resource_hours (
  resource_id       uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  weekday           smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens             time NOT NULL,
  closes            time NOT NULL,
  PRIMARY KEY (resource_id, weekday, opens),
  FOREIGN KEY (resource_id, business_unit_id) REFERENCES bookable_resource(id, business_unit_id) ON DELETE CASCADE,
  CHECK (closes > opens)
);

-- Time off, maintenance, private use: the resource cannot be booked in this range.
CREATE TABLE resource_block (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  resource_id       uuid NOT NULL,
  during            tstzrange NOT NULL CHECK (NOT isempty(during) AND NOT lower_inf(during) AND NOT upper_inf(during)),
  reason            text NOT NULL CHECK (length(trim(reason)) >= 2),
  created_by        uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (resource_id, business_unit_id) REFERENCES bookable_resource(id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id)
);
CREATE INDEX ON resource_block USING gist (resource_id, during);

-- =====================================================================
-- Services
-- =====================================================================
CREATE TYPE service_mode AS ENUM ('service', 'slot');

CREATE TABLE bookable_service (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  mode              service_mode NOT NULL,
  -- service mode: length of the treatment; slot mode: length of one slot.
  duration_min      integer NOT NULL CHECK (duration_min BETWEEN 5 AND 720 AND duration_min % 5 = 0),
  -- clean-up / changeover time after each booking; the resources stay held for it.
  buffer_min        integer NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 240 AND buffer_min % 5 = 0),
  min_slots         integer NOT NULL DEFAULT 1 CHECK (min_slots >= 1),
  max_slots         integer NOT NULL DEFAULT 1,
  -- service mode: price per booking; slot mode: price per slot.
  price             numeric(14, 2) NOT NULL CHECK (price >= 0),
  online_bookable   boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, code),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  CHECK (max_slots >= min_slots AND max_slots <= 48),
  CHECK (mode = 'slot' OR (min_slots = 1 AND max_slots = 1))
);

-- Which resources can deliver a service, grouped by role. A booking needs one resource of every role.
CREATE TABLE service_resource (
  tenant_id         uuid NOT NULL,
  service_id        uuid NOT NULL,
  resource_id       uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  role              text NOT NULL CHECK (role ~ '^[a-z][a-z ]{1,29}$'),
  PRIMARY KEY (service_id, resource_id),
  FOREIGN KEY (service_id, business_unit_id) REFERENCES bookable_service(id, business_unit_id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id, business_unit_id) REFERENCES bookable_resource(id, business_unit_id)
);

-- =====================================================================
-- Appointments
-- =====================================================================
CREATE TYPE booking_source AS ENUM ('direct', 'walk_in', 'phone', 'online');
CREATE TYPE appointment_status AS ENUM ('booked', 'checked_in', 'completed', 'cancelled', 'no_show');

CREATE TABLE appointment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  booking_ref       text NOT NULL,
  service_id        uuid NOT NULL,
  customer_id       uuid NOT NULL,
  source            booking_source NOT NULL DEFAULT 'direct',
  status            appointment_status NOT NULL DEFAULT 'booked',
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  slots             integer NOT NULL DEFAULT 1 CHECK (slots >= 1),
  price             numeric(14, 2) NOT NULL CHECK (price >= 0),
  notes             text NOT NULL DEFAULT '',
  created_by        uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  checked_in_by     uuid REFERENCES app_user(id),
  checked_in_at     timestamptz,
  completed_by      uuid REFERENCES app_user(id),
  completed_at      timestamptz,
  cancelled_by      uuid REFERENCES app_user(id),
  cancelled_at      timestamptz,
  cancel_reason     text,
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, booking_ref),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (service_id, business_unit_id) REFERENCES bookable_service(id, business_unit_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customer(id, tenant_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX ON appointment (business_unit_id, starts_at);
CREATE INDEX ON appointment (customer_id);

-- The time each resource is held: [start, end + buffer). Released bookings keep their row (is_active = false).
CREATE TABLE appointment_resource (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id    uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  resource_id       uuid NOT NULL,
  role              text NOT NULL,
  during            tstzrange NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  FOREIGN KEY (appointment_id, business_unit_id) REFERENCES appointment(id, business_unit_id),
  FOREIGN KEY (resource_id, business_unit_id) REFERENCES bookable_resource(id, business_unit_id),
  CONSTRAINT resource_double_booked EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE (is_active)
);
CREATE INDEX ON appointment_resource (appointment_id);

-- =====================================================================
-- Engine
-- =====================================================================
CREATE FUNCTION bk.setting_int(p_bu uuid, p_key text, p_default integer) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT (value #>> '{}')::integer FROM business_unit_setting WHERE business_unit_id = p_bu AND key = p_key), p_default)
$$;

CREATE FUNCTION bk.local_label(p_bu uuid, p_at timestamptz) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT to_char(p_at AT TIME ZONE time_zone, 'Dy DD Mon HH24:MI') FROM business_unit WHERE id = p_bu
$$;

-- Is the resource open for [p_start, p_end) and free (no block, no other booking) for p_hold?
-- p_except: an appointment whose own holds are ignored (rescheduling).
CREATE FUNCTION bk.resource_free(p_resource uuid, p_start timestamptz, p_end timestamptz, p_hold tstzrange, p_except uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT r.is_active
       AND EXISTS (SELECT 1 FROM resource_hours h
                    WHERE h.resource_id = r.id
                      AND h.weekday = extract(isodow FROM p_start AT TIME ZONE bu.time_zone)
                      AND (p_start AT TIME ZONE bu.time_zone)::date + h.opens <= p_start AT TIME ZONE bu.time_zone
                      AND p_end AT TIME ZONE bu.time_zone <= (p_start AT TIME ZONE bu.time_zone)::date + h.closes)
       AND NOT EXISTS (SELECT 1 FROM resource_block b WHERE b.resource_id = r.id AND b.during && p_hold)
       AND NOT EXISTS (SELECT 1 FROM appointment_resource ar
                        WHERE ar.resource_id = r.id AND ar.is_active AND ar.during && p_hold
                          AND ar.appointment_id IS DISTINCT FROM p_except)
      FROM bookable_resource r JOIN business_unit bu ON bu.id = r.business_unit_id
     WHERE r.id = p_resource), false)
$$;

-- Chooses one free resource per role. Returns {"picks": [{role, resourceId}]} or {"missing": role}.
-- With p_lock, every candidate resource row is locked first (in id order, so concurrent bookings
-- queue instead of deadlocking); the check that follows then sees every booking committed before it.
-- Among free resources the least busy that day wins, so work is spread evenly.
CREATE FUNCTION bk.pick(p_service uuid, p_start timestamptz, p_end timestamptz, p_preferred jsonb, p_except uuid, p_lock boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s       bookable_service%ROWTYPE;
  v_hold  tstzrange;
  v_role  text;
  v_pick  uuid;
  v_out   jsonb := '[]';
  v_tz    text;
BEGIN
  SELECT * INTO s FROM bookable_service WHERE id = p_service;
  SELECT time_zone INTO v_tz FROM business_unit WHERE id = s.business_unit_id;
  v_hold := tstzrange(p_start, p_end + make_interval(mins => s.buffer_min));
  IF p_lock THEN
    PERFORM 1 FROM bookable_resource
     WHERE id IN (SELECT resource_id FROM service_resource WHERE service_id = p_service)
     ORDER BY id FOR UPDATE;
  END IF;
  FOR v_role IN SELECT DISTINCT role FROM service_resource WHERE service_id = p_service ORDER BY role LOOP
    SELECT sr.resource_id INTO v_pick
      FROM service_resource sr JOIN bookable_resource r ON r.id = sr.resource_id
     WHERE sr.service_id = p_service AND sr.role = v_role
       AND (p_preferred ->> v_role IS NULL OR sr.resource_id = (p_preferred ->> v_role)::uuid)
       AND bk.resource_free(sr.resource_id, p_start, p_end, v_hold, p_except)
     ORDER BY (SELECT count(*) FROM appointment_resource ar
                WHERE ar.resource_id = r.id AND ar.is_active
                  AND (lower(ar.during) AT TIME ZONE v_tz)::date = (p_start AT TIME ZONE v_tz)::date), r.name
     LIMIT 1;
    IF v_pick IS NULL THEN
      RETURN jsonb_build_object('missing', v_role, 'preferred', p_preferred ? v_role);
    END IF;
    v_out := v_out || jsonb_build_object('role', v_role, 'resourceId', v_pick);
  END LOOP;
  IF jsonb_array_length(v_out) = 0 THEN
    RAISE EXCEPTION 'this service has no resources set up yet' USING ERRCODE = 'check_violation';
  END IF;
  RETURN jsonb_build_object('picks', v_out);
END $$;

-- Shared checks for a requested time. Returns the end time.
CREATE FUNCTION bk.check_time(s bookable_service, p_start timestamptz, p_slots integer) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_start IS NULL THEN RAISE EXCEPTION 'choose a start time' USING ERRCODE = 'check_violation'; END IF;
  IF p_slots IS NULL OR p_slots < s.min_slots OR p_slots > s.max_slots THEN
    RAISE EXCEPTION '%', CASE WHEN s.min_slots = s.max_slots THEN format('%s is booked as %s slot(s)', s.name, s.min_slots)
                              ELSE format('%s is booked for %s to %s slots', s.name, s.min_slots, s.max_slots) END
      USING ERRCODE = 'check_violation';
  END IF;
  IF extract(epoch FROM p_start)::bigint % 300 <> 0 THEN
    RAISE EXCEPTION 'start times are on 5-minute marks' USING ERRCODE = 'check_violation';
  END IF;
  IF p_start < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'that time has already passed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_start > now() + make_interval(days => bk.setting_int(s.business_unit_id, 'booking.max_days_ahead', 90)) THEN
    RAISE EXCEPTION 'bookings open % days ahead', bk.setting_int(s.business_unit_id, 'booking.max_days_ahead', 90)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN p_start + make_interval(mins => s.duration_min * p_slots);
END $$;

CREATE FUNCTION bk.raise_unavailable(s bookable_service, p_start timestamptz, p_pick jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '%', CASE WHEN (p_pick ->> 'preferred')::boolean
      THEN format('the chosen %s is not free for %s at %s', p_pick ->> 'missing', s.name, bk.local_label(s.business_unit_id, p_start))
      ELSE format('no %s is free for %s at %s', p_pick ->> 'missing', s.name, bk.local_label(s.business_unit_id, p_start)) END
    USING ERRCODE = 'GD409';
END $$;

CREATE FUNCTION bk.hold(p_appt uuid, p_bu uuid, s bookable_service, p_start timestamptz, p_end timestamptz, p_picks jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO appointment_resource (appointment_id, business_unit_id, resource_id, role, during)
  SELECT p_appt, p_bu, (p ->> 'resourceId')::uuid, p ->> 'role', tstzrange(p_start, p_end + make_interval(mins => s.buffer_min))
    FROM jsonb_array_elements(p_picks) p
$$;

-- Tells staff who have their own login about a booking on their schedule.
CREATE FUNCTION bk.notify_staff(p_appt uuid, p_title text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT sec.notify_user(r.user_id, a.business_unit_id, 'appointment', p_title,
                         s.name || ' · ' || c.full_name || ' · ' || bk.local_label(a.business_unit_id, a.starts_at),
                         '/appointments/' || a.business_unit_id || '/' || a.id)
    FROM appointment a JOIN bookable_service s ON s.id = a.service_id JOIN customer c ON c.id = a.customer_id
    JOIN appointment_resource ar ON ar.appointment_id = a.id AND ar.is_active
    JOIN bookable_resource r ON r.id = ar.resource_id AND r.user_id IS NOT NULL AND r.user_id <> sec.current_user_id()
   WHERE a.id = p_appt
$$;

-- p_preferred: {"therapist": "<resource id>", …} to ask for a particular resource; others are auto-assigned.
CREATE FUNCTION bk.book(p_service uuid, p_customer uuid, p_start timestamptz, p_slots integer, p_source booking_source,
                        p_notes text, p_preferred jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s       bookable_service%ROWTYPE;
  v_end   timestamptz;
  v_pick  jsonb;
  v_id    uuid;
  v_slots integer;
BEGIN
  SELECT * INTO s FROM bookable_service WHERE id = p_service AND tenant_id = sec.current_tenant_id();
  IF NOT FOUND OR NOT sec.has_scope(s.business_unit_id, 'OPS') THEN
    RAISE EXCEPTION 'service not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT sec.has_scope(s.business_unit_id, 'OPS', true) OR sec.is_self_only(s.business_unit_id) THEN
    RAISE EXCEPTION 'you cannot take bookings in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT s.is_active THEN RAISE EXCEPTION '% is not offered at the moment', s.name USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer WHERE id = p_customer AND tenant_id = s.tenant_id) THEN
    RAISE EXCEPTION 'guest not found' USING ERRCODE = 'check_violation';
  END IF;
  v_slots := coalesce(p_slots, s.min_slots);
  v_end := bk.check_time(s, p_start, v_slots);
  v_pick := bk.pick(p_service, p_start, v_end, coalesce(p_preferred, '{}'), NULL, true);
  IF v_pick ? 'missing' THEN PERFORM bk.raise_unavailable(s, p_start, v_pick); END IF;

  INSERT INTO appointment (tenant_id, business_unit_id, booking_ref, service_id, customer_id, source, starts_at, ends_at,
                           slots, price, notes, created_by)
  VALUES (s.tenant_id, s.business_unit_id, inv.next_doc_number(s.business_unit_id, 'BKG'), s.id, p_customer,
          coalesce(p_source, 'direct'), p_start, v_end, v_slots, s.price * v_slots, coalesce(p_notes, ''), sec.current_user_id())
  RETURNING id INTO v_id;
  PERFORM bk.hold(v_id, s.business_unit_id, s, p_start, v_end, v_pick -> 'picks');
  PERFORM bk.notify_staff(v_id, 'New booking');
  RETURN v_id;
END $$;

CREATE FUNCTION bk.lock_appointment(p_appt uuid) RETURNS appointment
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE;
BEGIN
  SELECT * INTO a FROM appointment WHERE id = p_appt AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(a.business_unit_id, 'OPS') THEN
    RAISE EXCEPTION 'appointment not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT sec.has_scope(a.business_unit_id, 'OPS', true) OR sec.is_self_only(a.business_unit_id) THEN
    RAISE EXCEPTION 'you cannot change appointments in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN a;
END $$;

-- Moves a booked appointment (and optionally changes the requested resources). Price stays as booked.
CREATE FUNCTION bk.reschedule(p_appt uuid, p_start timestamptz, p_slots integer, p_preferred jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a       appointment%ROWTYPE;
  s       bookable_service%ROWTYPE;
  v_end   timestamptz;
  v_pick  jsonb;
  v_slots integer;
BEGIN
  a := bk.lock_appointment(p_appt);
  IF a.status <> 'booked' THEN
    RAISE EXCEPTION 'only a booked appointment can be moved (this one is %)', replace(a.status::text, '_', ' ') USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO s FROM bookable_service WHERE id = a.service_id;
  v_slots := coalesce(p_slots, a.slots);
  v_end := bk.check_time(s, p_start, v_slots);
  v_pick := bk.pick(s.id, p_start, v_end, coalesce(p_preferred, '{}'), a.id, true);
  IF v_pick ? 'missing' THEN PERFORM bk.raise_unavailable(s, p_start, v_pick); END IF;
  DELETE FROM appointment_resource WHERE appointment_id = a.id;
  PERFORM bk.hold(a.id, a.business_unit_id, s, p_start, v_end, v_pick -> 'picks');
  UPDATE appointment SET starts_at = p_start, ends_at = v_end, slots = v_slots,
         price = CASE WHEN v_slots = a.slots THEN a.price ELSE s.price * v_slots END,
         row_version = row_version + 1
   WHERE id = a.id;
  PERFORM bk.notify_staff(a.id, 'Booking moved');
END $$;

CREATE FUNCTION bk.check_in(p_appt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE; v_tz text;
BEGIN
  a := bk.lock_appointment(p_appt);
  IF a.status <> 'booked' THEN
    RAISE EXCEPTION 'only a booked appointment can check in (this one is %)', replace(a.status::text, '_', ' ') USING ERRCODE = 'check_violation';
  END IF;
  SELECT time_zone INTO v_tz FROM business_unit WHERE id = a.business_unit_id;
  IF (a.starts_at AT TIME ZONE v_tz)::date <> (now() AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'check-in is on the day of the appointment' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE appointment SET status = 'checked_in', checked_in_by = sec.current_user_id(), checked_in_at = now(),
         row_version = row_version + 1 WHERE id = a.id;
END $$;

-- Finishing early hands the rest of the time (after the buffer) back to the schedule.
CREATE FUNCTION bk.complete(p_appt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE; s bookable_service%ROWTYPE;
BEGIN
  a := bk.lock_appointment(p_appt);
  IF a.status <> 'checked_in' THEN
    RAISE EXCEPTION 'check the guest in first' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO s FROM bookable_service WHERE id = a.service_id;
  IF now() < a.ends_at THEN
    UPDATE appointment_resource
       SET during = tstzrange(lower(during), greatest(now(), a.starts_at) + make_interval(mins => s.buffer_min))
     WHERE appointment_id = a.id AND is_active
       AND greatest(now(), a.starts_at) + make_interval(mins => s.buffer_min) > lower(during);
  END IF;
  UPDATE appointment SET status = 'completed', completed_by = sec.current_user_id(), completed_at = now(),
         row_version = row_version + 1 WHERE id = a.id;
END $$;

-- p_action: 'cancelled' or 'no_show'. Either releases the resources.
CREATE FUNCTION bk.cancel(p_appt uuid, p_action text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE;
BEGIN
  a := bk.lock_appointment(p_appt);
  IF p_action NOT IN ('cancelled', 'no_show') THEN RAISE EXCEPTION 'unknown action' USING ERRCODE = 'check_violation'; END IF;
  IF a.status <> 'booked' THEN
    RAISE EXCEPTION 'only a booked appointment can be %', replace(p_action, '_', '-') USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'no_show' AND now() < a.starts_at THEN
    RAISE EXCEPTION 'a guest can only be a no-show after the start time' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'cancelled' AND coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'give a reason for cancelling' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE appointment_resource SET is_active = false WHERE appointment_id = a.id;
  UPDATE appointment SET status = p_action::appointment_status, cancelled_by = sec.current_user_id(), cancelled_at = now(),
         cancel_reason = nullif(trim(coalesce(p_reason, '')), ''), row_version = row_version + 1
   WHERE id = a.id;
  IF p_action = 'cancelled' THEN PERFORM bk.notify_staff(a.id, 'Booking cancelled'); END IF;
END $$;

-- Free start times for a service on a local date. options: {"<role>": [{id, name}, …]} lists the free
-- resources of each role at that time. Service mode steps every booking.step_min (default 15) minutes;
-- slot mode steps one slot at a time from each resource's opening time.
-- p_except: an appointment being moved, whose own time counts as free.
CREATE FUNCTION bk.availability(p_service uuid, p_date date, p_slots integer, p_preferred jsonb, p_except uuid DEFAULT NULL)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz, options jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s       bookable_service%ROWTYPE;
  v_tz    text;
  v_len   interval;
  v_step  interval;
  v_roles integer;
BEGIN
  SELECT * INTO s FROM bookable_service WHERE id = p_service AND tenant_id = sec.current_tenant_id();
  IF NOT FOUND OR NOT sec.has_scope(s.business_unit_id, 'OPS') THEN
    RAISE EXCEPTION 'service not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT time_zone INTO v_tz FROM business_unit WHERE id = s.business_unit_id;
  v_len := make_interval(mins => s.duration_min * least(greatest(coalesce(p_slots, s.min_slots), s.min_slots), s.max_slots));
  v_step := make_interval(mins => CASE WHEN s.mode = 'slot' THEN s.duration_min
                                       ELSE greatest(bk.setting_int(s.business_unit_id, 'booking.step_min', 15), 5) END);
  SELECT count(DISTINCT role) INTO v_roles FROM service_resource WHERE service_id = p_service;
  RETURN QUERY
  WITH c AS (
    SELECT DISTINCT (gs AT TIME ZONE v_tz) AS t
      FROM service_resource sr
      JOIN resource_hours h ON h.resource_id = sr.resource_id AND h.weekday = extract(isodow FROM p_date)
      CROSS JOIN LATERAL generate_series(p_date + h.opens, p_date + h.closes - v_len, v_step) gs
     WHERE sr.service_id = p_service
  ), f AS (
    SELECT c.t, sr.role, jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.name) AS free
      FROM c
      JOIN service_resource sr ON sr.service_id = p_service
      JOIN bookable_resource r ON r.id = sr.resource_id
     WHERE c.t >= now()
       AND (p_preferred ->> sr.role IS NULL OR r.id = (p_preferred ->> sr.role)::uuid)
       AND bk.resource_free(r.id, c.t, c.t + v_len, tstzrange(c.t, c.t + v_len + make_interval(mins => s.buffer_min)), p_except)
     GROUP BY c.t, sr.role
  )
  SELECT f.t, f.t + v_len, jsonb_object_agg(f.role, f.free)
    FROM f GROUP BY f.t HAVING count(*) = v_roles ORDER BY f.t;
END $$;

-- Weekly hours: replaces all of a resource's hours. p_hours: [{"weekday": 1-7, "opens": "09:00", "closes": "18:00"}]
CREATE FUNCTION bk.set_hours(p_resource uuid, p_hours jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r bookable_resource%ROWTYPE;
BEGIN
  SELECT * INTO r FROM bookable_resource WHERE id = p_resource AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT (sec.has_scope(r.business_unit_id, 'CFG') OR sec.has_scope(r.business_unit_id, 'OPS')) THEN
    RAISE EXCEPTION 'resource not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT sec.has_scope(r.business_unit_id, 'CFG', true) THEN
    RAISE EXCEPTION 'you cannot change opening hours in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM resource_hours WHERE resource_id = r.id;
  INSERT INTO resource_hours (resource_id, business_unit_id, weekday, opens, closes)
  SELECT r.id, r.business_unit_id, (h ->> 'weekday')::smallint, (h ->> 'opens')::time, (h ->> 'closes')::time
    FROM jsonb_array_elements(coalesce(p_hours, '[]')) h;
  IF EXISTS (SELECT 1 FROM resource_hours a JOIN resource_hours b
               ON a.resource_id = b.resource_id AND a.weekday = b.weekday AND a.opens < b.opens AND b.opens < a.closes
              WHERE a.resource_id = r.id) THEN
    RAISE EXCEPTION 'opening hours overlap on the same day' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- Blocks time on a resource. Existing bookings in that time must be moved or cancelled first.
CREATE FUNCTION bk.add_block(p_resource uuid, p_from timestamptz, p_to timestamptz, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r bookable_resource%ROWTYPE; v_refs text; v_id uuid;
BEGIN
  SELECT * INTO r FROM bookable_resource WHERE id = p_resource AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(r.business_unit_id, 'OPS') THEN
    RAISE EXCEPTION 'resource not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT sec.has_scope(r.business_unit_id, 'OPS', true) OR sec.is_self_only(r.business_unit_id) THEN
    RAISE EXCEPTION 'you cannot block time in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'the block must end after it starts' USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(a.booking_ref, ', ' ORDER BY a.starts_at) INTO v_refs
    FROM appointment_resource ar JOIN appointment a ON a.id = ar.appointment_id
   WHERE ar.resource_id = r.id AND ar.is_active AND ar.during && tstzrange(p_from, p_to);
  IF v_refs IS NOT NULL THEN
    RAISE EXCEPTION 'move or cancel these bookings first: %', v_refs USING ERRCODE = 'GD409';
  END IF;
  INSERT INTO resource_block (tenant_id, business_unit_id, resource_id, during, reason, created_by)
  VALUES (r.tenant_id, r.business_unit_id, r.id, tstzrange(p_from, p_to), coalesce(p_reason, ''), sec.current_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- People who work in a unit, for linking a staff resource to their login (managers lack users.read).
CREATE FUNCTION bk.unit_people(p_bu uuid) RETURNS TABLE (id uuid, full_name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.id, u.full_name, u.email::text
    FROM user_role_assignment a JOIN app_user u ON u.id = a.user_id
   WHERE sec.has_scope(p_bu, 'CFG', true)
     AND a.business_unit_id = p_bu AND a.status = 'active' AND u.is_active AND u.tenant_id = sec.current_tenant_id()
   ORDER BY u.full_name
$$;

-- Row-level visibility of an appointment for self-only staff: only those they are booked on.
CREATE FUNCTION bk.visible(p_bu uuid, p_appt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT sec.has_scope(p_bu, 'OPS')
     AND (NOT sec.is_self_only(p_bu)
          OR EXISTS (SELECT 1 FROM appointment_resource ar JOIN bookable_resource r ON r.id = ar.resource_id
                      WHERE ar.appointment_id = p_appt AND r.user_id = sec.current_user_id()))
$$;

-- =====================================================================
-- Guards, audit, row-level security
-- =====================================================================
CREATE TRIGGER resource_version BEFORE UPDATE ON bookable_resource FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER service_version  BEFORE UPDATE ON bookable_service  FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON bookable_resource FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON bookable_service  FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR DELETE ON service_resource            FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR DELETE ON resource_block              FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON appointment                 FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

ALTER TABLE bookable_resource    ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_hours       ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_block       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookable_service     ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_resource     ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment          ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_resource ENABLE ROW LEVEL SECURITY;

-- Configuration: everyone working in the unit reads it; managers (CFG write) maintain it.
CREATE POLICY resource_read ON bookable_resource FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY resource_write ON bookable_resource FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));
CREATE POLICY hours_read ON resource_hours FOR SELECT TO giddy_app
  USING (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG'));
CREATE POLICY block_read ON resource_block FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY block_delete ON resource_block FOR DELETE TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS', true) AND NOT sec.is_self_only(business_unit_id));
CREATE POLICY service_read ON bookable_service FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY service_write ON bookable_service FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));
CREATE POLICY service_resource_read ON service_resource FOR SELECT TO giddy_app
  USING (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG'));
CREATE POLICY service_resource_write ON service_resource FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));

-- Appointments change only through bk.* functions.
CREATE POLICY appointment_read ON appointment FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND bk.visible(business_unit_id, id));
CREATE POLICY appointment_resource_read ON appointment_resource FOR SELECT TO giddy_app
  USING (bk.visible(business_unit_id, appointment_id));

GRANT SELECT, INSERT ON bookable_resource, bookable_service TO giddy_app;
GRANT UPDATE (name, kind, user_id, is_active) ON bookable_resource TO giddy_app;
GRANT UPDATE (name, description, duration_min, buffer_min, min_slots, max_slots, price, online_bookable, is_active)
  ON bookable_service TO giddy_app;
GRANT SELECT, INSERT, DELETE ON service_resource TO giddy_app;
GRANT SELECT ON resource_hours, appointment, appointment_resource TO giddy_app;
GRANT SELECT, DELETE ON resource_block TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bk FROM PUBLIC;
REVOKE ALL ON FUNCTION sec.is_self_only(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sec.is_self_only(uuid) TO giddy_app;
GRANT EXECUTE ON FUNCTION
  bk.book(uuid, uuid, timestamptz, integer, booking_source, text, jsonb),
  bk.reschedule(uuid, timestamptz, integer, jsonb),
  bk.check_in(uuid), bk.complete(uuid), bk.cancel(uuid, text, text),
  bk.availability(uuid, date, integer, jsonb, uuid),
  bk.set_hours(uuid, jsonb), bk.add_block(uuid, timestamptz, timestamptz, text),
  bk.unit_people(uuid), bk.visible(uuid, uuid), bk.local_label(uuid, timestamptz)
TO giddy_app;
