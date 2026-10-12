import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, formatDateTime } from '../components/ui.jsx';
import { formatMoney } from '../components/UnitPicker.jsx';
import { formatDuration, localDate, localTime, longDate, todayIn } from '../lib/time.js';
import { APPT_STATUS, DEFAULT_TZ, TimeChooser, lengthLabel } from './AppointmentsPage.jsx';
import { AppointmentBill } from '../components/AppointmentBill.jsx';

export function AppointmentPage() {
  const { unitId, id } = useParams();
  const { me } = useSession();
  const appt = useLoad(() => api.get(`/api/bookings/${unitId}/appointments/${id}`), [unitId, id]);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [moving, setMoving] = useState(false);
  const [keepDeposit, setKeepDeposit] = useState(true);
  const canWrite = unitAccess(me, unitId, 'OPS') === 'write';
  const run = async (fn) => {
    setError(null);
    try { await fn(); appt.reload(); return true; } catch (err) { setError(err); return false; }
  };

  if (!appt.data) return <ErrorNote error={appt.error} />;
  const a = appt.data;
  const tz = a.time_zone ?? DEFAULT_TZ;
  const date = localDate(a.starts_at, tz);
  const base = `/api/bookings/${unitId}/appointments/${id}`;
  const service = { mode: a.mode, duration_min: a.duration_min, min_slots: a.min_slots };
  const mins = Math.round((new Date(a.ends_at) - new Date(a.starts_at)) / 60000);
  const credit = a.bill ? -Number(a.bill.balance) : 0;
  const keep = credit > 0 && keepDeposit;
  const canExtend = canWrite && a.mode === 'slot' && ['booked', 'checked_in'].includes(a.status) && a.slots < a.max_slots;

  return (
    <>
      <div className="row"><Link to="/appointments">← Appointments</Link></div>
      <section className="card">
        <div className="row wrap spread">
          <h1>{a.guest_name} <Badge tone={APPT_STATUS[a.status][1]}>{APPT_STATUS[a.status][0]}</Badge></h1>
          <strong>{formatMoney(a.price)}</strong>
        </div>
        <div className="small">{a.booking_ref} · {a.guest_phone ?? 'no phone'} · via {a.source.replace('_', ' ')}</div>
        <p>
          <strong>{a.service_name}</strong>{a.mode === 'slot' ? ` · ${lengthLabel(service, a.slots)}` : ''}<br />
          <strong>{longDate(date)}, {localTime(a.starts_at, tz)}–{localTime(a.ends_at, tz)}</strong> ({formatDuration(mins)}
          {a.buffer_min ? ` + ${a.buffer_min} min turnaround` : ''})<br />
          With {a.resources?.map((r) => `${r.name} (${r.role})`).join(', ') ?? '—'}
        </p>
        {a.notes && <p className="prewrap">{a.notes}</p>}
        <p className="muted small">
          Booked by {a.created_by_name} {formatDateTime(a.created_at)}
          {a.checked_in_at && ` · arrived, checked in by ${a.checked_in_by_name} ${formatDateTime(a.checked_in_at)}`}
          {a.completed_at && ` · completed by ${a.completed_by_name} ${formatDateTime(a.completed_at)}`}
          {a.cancelled_at && ` · ${a.status === 'no_show' ? 'marked no-show' : 'cancelled'} by ${a.cancelled_by_name} ${formatDateTime(a.cancelled_at)}`}
          {a.cancel_reason && ` (${a.cancel_reason})`}
        </p>
        <ErrorNote error={error} />
        {canWrite && a.status === 'booked' && (
          <div className="row wrap">
            <button className="primary" onClick={() => run(() => api.post(`${base}/check-in`))}
              title={date !== todayIn(tz) ? 'Check-in opens on the day' : undefined}>Check in</button>
            <button className="secondary" onClick={() => setMoving(!moving)}>Move</button>
            {canExtend && <button className="secondary" onClick={() => run(() => api.post(`${base}/extend`, { slots: 1 }))}>+1 slot</button>}
            <button className="secondary" onClick={() => run(() => api.post(`${base}/no-show`, { keepDeposit: keep }))}>No-show</button>
            <input placeholder="Reason for cancelling" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="secondary" disabled={!reason.trim()} onClick={() => run(() => api.post(`${base}/cancel`, { reason, keepDeposit: keep }))}>Cancel booking</button>
          </div>
        )}
        {canWrite && a.status === 'booked' && credit > 0 && (
          <label className="inline"><input type="checkbox" checked={keepDeposit} onChange={(e) => setKeepDeposit(e.target.checked)} />
            If cancelled or a no-show, keep the {formatMoney(credit)} paid as a fee (untick to refund it first)</label>
        )}
        {canWrite && a.status === 'checked_in' && (
          <div className="row wrap">
            <button className="primary" onClick={() => run(() => api.post(`${base}/complete`))}>Complete</button>
            {canExtend && <button className="secondary" onClick={() => run(() => api.post(`${base}/extend`, { slots: 1 }))}>+1 slot ({formatDuration(a.duration_min)})</button>}
          </div>
        )}
      </section>
      {a.bill && <AppointmentBill unitId={unitId} appt={a} onChanged={appt.reload} />}
      {moving && a.status === 'booked' && (
        <MovePanel appt={a} unitId={unitId} tz={tz} service={service}
          onMove={async (startsAt, slots, preferred) => { if (await run(() => api.post(`${base}/reschedule`, { startsAt, slots, preferred }))) setMoving(false); }} />
      )}
    </>
  );
}

function MovePanel({ appt, unitId, tz, onMove }) {
  const [date, setDate] = useState(localDate(appt.starts_at, tz));
  const [chosen, setChosen] = useState(null);
  // Guests usually want the same therapist: keep the staff on the booking unless unticked.
  const staff = (appt.resources ?? []).filter((r) => r.kind === 'staff');
  const [keep, setKeep] = useState(() => Object.fromEntries(staff.map((r) => [r.role, r.resourceId])));
  const toggle = (r) => {
    const next = { ...keep };
    if (next[r.role]) delete next[r.role]; else next[r.role] = r.resourceId;
    setKeep(next);
    setChosen(null);
  };
  return (
    <section className="card">
      <h2>Move to</h2>
      <div className="row wrap">
        <label>Day<input type="date" value={date} min={todayIn(tz)} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setChosen(null); } }} /></label>
        {staff.map((r) => (
          <label key={r.resourceId} className="inline"><input type="checkbox" checked={Boolean(keep[r.role])} onChange={() => toggle(r)} />Keep {r.name}</label>
        ))}
      </div>
      <TimeChooser unitId={unitId} service={{ id: appt.service_id }} date={date} slots={appt.slots} preferred={keep} tz={tz}
        except={appt.id} value={chosen} onChange={setChosen} />
      <button className="primary" disabled={!chosen} onClick={() => onMove(chosen.starts_at, appt.slots, keep)}>
        {chosen ? `Move to ${localTime(chosen.starts_at, tz)}` : 'Choose a time'}</button>
    </section>
  );
}
