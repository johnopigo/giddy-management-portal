import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader } from '../components/ui.jsx';
import { Tabs, UnitPicker, formatMoney, useSelectedUnit } from '../components/UnitPicker.jsx';
import { GuestPicker } from '../components/GuestPicker.jsx';
import { addDays, formatDuration, hmToMinutes, localTime, longDate, minutesInto, todayIn, zonedIso } from '../lib/time.js';

export const APPT_STATUS = {
  booked: ['Booked', 'neutral'], checked_in: ['Arrived', 'good'], completed: ['Completed', 'accent'],
  cancelled: ['Cancelled', 'bad'], no_show: ['No-show', 'bad'],
};
export const DEFAULT_TZ = 'Africa/Lagos';
const KIND_LABELS = { staff: 'Staff', room: 'Room', booth: 'Booth', equipment: 'Equipment' };
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SOURCES = [['direct', 'In person / direct'], ['phone', 'Phone'], ['walk_in', 'Walk-in']];
export const BOOKING_UNIT_TYPES = ['spa', 'content_studio'];

/** Appointment length in words: "60 min" or "2 × 1 h". */
export function lengthLabel(service, slots = service.min_slots) {
  return service.mode === 'slot' ? `${slots} × ${formatDuration(service.duration_min)}` : formatDuration(service.duration_min);
}

export function withWhom(resources) {
  return (resources ?? []).map((r) => r.name).join(' · ');
}

export function AppointmentsPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => BOOKING_UNIT_TYPES.includes(s.unit_type) && s.access.OPS);
  const [unitId, setUnitId] = useSelectedUnit(units, 'appointments.unit');
  const [tab, setTab] = useState('day');
  const setup = useLoad(() => (unitId ? api.get(`/api/bookings/${unitId}/setup`) : Promise.resolve(null)), [unitId]);
  if (units.length === 0) return <><PageHeader title="Appointments" /><div className="card muted">You do not work in the Spa or the Studio.</div></>;
  const canBook = unitAccess(me, unitId, 'OPS') === 'write';
  const canConfigure = unitAccess(me, unitId, 'CFG') === 'write';
  const unitType = units.find((u) => u.business_unit_id === unitId)?.unit_type;
  const tabs = [['day', 'Schedule'], ...(canBook ? [['book', 'New booking']] : []), ['list', 'Bookings'],
    ...(canConfigure ? [['setup', 'Services & resources']] : [])];
  const active = tabs.some(([k]) => k === tab) ? tab : 'day';
  return (
    <>
      <PageHeader title="Appointments" subtitle={unitType === 'spa' ? 'Treatments, therapists and rooms.' : 'Booth and studio hire.'}
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      <Tabs value={active} onChange={setTab} tabs={tabs} />
      <ErrorNote error={setup.error} />
      {unitId && setup.data && active === 'day' && <Schedule unitId={unitId} canWrite={canBook} />}
      {unitId && setup.data && active === 'book' && <NewAppointment unitId={unitId} setup={setup.data} />}
      {unitId && setup.data && active === 'list' && <Bookings unitId={unitId} tz={setup.data.timeZone} />}
      {unitId && setup.data && active === 'setup' && <Setup unitId={unitId} setup={setup.data} unitType={unitType} onChange={setup.reload} />}
    </>
  );
}

// ---------------------------------------------------------------- schedule
function Schedule({ unitId, canWrite }) {
  const [date, setDate] = useState(() => todayIn(DEFAULT_TZ));
  const day = useLoad(() => api.get(`/api/bookings/${unitId}/day?date=${date}`), [unitId, date]);
  const [error, setError] = useState(null);
  const tz = day.data?.timeZone ?? DEFAULT_TZ;
  const run = async (fn) => { setError(null); try { await fn(); day.reload(); } catch (err) { setError(err); } };

  const d = day.data;
  let from = 8 * 60;
  let to = 20 * 60;
  if (d) {
    const opens = d.resources.flatMap((r) => r.hours.map((h) => hmToMinutes(h.opens)));
    const closes = d.resources.flatMap((r) => r.hours.map((h) => hmToMinutes(h.closes)));
    const starts = d.appointments.map((a) => minutesInto(date, a.starts_at, tz));
    const ends = d.appointments.map((a) => minutesInto(date, a.ends_at, tz));
    if (opens.length || starts.length) from = Math.max(0, Math.floor(Math.min(...opens, ...starts) / 60) * 60);
    if (closes.length || ends.length) to = Math.min(1440, Math.ceil(Math.max(...closes, ...ends) / 60) * 60);
    if (to <= from) to = Math.min(1440, from + 60);
  }
  const pct = (m) => `${((Math.min(Math.max(m, from), to) - from) / (to - from)) * 100}%`;
  const width = (a, b) => `${((Math.min(b, to) - Math.max(a, from)) / (to - from)) * 100}%`;
  const hours = [];
  for (let m = from; m < to; m += 60) hours.push(m);

  return (
    <>
      <section className="card">
        <div className="row wrap spread">
          <div className="row wrap">
            <button className="secondary small-btn" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">‹</button>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
            <button className="secondary small-btn" onClick={() => setDate(addDays(date, 1))} aria-label="Next day">›</button>
            <button className="link" onClick={() => setDate(todayIn(tz))}>Today</button>
          </div>
          <strong>{longDate(date)}</strong>
        </div>
        <ErrorNote error={day.error ?? error} />
        {d && d.resources.length === 0 && <p className="muted">No resources yet. A manager adds them under Services &amp; resources.</p>}
        {d && d.resources.length > 0 && (
          <div className="timeline-wrap">
            <div className="timeline" style={{ minWidth: `${140 + hours.length * 64}px` }}>
              <div className="tl-row tl-head">
                <div className="tl-label" />
                <div className="tl-track">
                  {hours.map((m) => <span key={m} className="tl-tick" style={{ left: pct(m) }}>{String(m / 60).padStart(2, '0')}:00</span>)}
                </div>
              </div>
              {d.resources.map((r) => (
                <div key={r.id} className="tl-row">
                  <div className="tl-label"><strong>{r.name}</strong>{r.is_me && <span className="muted small"> (you)</span>}
                    <div className="muted small">{KIND_LABELS[r.kind]}</div></div>
                  <div className="tl-track tl-closed">
                    {r.hours.map((h) => (
                      <span key={h.opens} className="tl-open" style={{ left: pct(hmToMinutes(h.opens)), width: width(hmToMinutes(h.opens), hmToMinutes(h.closes)) }} />
                    ))}
                    {r.blocks.map((b) => {
                      const a = minutesInto(date, b.from, tz);
                      const z = minutesInto(date, b.to, tz);
                      return (
                        <span key={b.id} className="tl-block" style={{ left: pct(a), width: width(a, z) }} title={`${b.reason} ${localTime(b.from, tz)}–${localTime(b.to, tz)}`}>
                          <span className="tl-text">{b.reason}</span>
                          {canWrite && <button className="tl-x" aria-label={`Remove block ${b.reason}`} onClick={() => run(() => api.delete(`/api/bookings/${unitId}/blocks/${b.id}`))}>×</button>}
                        </span>
                      );
                    })}
                    {d.appointments.filter((x) => x.resources?.some((rr) => rr.resourceId === r.id)).map((x) => {
                      const a = minutesInto(date, x.starts_at, tz);
                      const z = minutesInto(date, x.ends_at, tz);
                      return (
                        <Link key={x.id} to={`/appointments/${unitId}/${x.id}`} className={`tl-appt tl-${x.status}`}
                          style={{ left: pct(a), width: width(a, z) }} title={`${localTime(x.starts_at, tz)}–${localTime(x.ends_at, tz)} ${x.guest_name} · ${x.service_name}`}>
                          <span className="tl-text"><strong>{x.guest_name}</strong></span>
                          <span className="tl-text small">{x.service_name}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      {d && (
        <section className="card">
          <h2>{d.appointments.length} booking{d.appointments.length === 1 ? '' : 's'}</h2>
          <ApptTable unitId={unitId} rows={d.appointments} tz={tz} empty="Nothing booked this day." timeOnly />
        </section>
      )}
      {d && canWrite && d.resources.length > 0 && <BlockForm unitId={unitId} date={date} tz={tz} resources={d.resources} onDone={day.reload} />}
    </>
  );
}

function BlockForm({ unitId, date, tz, resources, onDone }) {
  const [f, setF] = useState({ resourceId: '', from: '12:00', to: '13:00', reason: '' });
  const [error, setError] = useState(null);
  const submit = async () => {
    setError(null);
    try {
      await api.post(`/api/bookings/${unitId}/resources/${f.resourceId}/blocks`, {
        from: zonedIso(date, f.from, tz), to: zonedIso(date, f.to, tz), reason: f.reason,
      });
      setF({ ...f, reason: '' });
      onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card">
      <h2>Block time</h2>
      <p className="muted small">Breaks, leave, cleaning or maintenance on {longDate(date)}. Bookings in that time must be moved first.</p>
      <div className="row wrap">
        <select value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value })} aria-label="Resource to block">
          <option value="">Who / what…</option>
          {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <input type="time" step="300" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="Block from" />
        <input type="time" step="300" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="Block to" />
        <input placeholder="Reason (e.g. lunch, leave)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <button className="secondary small-btn" disabled={!f.resourceId || f.reason.trim().length < 2} onClick={submit}>Block</button>
      </div>
      <ErrorNote error={error} />
    </section>
  );
}

export function ApptTable({ unitId, rows, tz, empty, timeOnly = false }) {
  if (!rows?.length) return <p className="muted">{empty}</p>;
  const money = rows.some((x) => x.balance != null);
  const when = (x) => (timeOnly ? `${localTime(x.starts_at, tz)}–${localTime(x.ends_at, tz)}`
    : `${new Date(x.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })} ${localTime(x.starts_at, tz)}–${localTime(x.ends_at, tz)}`);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Guest</th><th>Service</th><th>With</th><th>Status</th>{money && <th className="num">Bill</th>}</tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.id}>
              <td className="small">{when(x)}</td>
              <td><Link to={`/appointments/${unitId}/${x.id}`}><strong>{x.guest_name}</strong></Link><div className="muted small">{x.booking_ref}</div></td>
              <td className="small">{x.service_name}{x.mode === 'slot' && x.slots > 1 ? ` (${x.slots} slots)` : ''}</td>
              <td className="small">{withWhom(x.resources)}</td>
              <td><Badge tone={APPT_STATUS[x.status][1]}>{APPT_STATUS[x.status][0]}</Badge></td>
              {money && <td className="num small"><MoneyNote x={x} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoneyNote({ x }) {
  const balance = Number(x.balance);
  const depositLeft = Number(x.deposit_due) - Number(x.paid);
  if (x.status === 'booked' && depositLeft > 0) return <Badge tone="warn">Deposit {formatMoney(depositLeft)}</Badge>;
  if (balance > 0) return <Badge tone="bad">Owes {formatMoney(balance)}</Badge>;
  if (balance < 0) return <span>{formatMoney(-balance)} paid</span>;
  return x.bill_status === 'closed' ? <span className="muted">Settled</span> : <span className="muted">—</span>;
}

// ---------------------------------------------------------------- new booking
export function roleChoices(service, resources) {
  const byId = Object.fromEntries(resources.map((r) => [r.id, r]));
  const roles = {};
  for (const sr of service.resources) {
    const r = byId[sr.resourceId];
    if (r?.is_active) (roles[sr.role] ??= []).push(r);
  }
  return roles;
}

/** Free start times for a service as buttons. */
export function TimeChooser({ unitId, service, date, slots, preferred, tz, value, onChange, except }) {
  const avail = useLoad(() => api.get(`/api/bookings/${unitId}/availability?serviceId=${service.id}&date=${date}&slots=${slots}`
    + `&preferred=${encodeURIComponent(JSON.stringify(preferred))}${except ? `&except=${except}` : ''}`),
  [unitId, service.id, date, slots, JSON.stringify(preferred), except]);
  return (
    <>
      <ErrorNote error={avail.error} />
      {avail.data?.length === 0 && <p className="muted">Nothing free on {longDate(date)}. Try another day{Object.keys(preferred).length ? ' or anyone available' : ''}.</p>}
      <div className="slot-grid">
        {avail.data?.map((o) => (
          <button key={o.starts_at} className={`slot-chip ${value?.starts_at === o.starts_at ? 'active' : ''}`} onClick={() => onChange(o)}>
            {localTime(o.starts_at, tz)}
          </button>
        ))}
      </div>
    </>
  );
}

function NewAppointment({ unitId, setup }) {
  const navigate = useNavigate();
  const tz = setup.timeZone ?? DEFAULT_TZ;
  const services = setup.services.filter((s) => s.is_active && s.resources.length > 0);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [date, setDate] = useState(todayIn(tz));
  const [slots, setSlots] = useState(1);
  const [preferred, setPreferred] = useState({});
  const [chosen, setChosen] = useState(null);
  const [picks, setPicks] = useState({});
  const [guest, setGuest] = useState(null);
  const [source, setSource] = useState('direct');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);
  const service = services.find((s) => s.id === serviceId);
  if (!service) return <div className="card muted">No services are set up yet.</div>;
  const roles = roleChoices(service, setup.resources);
  const n = service.mode === 'slot' ? Math.min(Math.max(slots, service.min_slots), service.max_slots) : 1;
  const reset = () => { setChosen(null); setPicks({}); };

  const submit = async () => {
    setError(null);
    try {
      const want = { ...preferred, ...Object.fromEntries(Object.entries(picks).filter(([, v]) => v)) };
      const { id } = await api.post(`/api/bookings/${unitId}/appointments`, {
        serviceId, customerId: guest.id, startsAt: chosen.starts_at, slots: n, source, notes: notes || null, preferred: want,
      });
      navigate(`/appointments/${unitId}/${id}`);
    } catch (err) {
      setError(err);
      reset();
    }
  };

  return (
    <>
      <section className="card form-grid">
        <label>Service
          <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setPreferred({}); setSlots(1); reset(); }}>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {lengthLabel(s)} · {formatMoney(s.price)}{s.mode === 'slot' ? ' per slot' : ''}</option>)}
          </select>
        </label>
        <label>Day<input type="date" value={date} min={todayIn(tz)} onChange={(e) => { if (e.target.value) { setDate(e.target.value); reset(); } }} /></label>
        {service.mode === 'slot' && (
          <label>Length
            <select value={n} onChange={(e) => { setSlots(Number(e.target.value)); reset(); }}>
              {Array.from({ length: service.max_slots - service.min_slots + 1 }, (_, i) => service.min_slots + i)
                .map((k) => <option key={k} value={k}>{lengthLabel(service, k)} ({formatDuration(k * service.duration_min)})</option>)}
            </select>
          </label>
        )}
        {Object.entries(roles).map(([role, list]) => (
          <label key={role}>{role[0].toUpperCase() + role.slice(1)}
            <select value={preferred[role] ?? ''} onChange={(e) => { setPreferred({ ...Object.fromEntries(Object.entries(preferred).filter(([k]) => k !== role)), ...(e.target.value ? { [role]: e.target.value } : {}) }); reset(); }}>
              <option value="">Any {role}</option>
              {list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        ))}
      </section>
      <section className="card">
        <h2>Free times · {longDate(date)}</h2>
        <TimeChooser unitId={unitId} service={service} date={date} slots={n} preferred={preferred} tz={tz} value={chosen}
          onChange={(o) => { setChosen(o); setPicks({}); }} />
      </section>
      <section className="card">
        <h2>Booking</h2>
        {!chosen ? <p className="muted small">Choose a time above.</p> : (
          <>
            <p><strong>{service.name}</strong> · {longDate(date)} · {localTime(chosen.starts_at, tz)}–{localTime(chosen.ends_at, tz)}
              {' · '}<strong>{formatMoney(Number(service.price) * n)}</strong>
              {Number(service.deposit_pct) > 0 && <span className="muted"> · deposit {formatMoney(Math.round(Number(service.price) * n * Number(service.deposit_pct)) / 100)} to secure it</span>}</p>
            <div className="row wrap">
              {Object.entries(chosen.options).map(([role, free]) => (
                <label key={role}>{role[0].toUpperCase() + role.slice(1)}
                  <select value={picks[role] ?? ''} onChange={(e) => setPicks({ ...picks, [role]: e.target.value })}>
                    {!preferred[role] && <option value="">Any free {role} ({free.length})</option>}
                    {free.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </>
        )}
        <h3>Guest</h3>
        <GuestPicker guest={guest} onChange={setGuest} />
        <div className="row wrap">
          <label>Booked via
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="grow">Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferences, occasion, equipment needed…" /></label>
        </div>
        <ErrorNote error={error} />
        <button className="primary" disabled={!guest || !chosen} onClick={submit}>Confirm booking</button>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- list
function Bookings({ unitId, tz }) {
  const [from, setFrom] = useState(todayIn(tz ?? DEFAULT_TZ));
  const [to, setTo] = useState(addDays(todayIn(tz ?? DEFAULT_TZ), 7));
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [money, setMoney] = useState('');
  const { me } = useSession();
  const seesMoney = Boolean(unitAccess(me, unitId, 'FIN'));
  const rows = useLoad(() => api.get(`/api/bookings/${unitId}/appointments?${money ? '' : `from=${from}&to=${to}&`}${status ? `status=${status}&` : ''}${money ? `money=${money}&` : ''}${q.trim() ? `q=${encodeURIComponent(q.trim())}` : ''}`),
    [unitId, from, to, status, q, money]);
  return (
    <section className="card">
      <div className="row wrap">
        <label>From<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(APPT_STATUS).map(([k, [label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        {seesMoney && (
          <label>Money
            <select value={money} onChange={(e) => setMoney(e.target.value)}>
              <option value="">Any</option><option value="deposit">Awaiting deposit</option><option value="owing">Owing (any date)</option>
            </select>
          </label>
        )}
        <label className="grow">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Guest, phone or booking ref" /></label>
      </div>
      <ErrorNote error={rows.error} />
      <ApptTable unitId={unitId} rows={rows.data} tz={tz ?? DEFAULT_TZ} empty="No bookings match." />
    </section>
  );
}

// ---------------------------------------------------------------- setup
export function summarizeHours(hours) {
  if (!hours.length) return 'No hours set';
  const byDay = Array.from({ length: 7 }, (_, i) => hours.filter((h) => h.weekday === i + 1).map((h) => `${h.opens}–${h.closes}`).join(', '));
  const out = [];
  for (let i = 0; i < 7;) {
    let j = i;
    while (j + 1 < 7 && byDay[j + 1] === byDay[i]) j++;
    if (byDay[i]) out.push(`${DAY_NAMES[i]}${j > i ? `–${DAY_NAMES[j]}` : ''} ${byDay[i]}`);
    i = j + 1;
  }
  return out.join('; ');
}

export const hoursDraft = (hours) => ({
  days: hours.length ? [...new Set(hours.map((h) => h.weekday))] : [1, 2, 3, 4, 5, 6, 7],
  opens: hours[0]?.opens ?? '09:00', closes: hours[0]?.closes ?? '18:00',
});
export const draftHours = (d) => [...d.days].sort().map((weekday) => ({ weekday, opens: d.opens, closes: d.closes }));

/** The same hours on each chosen day (the API also takes split shifts). */
function HoursEditor({ value, onChange }) {
  const toggle = (d) => onChange({ ...value, days: value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d] });
  return (
    <div className="row wrap">
      <div className="checks day-checks">
        {DAY_NAMES.map((n, i) => (
          <label key={n} className="inline"><input type="checkbox" checked={value.days.includes(i + 1)} onChange={() => toggle(i + 1)} />{n}</label>
        ))}
      </div>
      <input type="time" step="300" value={value.opens} onChange={(e) => onChange({ ...value, opens: e.target.value })} aria-label="Opens" />
      <span>to</span>
      <input type="time" step="300" value={value.closes} onChange={(e) => onChange({ ...value, closes: e.target.value })} aria-label="Closes" />
    </div>
  );
}

function HoursRowEditor({ hours, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => hoursDraft(hours));
  return (
    <>
      <HoursEditor value={draft} onChange={setDraft} />
      <div className="row">
        <button className="secondary small-btn" onClick={() => onSave(draftHours(draft))}>Save hours</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

function Setup({ unitId, setup, unitType, onChange }) {
  const people = useLoad(() => api.get(`/api/bookings/${unitId}/people`), [unitId]);
  const [error, setError] = useState(null);
  const [editingHours, setEditingHours] = useState(null);
  const [editingService, setEditingService] = useState(null);
  const [res, setRes] = useState({ kind: unitType === 'spa' ? 'staff' : 'booth', name: '', userId: '' });
  const [resHours, setResHours] = useState(() => hoursDraft([]));
  const run = async (fn) => { setError(null); try { await fn(); onChange(); return true; } catch (err) { setError(err); return false; } };
  const linked = new Set(setup.resources.map((r) => r.user_id).filter(Boolean));

  return (
    <>
      <ErrorNote error={error} />
      <section className="card">
        <h2>Resources</h2>
        <p className="muted small">Who and what gets booked: therapists, treatment rooms, booths, cameras. Each has its own weekly hours.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Login</th><th>Hours</th><th /></tr></thead>
            <tbody>
              {setup.resources.map((r) => (
                <tr key={r.id} className={r.is_active ? '' : 'dim'}>
                  <td><strong>{r.name}</strong></td>
                  <td className="small">{KIND_LABELS[r.kind]}</td>
                  <td className="small">{r.user_name ?? '—'}</td>
                  <td className="small">
                    {editingHours === r.id
                      ? <HoursRowEditor hours={r.hours} onCancel={() => setEditingHours(null)}
                          onSave={async (hours) => { if (await run(() => api.put(`/api/bookings/${unitId}/resources/${r.id}/hours`, { hours }))) setEditingHours(null); }} />
                      : summarizeHours(r.hours)}
                  </td>
                  <td className="actions-cell">
                    {editingHours !== r.id && <button className="link" onClick={() => setEditingHours(r.id)}>Hours</button>}
                    <button className="link" onClick={() => run(() => api.patch(`/api/bookings/${unitId}/resources/${r.id}`, { isActive: !r.is_active }))}>
                      {r.is_active ? 'Retire' : 'Restore'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Add a resource</h3>
        <div className="row wrap">
          <select value={res.kind} onChange={(e) => setRes({ ...res, kind: e.target.value, userId: '' })} aria-label="Kind">
            {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input placeholder="Name (e.g. Ada, Room 1, Booth A)" value={res.name} onChange={(e) => setRes({ ...res, name: e.target.value })} />
          {res.kind === 'staff' && (
            <select value={res.userId} onChange={(e) => setRes({ ...res, userId: e.target.value })} aria-label="Their login">
              <option value="">No login (schedule only)</option>
              {people.data?.filter((p) => !linked.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.full_name} · {p.email}</option>)}
            </select>
          )}
        </div>
        <HoursEditor value={resHours} onChange={setResHours} />
        <button className="secondary" disabled={res.name.trim().length < 2} onClick={() => run(async () => {
          await api.post(`/api/bookings/${unitId}/resources`, { kind: res.kind, name: res.name, userId: res.userId || null, hours: draftHours(resHours) });
          setRes({ ...res, name: '', userId: '' });
        })}>Add resource</button>
      </section>
      <section className="card">
        <h2>Services</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Service</th><th>Booked as</th><th className="num">Price</th><th>Delivered by</th><th /></tr></thead>
            <tbody>
              {setup.services.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'dim'}>
                  <td><strong>{s.name}</strong> <span className="muted small">{s.code}</span>
                    {s.online_bookable && <div><Badge tone="accent">Online</Badge></div>}</td>
                  <td className="small">{s.mode === 'slot'
                    ? `${formatDuration(s.duration_min)} slots, ${s.min_slots}–${s.max_slots}`
                    : formatDuration(s.duration_min)}{s.buffer_min ? ` + ${s.buffer_min} min turnaround` : ''}</td>
                  <td className="num">{formatMoney(s.price)}{s.mode === 'slot' ? <div className="muted small">per slot</div> : null}
                    {Number(s.deposit_pct) > 0 && <div className="muted small">{Number(s.deposit_pct)}% deposit</div>}</td>
                  <td className="small">{Object.entries(roleChoices(s, setup.resources)).map(([role, list]) => `${role}: ${list.map((r) => r.name).join(', ')}`).join(' · ') || <span className="muted">Nobody yet</span>}</td>
                  <td><button className="link" onClick={() => setEditingService(s)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {setup.services.length === 0 && <p className="muted">No services yet.</p>}
      </section>
      <ServiceForm key={editingService?.id ?? 'new'} unitId={unitId} unitType={unitType} resources={setup.resources.filter((r) => r.is_active)}
        service={editingService} onCancel={() => setEditingService(null)}
        onSaved={() => { setEditingService(null); onChange(); }} />
    </>
  );
}

const defaultRole = (kind, unitType) => ({ staff: unitType === 'spa' ? 'therapist' : 'host', room: 'room', booth: 'booth', equipment: 'equipment' })[kind];

function ServiceForm({ unitId, unitType, resources, service, onCancel, onSaved }) {
  const editing = Boolean(service);
  const [f, setF] = useState(() => ({
    code: service?.code ?? '', name: service?.name ?? '', description: service?.description ?? '',
    mode: service?.mode ?? (unitType === 'content_studio' ? 'slot' : 'service'),
    durationMin: service?.duration_min ?? (unitType === 'content_studio' ? 60 : 60), bufferMin: service?.buffer_min ?? 0,
    minSlots: service?.min_slots ?? 1, maxSlots: service?.max_slots ?? (unitType === 'content_studio' ? 4 : 1),
    price: service?.price ?? '', depositPct: Number(service?.deposit_pct ?? 0), onlineBookable: service?.online_bookable ?? false, isActive: service?.is_active ?? true,
  }));
  const [chosen, setChosen] = useState(() => Object.fromEntries((service?.resources ?? []).map((r) => [r.resourceId, r.role])));
  const [error, setError] = useState(null);
  const set = (k, num) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : num ? Number(e.target.value) : e.target.value });
  const toggle = (r) => {
    const next = { ...chosen };
    if (r.id in next) delete next[r.id]; else next[r.id] = defaultRole(r.kind, unitType);
    setChosen(next);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const body = {
      name: f.name, description: f.description, durationMin: f.durationMin, bufferMin: f.bufferMin,
      minSlots: f.mode === 'slot' ? f.minSlots : 1, maxSlots: f.mode === 'slot' ? f.maxSlots : 1,
      price: Number(f.price), depositPct: Number(f.depositPct), onlineBookable: f.onlineBookable, isActive: f.isActive,
      resources: Object.entries(chosen).map(([resourceId, role]) => ({ resourceId, role })),
    };
    try {
      if (editing) await api.patch(`/api/bookings/${unitId}/services/${service.id}`, body);
      else await api.post(`/api/bookings/${unitId}/services`, { ...body, code: f.code, mode: f.mode });
      onSaved();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="card form-grid" onSubmit={submit}>
      <h2 className="full">{editing ? `Edit ${service.name}` : 'New service'}</h2>
      {!editing && <label>Code<input value={f.code} onChange={set('code')} placeholder="e.g. SWE" required /></label>}
      <label>Name<input value={f.name} onChange={set('name')} placeholder={unitType === 'spa' ? 'Swedish massage' : 'Podcast booth hire'} required /></label>
      {!editing && (
        <label>Booked as
          <select value={f.mode} onChange={set('mode')}>
            <option value="service">A treatment of fixed length</option>
            <option value="slot">Hire by the slot (hour, half-hour…)</option>
          </select>
        </label>
      )}
      <label>{f.mode === 'slot' ? 'Slot length (minutes)' : 'Length (minutes)'}<input type="number" min="5" step="5" value={f.durationMin} onChange={set('durationMin', true)} /></label>
      <label>Turnaround after (minutes)<input type="number" min="0" step="5" value={f.bufferMin} onChange={set('bufferMin', true)} /></label>
      {f.mode === 'slot' && <label>Fewest slots<input type="number" min="1" value={f.minSlots} onChange={set('minSlots', true)} /></label>}
      {f.mode === 'slot' && <label>Most slots<input type="number" min="1" value={f.maxSlots} onChange={set('maxSlots', true)} /></label>}
      <label>{f.mode === 'slot' ? 'Price per slot' : 'Price'}<input type="number" min="0" value={f.price} onChange={set('price')} required /></label>
      <label>Deposit to book (%)<input type="number" min="0" max="100" value={f.depositPct} onChange={set('depositPct', true)} /></label>
      <label className="full">Description<input value={f.description} onChange={set('description')} /></label>
      <div className="full">
        <strong>Delivered by</strong>
        <p className="muted small">Tick who or what can deliver it. A booking takes one of each role (e.g. one therapist and one room).</p>
        {resources.length === 0 && <p className="muted small">Add resources first.</p>}
        {resources.map((r) => (
          <div key={r.id} className="row">
            <label className="inline"><input type="checkbox" checked={r.id in chosen} onChange={() => toggle(r)} />{r.name} <span className="muted small">{KIND_LABELS[r.kind]}</span></label>
            {r.id in chosen && <input aria-label={`Role of ${r.name}`} value={chosen[r.id]} onChange={(e) => setChosen({ ...chosen, [r.id]: e.target.value })} />}
          </div>
        ))}
      </div>
      <label className="inline full"><input type="checkbox" checked={f.onlineBookable} onChange={set('onlineBookable')} />Bookable online (when the portal opens)</label>
      {editing && <label className="inline full"><input type="checkbox" checked={f.isActive} onChange={set('isActive')} />Offered</label>}
      <div className="full row">
        <ErrorNote error={error} />
        <button className="primary">{editing ? 'Save service' : 'Add service'}</button>
        {editing && <button type="button" className="link" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
