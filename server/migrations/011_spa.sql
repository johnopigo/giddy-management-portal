-- =====================================================================
-- 011 Spa operations: the Owner sees everything in partnership units (read-only),
--     client intake forms and treatment notes (sensitive, SEN), and services
--     that need a current, consented intake before check-in.
--
-- Sensitive records are never read straight from the tables: every read goes
-- through a function that checks access and writes an audit entry (who looked,
-- at whose record). Contents are kept out of the audit log itself.
-- =====================================================================

-- A tenant-wide role with partnership read visibility (the System Owner) now reads every data class
-- in partnership units, sensitive data included. Still read-only: changes stay with the partner.
CREATE OR REPLACE FUNCTION sec.rebuild_user_scope(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM user_access_scope WHERE user_id = p_user;
  INSERT INTO user_access_scope (user_id, tenant_id, business_unit_id, data_class, access_level)
  SELECT a.user_id, a.tenant_id, bu.id, p.data_class,
         max(CASE WHEN a.business_unit_id IS NULL AND bu.management_model = 'partnership'
                  THEN 'read'::access_level ELSE p.access END)
  FROM user_role_assignment a
  JOIN role r             ON r.id = a.role_id
  JOIN role_permission rp ON rp.role_id = r.id
  JOIN permission p       ON p.code = rp.permission_code AND p.data_class IS NOT NULL
  JOIN business_unit bu   ON bu.tenant_id = a.tenant_id
                         AND (bu.id = a.business_unit_id OR a.business_unit_id IS NULL)
  WHERE a.user_id = p_user
    AND a.status = 'active'
    AND (a.business_unit_id IS NOT NULL
         OR bu.management_model = 'owner'
         OR r.partnership_visibility = 'read')
  GROUP BY a.user_id, a.tenant_id, bu.id, p.data_class;
END $$;
SELECT sec.rebuild_tenant_scope(id) FROM tenant;
UPDATE role SET description = 'Full control of owner-managed units; sees everything in partnership units, read-only.'
 WHERE code = 'SYSTEM_OWNER' AND tenant_id IS NULL;

-- =====================================================================
-- Intake forms (one current version per client per unit; every version kept)
-- =====================================================================
ALTER TABLE bookable_service ADD COLUMN requires_intake boolean NOT NULL DEFAULT false;
GRANT UPDATE (requires_intake) ON bookable_service TO giddy_app;

CREATE TABLE client_intake (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  business_unit_id   uuid NOT NULL,
  customer_id        uuid NOT NULL,
  version            integer NOT NULL CHECK (version >= 1),
  health_conditions  text NOT NULL DEFAULT '',
  allergies          text NOT NULL DEFAULT '',
  medications        text NOT NULL DEFAULT '',
  pregnant           boolean,
  skin_type          text NOT NULL DEFAULT '',
  preferences        text NOT NULL DEFAULT '',
  emergency_contact  text NOT NULL DEFAULT '',
  notes              text NOT NULL DEFAULT '',
  consent_given      boolean NOT NULL,
  consent_name       text,
  recorded_by        uuid NOT NULL REFERENCES app_user(id),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, business_unit_id, version),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customer(id, tenant_id),
  CHECK (NOT consent_given OR length(trim(coalesce(consent_name, ''))) >= 2)
);
CREATE TRIGGER client_intake_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON client_intake
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();

-- Notes a therapist writes about a treatment: what was done, products used, any reaction.
CREATE TABLE treatment_note (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  appointment_id    uuid NOT NULL,
  customer_id       uuid NOT NULL,
  body              text NOT NULL CHECK (length(trim(body)) >= 2),
  products_used     text NOT NULL DEFAULT '',
  reaction          text NOT NULL DEFAULT '',
  written_by        uuid NOT NULL REFERENCES app_user(id),
  written_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, business_unit_id) REFERENCES appointment(id, business_unit_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customer(id, tenant_id)
);
CREATE INDEX ON treatment_note (customer_id, business_unit_id);
CREATE TRIGGER treatment_note_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON treatment_note
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();

-- No direct access: the functions below are the only way in.
ALTER TABLE client_intake  ENABLE ROW LEVEL SECURITY;
ALTER TABLE treatment_note ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_intake, treatment_note FROM giddy_app;

-- Is the current user a therapist (or other staff resource) booked with this client in this unit,
-- from yesterday to a week ahead? They may read the client's sensitive record to treat them safely.
CREATE FUNCTION bk.treats_client(p_bu uuid, p_customer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM appointment a
      JOIN appointment_resource ar ON ar.appointment_id = a.id AND ar.is_active
      JOIN bookable_resource r ON r.id = ar.resource_id
     WHERE a.business_unit_id = p_bu AND a.customer_id = p_customer
       AND r.user_id = sec.current_user_id()
       AND a.status IN ('booked', 'checked_in', 'completed')
       AND a.starts_at BETWEEN now() - interval '1 day' AND now() + interval '7 days')
$$;

CREATE FUNCTION bk.can_read_sensitive(p_bu uuid, p_customer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT sec.has_scope(p_bu, 'SEN') OR bk.treats_client(p_bu, p_customer)
$$;

CREATE FUNCTION bk.log_sensitive(p_bu uuid, p_customer uuid, p_what text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT sec.audit_append(sec.current_tenant_id(), p_bu, 'sensitive_view', p_what, p_customer::text, NULL,
                          jsonb_build_object('customer_id', p_customer,
                                             'as', CASE WHEN sec.has_scope(p_bu, 'SEN') THEN 'sensitive access' ELSE 'treating therapist' END))
$$;

-- Is an intake on file, current and consented? No sensitive content; anyone who sees the booking may ask.
CREATE FUNCTION bk.intake_status(p_bu uuid, p_customer uuid,
  OUT on_file boolean, OUT version integer, OUT recorded_at timestamptz, OUT consent_given boolean,
  OUT valid_until timestamptz, OUT is_current boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id IS NOT NULL, i.version, i.recorded_at, i.consent_given,
         i.recorded_at + make_interval(months => bk.setting_int(p_bu, 'spa.intake_valid_months', 12)),
         coalesce(i.consent_given AND i.recorded_at + make_interval(months => bk.setting_int(p_bu, 'spa.intake_valid_months', 12)) > now(), false)
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT * FROM client_intake WHERE business_unit_id = p_bu AND customer_id = p_customer
                        ORDER BY version DESC LIMIT 1) i ON true
   WHERE sec.has_scope(p_bu, 'OPS') OR sec.has_scope(p_bu, 'SEN')
$$;

-- The current intake (or an earlier version). Every read is audited.
CREATE FUNCTION bk.intake_get(p_bu uuid, p_customer uuid, p_version integer DEFAULT NULL)
RETURNS SETOF client_intake
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT bk.can_read_sensitive(p_bu, p_customer) THEN
    RAISE EXCEPTION 'you cannot see this client''s health record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM bk.log_sensitive(p_bu, p_customer, 'client_intake');
  RETURN QUERY SELECT * FROM client_intake WHERE business_unit_id = p_bu AND customer_id = p_customer
                AND (p_version IS NULL OR version = p_version)
                ORDER BY version DESC LIMIT CASE WHEN p_version IS NULL THEN 1 END;
END $$;

-- Records a new version of the client's intake. Needs SEN write (the partner or a unit manager).
CREATE FUNCTION bk.intake_record(p_bu uuid, p_customer uuid, p_form jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_version integer; v_id uuid;
BEGIN
  IF NOT sec.has_scope(p_bu, 'SEN', true) THEN
    RAISE EXCEPTION 'you cannot record health information in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer WHERE id = p_customer AND tenant_id = sec.current_tenant_id()) THEN
    RAISE EXCEPTION 'client not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce((p_form ->> 'consentGiven')::boolean, false) AND length(trim(coalesce(p_form ->> 'consentName', ''))) < 2 THEN
    RAISE EXCEPTION 'type the client''s name to record their consent' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('intake:' || p_bu || p_customer, 0));
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM client_intake WHERE business_unit_id = p_bu AND customer_id = p_customer;
  INSERT INTO client_intake (tenant_id, business_unit_id, customer_id, version, health_conditions, allergies, medications,
                             pregnant, skin_type, preferences, emergency_contact, notes, consent_given, consent_name, recorded_by)
  VALUES (sec.current_tenant_id(), p_bu, p_customer, v_version,
          coalesce(p_form ->> 'healthConditions', ''), coalesce(p_form ->> 'allergies', ''), coalesce(p_form ->> 'medications', ''),
          (p_form ->> 'pregnant')::boolean, coalesce(p_form ->> 'skinType', ''), coalesce(p_form ->> 'preferences', ''),
          coalesce(p_form ->> 'emergencyContact', ''), coalesce(p_form ->> 'notes', ''),
          coalesce((p_form ->> 'consentGiven')::boolean, false), nullif(trim(coalesce(p_form ->> 'consentName', '')), ''),
          sec.current_user_id())
  RETURNING id INTO v_id;
  -- The audit entry records that a version was written, not what it says.
  PERFORM sec.audit_append(sec.current_tenant_id(), p_bu, 'insert', 'client_intake', v_id::text, NULL,
    jsonb_build_object('customer_id', p_customer, 'version', v_version,
                       'consent_given', coalesce((p_form ->> 'consentGiven')::boolean, false)));
  RETURN v_version;
END $$;

-- Treatment notes for a client (all their appointments in the unit). Audited.
CREATE FUNCTION bk.notes_get(p_bu uuid, p_customer uuid)
RETURNS TABLE (id bigint, appointment_id uuid, booking_ref text, service_name text, starts_at timestamptz,
               body text, products_used text, reaction text, written_by_name text, written_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT bk.can_read_sensitive(p_bu, p_customer) THEN
    RAISE EXCEPTION 'you cannot see this client''s treatment notes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM bk.log_sensitive(p_bu, p_customer, 'treatment_note');
  RETURN QUERY
  SELECT n.id, n.appointment_id, a.booking_ref, s.name, a.starts_at, n.body, n.products_used, n.reaction,
         sec.user_name(n.written_by), n.written_at
    FROM treatment_note n JOIN appointment a ON a.id = n.appointment_id JOIN bookable_service s ON s.id = a.service_id
   WHERE n.business_unit_id = p_bu AND n.customer_id = p_customer
   ORDER BY n.written_at DESC;
END $$;

-- The therapist on the appointment (or someone with SEN write) adds a note once the client has arrived.
CREATE FUNCTION bk.note_add(p_appt uuid, p_body text, p_products text, p_reaction text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE; v_id bigint;
BEGIN
  SELECT * INTO a FROM appointment WHERE id = p_appt AND tenant_id = sec.current_tenant_id();
  IF NOT FOUND OR NOT bk.visible(a.business_unit_id, a.id) THEN
    RAISE EXCEPTION 'appointment not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (sec.has_scope(a.business_unit_id, 'SEN', true)
          OR EXISTS (SELECT 1 FROM appointment_resource ar JOIN bookable_resource r ON r.id = ar.resource_id
                      WHERE ar.appointment_id = a.id AND r.user_id = sec.current_user_id())) THEN
    RAISE EXCEPTION 'only the therapist on this appointment can write its notes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF a.status NOT IN ('checked_in', 'completed') THEN
    RAISE EXCEPTION 'notes are written once the client has arrived' USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(coalesce(p_body, ''))) < 2 THEN RAISE EXCEPTION 'write what was done' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO treatment_note (tenant_id, business_unit_id, appointment_id, customer_id, body, products_used, reaction, written_by)
  VALUES (a.tenant_id, a.business_unit_id, a.id, a.customer_id, trim(p_body), coalesce(trim(p_products), ''),
          coalesce(trim(p_reaction), ''), sec.current_user_id())
  RETURNING id INTO v_id;
  PERFORM sec.audit_append(a.tenant_id, a.business_unit_id, 'insert', 'treatment_note', v_id::text, NULL,
    jsonb_build_object('appointment_id', a.id, 'customer_id', a.customer_id));
  RETURN v_id;
END $$;

-- Check-in now also needs a current, consented intake when the service asks for one.
CREATE OR REPLACE FUNCTION bk.check_in(p_appt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE; v_tz text; v_needs boolean; v_ok boolean;
BEGIN
  a := bk.lock_appointment(p_appt);
  IF a.status <> 'booked' THEN
    RAISE EXCEPTION 'only a booked appointment can check in (this one is %)', replace(a.status::text, '_', ' ') USING ERRCODE = 'check_violation';
  END IF;
  SELECT time_zone INTO v_tz FROM business_unit WHERE id = a.business_unit_id;
  IF (a.starts_at AT TIME ZONE v_tz)::date <> (now() AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'check-in is on the day of the appointment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT requires_intake INTO v_needs FROM bookable_service WHERE id = a.service_id;
  IF v_needs THEN
    SELECT coalesce(i.consent_given AND i.recorded_at + make_interval(months => bk.setting_int(a.business_unit_id, 'spa.intake_valid_months', 12)) > now(), false)
      INTO v_ok
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (SELECT * FROM client_intake WHERE business_unit_id = a.business_unit_id AND customer_id = a.customer_id
                          ORDER BY version DESC LIMIT 1) i ON true;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'this treatment needs a current intake form with the client''s consent' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE appointment SET status = 'checked_in', checked_in_by = sec.current_user_id(), checked_in_at = now(),
         row_version = row_version + 1 WHERE id = a.id;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bk FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  bk.book(uuid, uuid, timestamptz, integer, booking_source, text, jsonb),
  bk.reschedule(uuid, timestamptz, integer, jsonb),
  bk.check_in(uuid), bk.complete(uuid), bk.cancel(uuid, text, text, boolean), bk.extend(uuid, integer),
  bk.availability(uuid, date, integer, jsonb, uuid),
  bk.set_hours(uuid, jsonb), bk.add_block(uuid, timestamptz, timestamptz, text),
  bk.unit_people(uuid), bk.visible(uuid, uuid), bk.local_label(uuid, timestamptz),
  bk.bill_balance(uuid), bk.bill_paid(uuid), bk.bill_money(uuid), bk.gross(uuid, numeric), bk.expected_total(uuid),
  bk.bill_post(uuid, text, text, numeric, payment_method, text), bk.add_addon(uuid, uuid, numeric, uuid), bk.void_addon(bigint, text),
  bk.can_read_sensitive(uuid, uuid), bk.intake_status(uuid, uuid), bk.intake_get(uuid, uuid, integer),
  bk.intake_record(uuid, uuid, jsonb), bk.notes_get(uuid, uuid), bk.note_add(uuid, text, text, text)
TO giddy_app;
