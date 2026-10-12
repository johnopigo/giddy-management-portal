import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader } from '../components/ui.jsx';
import { Tabs, UnitPicker, formatMoney, useSelectedUnit } from '../components/UnitPicker.jsx';

export const ROOM_STATUS = {
  available: ['Available', 'good'], occupied: ['Occupied', 'accent'], cleaning: ['Cleaning', 'warn'],
  maintenance: ['Maintenance', 'bad'], out_of_order: ['Out of order', 'bad'],
};
export const RES_STATUS = {
  confirmed: ['Confirmed', 'neutral'], checked_in: ['In house', 'good'], checked_out: ['Checked out', 'neutral'],
  cancelled: ['Cancelled', 'bad'], no_show: ['No-show', 'bad'],
};
const lagosToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function FrontDeskPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.unit_type === 'apartments' && s.access.OPS);
  const [unitId, setUnitId] = useSelectedUnit(units, 'frontdesk.unit');
  const [tab, setTab] = useState('today');
  if (units.length === 0) return <><PageHeader title="Front desk" /><div className="card muted">You do not work in the apartments.</div></>;
  const canConfigure = unitAccess(me, unitId, 'CFG') === 'write';
  return (
    <>
      <PageHeader title="Front desk" subtitle="Arrivals, departures, rooms and guest bills."
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      <Tabs value={tab} onChange={setTab} tabs={[['today', 'Today'], ['board', 'Room board'], ['reservations', 'Reservations'],
        ['book', 'New booking'], ['housekeeping', 'Housekeeping'], ...(canConfigure ? [['setup', 'Rooms & rates']] : [])]} />
      {unitId && tab === 'today' && <Today unitId={unitId} />}
      {unitId && tab === 'board' && <Board unitId={unitId} />}
      {unitId && tab === 'reservations' && <Reservations unitId={unitId} />}
      {unitId && tab === 'book' && <NewBooking unitId={unitId} />}
      {unitId && tab === 'housekeeping' && <Housekeeping unitId={unitId} />}
      {unitId && tab === 'setup' && canConfigure && <Setup unitId={unitId} />}
    </>
  );
}

function ResTable({ unitId, rows, empty }) {
  if (!rows?.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Guest</th><th>Rooms</th><th>Stay</th><th>Status</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/front-desk/${unitId}/reservations/${r.id}`}><strong>{r.guest_name}</strong></Link><div className="muted small">{r.booking_ref}</div></td>
              <td>{r.rooms}</td>
              <td className="small">{shortDate(r.check_in)} → {shortDate(r.check_out)} · {r.nights} night{r.nights === 1 ? '' : 's'}</td>
              <td><Badge tone={RES_STATUS[r.status][1]}>{RES_STATUS[r.status][0]}</Badge></td>
              <td className="num">{r.balance == null ? '—' : formatMoney(r.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Today({ unitId }) {
  const { me } = useSession();
  const data = useLoad(() => api.get(`/api/apartments/${unitId}/today`), [unitId]);
  const [audit, setAudit] = useState(null);
  const runAudit = async () => {
    try {
      const r = await api.post(`/api/apartments/${unitId}/night-audit`);
      setAudit(`${r.nightsCharged} room night${r.nightsCharged === 1 ? '' : 's'} charged to guest bills.`);
      data.reload();
    } catch (err) {
      setAudit(err.message);
    }
  };
  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <p className="muted">Loading…</p>;
  const d = data.data;
  const count = (s) => d.rooms.find((r) => r.status === s)?.n ?? 0;
  return (
    <>
      <div className="stat-row">
        <div className="stat"><span className="muted small">Arrivals</span><strong>{d.arrivals.length}</strong></div>
        <div className="stat"><span className="muted small">Departures</span><strong>{d.departures.length}</strong></div>
        <div className="stat"><span className="muted small">In house</span><strong>{d.inHouse.length}</strong></div>
        <div className="stat"><span className="muted small">Rooms free</span><strong>{count('available')}</strong><span className="muted small">{count('cleaning')} being cleaned</span></div>
      </div>
      <section className="card"><h2>Arriving today</h2><ResTable unitId={unitId} rows={d.arrivals} empty="No arrivals waiting." /></section>
      <section className="card"><h2>Due to leave</h2><ResTable unitId={unitId} rows={d.departures} empty="No departures due." /></section>
      <section className="card"><h2>In house</h2><ResTable unitId={unitId} rows={d.inHouse} empty="Nobody is checked in." /></section>
      {unitAccess(me, unitId, 'FIN') === 'write' && (
        <section className="card row wrap">
          <div className="grow"><strong>Night audit</strong><div className="muted small">Charges tonight's room to every in-house guest's bill. Safe to run more than once.</div></div>
          <button className="secondary" onClick={runAudit}>Post room charges</button>
          {audit && <span className="small">{audit}</span>}
        </section>
      )}
    </>
  );
}

function Board({ unitId }) {
  const { me } = useSession();
  const rooms = useLoad(() => api.get(`/api/apartments/${unitId}/board`), [unitId]);
  const [error, setError] = useState(null);
  const canChange = unitAccess(me, unitId, 'OPS') === 'write';
  const setStatus = async (room, status) => {
    setError(null);
    try {
      await api.post(`/api/apartments/${unitId}/rooms/${room.id}/status`, { status });
      rooms.reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <>
      <ErrorNote error={error ?? rooms.error} />
      <div className="room-grid">
        {rooms.data?.map((r) => (
          <div key={r.id} className={`room-tile room-${r.status}`}>
            <div className="row spread"><strong className="room-no">{r.room_number}</strong><Badge tone={ROOM_STATUS[r.status][1]}>{ROOM_STATUS[r.status][0]}</Badge></div>
            <div className="muted small">{r.room_type_name}</div>
            {r.guest_name
              ? <Link className="small" to={`/front-desk/${unitId}/reservations/${r.reservation_id}`}>{r.guest_name} · until {shortDate(r.check_out)}{r.res_status === 'confirmed' ? ' (arriving)' : ''}</Link>
              : <span className="small muted">{r.status_note || 'No guest tonight'}</span>}
            {canChange && r.status !== 'occupied' && (
              <select aria-label={`Set status of room ${r.room_number}`} value="" onChange={(e) => e.target.value && setStatus(r, e.target.value)}>
                <option value="">Set status…</option>
                {['available', 'cleaning', 'maintenance', 'out_of_order'].filter((s) => s !== r.status).map((s) => <option key={s} value={s}>{ROOM_STATUS[s][0]}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Reservations({ unitId }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('confirmed,checked_in');
  const rows = useLoad(() => api.get(`/api/apartments/${unitId}/reservations?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [unitId, status, q]);
  return (
    <section className="card">
      <div className="row wrap">
        <input className="grow" placeholder="Guest name or booking reference" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="confirmed,checked_in">Upcoming and in house</option>
          <option value="checked_out">Checked out</option>
          <option value="cancelled,no_show">Cancelled and no-shows</option>
          <option value="confirmed,checked_in,checked_out,cancelled,no_show">All</option>
        </select>
      </div>
      <ErrorNote error={rows.error} />
      <ResTable unitId={unitId} rows={rows.data} empty="No reservations." />
    </section>
  );
}

function NewBooking({ unitId }) {
  const navigate = useNavigate();
  const [checkIn, setCheckIn] = useState(lagosToday());
  const [checkOut, setCheckOut] = useState(addDays(lagosToday(), 1));
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [source, setSource] = useState('direct');
  const [notes, setNotes] = useState('');
  const [rooms, setRooms] = useState([]); // [{ roomTypeId, roomId, label, price }]
  const [guest, setGuest] = useState(null);
  const [guestQ, setGuestQ] = useState('');
  const [newGuest, setNewGuest] = useState({ fullName: '', phone: '', email: '' });
  const [error, setError] = useState(null);
  const valid = checkOut > checkIn;
  const avail = useLoad(() => (valid ? api.get(`/api/apartments/${unitId}/availability?checkIn=${checkIn}&checkOut=${checkOut}`) : Promise.resolve([])), [unitId, checkIn, checkOut]);
  const found = useLoad(() => (guestQ.trim().length >= 2 ? api.get(`/api/customers?q=${encodeURIComponent(guestQ.trim())}`) : Promise.resolve([])), [guestQ]);
  const total = rooms.reduce((s, r) => s + Number(r.price), 0);

  const addRoom = (type, room) => setRooms([...rooms, { roomTypeId: type.room_type_id, roomId: room?.id ?? null,
    label: `${type.name}${room ? ` · ${room.room_number}` : ' · any free room'}`, price: type.stay_total }]);
  const createGuest = async () => {
    setError(null);
    try {
      setGuest(await api.post('/api/customers', { fullName: newGuest.fullName, phone: newGuest.phone || null, email: newGuest.email || null }));
    } catch (err) {
      if (err.status === 409 && err.details?.existing) setGuest(err.details.existing);
      else setError(err);
    }
  };
  const submit = async () => {
    setError(null);
    try {
      const { id } = await api.post(`/api/apartments/${unitId}/reservations`, {
        customerId: guest.id, source, checkIn, checkOut, adults: Number(adults), children: Number(children), notes,
        rooms: rooms.map((r) => ({ roomTypeId: r.roomTypeId, roomId: r.roomId })),
      });
      navigate(`/front-desk/${unitId}/reservations/${id}`);
    } catch (err) {
      setError(err);
      avail.reload();
    }
  };
  const taken = new Set(rooms.map((r) => r.roomId).filter(Boolean));

  return (
    <>
      <section className="card form-grid">
        <label>Arrival<input type="date" value={checkIn} min={lagosToday()} onChange={(e) => { setCheckIn(e.target.value); setRooms([]); if (checkOut <= e.target.value) setCheckOut(addDays(e.target.value, 1)); }} /></label>
        <label>Departure<input type="date" value={checkOut} min={addDays(checkIn, 1)} onChange={(e) => { setCheckOut(e.target.value); setRooms([]); }} /></label>
        <label>Adults<input type="number" min="1" value={adults} onChange={(e) => setAdults(e.target.value)} /></label>
        <label>Children<input type="number" min="0" value={children} onChange={(e) => setChildren(e.target.value)} /></label>
        <label>Booked via
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="direct">Direct (phone / email)</option><option value="walk_in">Walk-in</option>
            <option value="corporate">Corporate</option><option value="travel_agent">Travel agent</option><option value="online">Online</option>
          </select>
        </label>
      </section>
      <section className="card">
        <h2>Rooms free {valid ? `${shortDate(checkIn)} → ${shortDate(checkOut)}` : ''}</h2>
        <ErrorNote error={avail.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Room type</th><th>Sleeps</th><th className="num">Stay price</th><th>Free rooms</th></tr></thead>
            <tbody>
              {avail.data?.map((t) => {
                const free = t.free_rooms.filter((r) => !taken.has(r.id));
                return (
                  <tr key={t.room_type_id}>
                    <td><strong>{t.name}</strong>{t.amenities?.length > 0 && <div className="muted small">{t.amenities.join(' · ')}</div>}</td>
                    <td className="small">{t.max_adults} adults{t.max_children ? ` + ${t.max_children} children` : ''}</td>
                    <td className="num">{formatMoney(t.stay_total)}</td>
                    <td>
                      {free.length === 0 ? <span className="muted small">Full</span> : (
                        <div className="row wrap">
                          <button className="secondary small-btn" onClick={() => addRoom(t, null)}>Any ({free.length})</button>
                          {free.map((r) => <button key={r.id} className="link small" onClick={() => addRoom(t, r)}>{r.room_number}</button>)}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Booking</h2>
        {rooms.length === 0 && <p className="muted small">Choose rooms above.</p>}
        <ul className="plain">{rooms.map((r, i) => <li key={i} className="row spread"><span>{r.label}</span><span>{formatMoney(r.price)} <button className="link" onClick={() => setRooms(rooms.filter((_, j) => j !== i))}>×</button></span></li>)}</ul>
        {rooms.length > 0 && <p><strong>Rooms total {formatMoney(total)}</strong> <span className="muted small">before service charge and VAT</span></p>}
        <h3>Guest</h3>
        {guest ? (
          <div className="row"><strong>{guest.full_name}</strong><span className="muted small">{guest.phone ?? guest.email}</span><button className="link" onClick={() => setGuest(null)}>Change</button></div>
        ) : (
          <>
            <input placeholder="Search guests by name or phone" value={guestQ} onChange={(e) => setGuestQ(e.target.value)} />
            <div className="list">
              {found.data?.map((c) => <button key={c.id} className="list-item" onClick={() => setGuest(c)}><strong>{c.full_name}</strong><span className="muted small">{c.phone ?? c.email}</span></button>)}
            </div>
            <div className="row wrap">
              <input placeholder="New guest: full name" value={newGuest.fullName} onChange={(e) => setNewGuest({ ...newGuest, fullName: e.target.value })} />
              <input placeholder="Phone" value={newGuest.phone} onChange={(e) => setNewGuest({ ...newGuest, phone: e.target.value })} />
              <input placeholder="Email" value={newGuest.email} onChange={(e) => setNewGuest({ ...newGuest, email: e.target.value })} />
              <button className="secondary small-btn" onClick={createGuest} disabled={!newGuest.fullName}>Add guest</button>
            </div>
          </>
        )}
        <label>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Late arrival, airport pick-up…" /></label>
        <ErrorNote error={error} />
        <button className="primary" disabled={!guest || rooms.length === 0 || !valid} onClick={submit}>Confirm booking</button>
      </section>
    </>
  );
}

function Housekeeping({ unitId }) {
  const { me } = useSession();
  const tasks = useLoad(() => api.get(`/api/apartments/${unitId}/housekeeping`), [unitId]);
  const users = useLoad(() => api.get('/api/users').catch(() => []));
  const [error, setError] = useState(null);
  const isDesk = unitAccess(me, unitId, 'OPS') === 'write';
  const update = async (t, body) => {
    setError(null);
    try {
      await api.post(`/api/apartments/${unitId}/housekeeping/${t.id}`, body);
      tasks.reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card">
      <ErrorNote error={error ?? tasks.error} />
      {tasks.data?.length === 0 && <p className="muted">No housekeeping tasks.</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Room</th><th>Task</th><th>Assigned to</th><th>Status</th><th /></tr></thead>
          <tbody>
            {tasks.data?.map((t) => (
              <tr key={t.id} className={t.status === 'done' ? 'dim' : ''}>
                <td><strong>{t.room_number}</strong></td>
                <td>{t.task_type}<div className="muted small">{t.notes}</div></td>
                <td>
                  {isDesk && t.status !== 'done' ? (
                    <select value={t.assigned_to ?? ''} onChange={(e) => update(t, { assignedTo: e.target.value || null })}>
                      <option value="">Unassigned</option>
                      {(users.data ?? []).filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                    </select>
                  ) : (t.assigned_to_name ?? <span className="muted">—</span>)}
                </td>
                <td>{t.status === 'done' ? `Done by ${t.done_by_name}` : t.status.replace('_', ' ')}</td>
                <td className="actions-cell">
                  {t.status !== 'done' && (isDesk || t.is_mine) && <>
                    {t.status === 'open' && <button className="link" onClick={() => update(t, { status: 'in_progress' })}>Start</button>}
                    <button className="primary small-btn" onClick={() => update(t, { status: 'done' })}>Done</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Setup({ unitId }) {
  const setup = useLoad(() => api.get(`/api/apartments/${unitId}/setup`), [unitId]);
  const org = useLoad(() => api.get('/api/org'));
  const [error, setError] = useState(null);
  const [type, setType] = useState({ code: '', name: '', baseRate: '', maxAdults: 2, maxChildren: 0, amenities: '' });
  const [room, setRoom] = useState({ roomNumber: '', roomTypeId: '', floor: '' });
  const [plan, setPlan] = useState({ roomTypeId: '', name: '', dateFrom: '', dateTo: '', nightlyRate: '' });
  const run = async (fn) => { setError(null); try { await fn(); setup.reload(); } catch (err) { setError(err); } };

  if (!setup.data) return <ErrorNote error={setup.error} />;
  const s = setup.data;
  return (
    <>
      <ErrorNote error={error} />
      <section className="card">
        <h2>Room types</h2>
        <table>
          <thead><tr><th>Type</th><th>Sleeps</th><th className="num">Base rate / night</th><th>Rooms</th></tr></thead>
          <tbody>{s.roomTypes.map((t) => <tr key={t.id}><td><strong>{t.name}</strong> <span className="muted small">{t.code}</span></td><td>{t.max_adults}+{t.max_children}</td><td className="num">{formatMoney(t.base_rate)}</td><td>{t.room_count}</td></tr>)}</tbody>
        </table>
        <div className="row wrap">
          <input placeholder="Code (e.g. DLX)" value={type.code} onChange={(e) => setType({ ...type, code: e.target.value })} />
          <input placeholder="Name" value={type.name} onChange={(e) => setType({ ...type, name: e.target.value })} />
          <input type="number" placeholder="Base rate" value={type.baseRate} onChange={(e) => setType({ ...type, baseRate: e.target.value })} />
          <input type="number" min="1" placeholder="Adults" value={type.maxAdults} onChange={(e) => setType({ ...type, maxAdults: e.target.value })} />
          <input placeholder="Amenities, comma separated" value={type.amenities} onChange={(e) => setType({ ...type, amenities: e.target.value })} />
          <button className="secondary small-btn" onClick={() => run(async () => {
            await api.post(`/api/apartments/${unitId}/room-types`, { code: type.code, name: type.name, baseRate: Number(type.baseRate),
              maxAdults: Number(type.maxAdults), maxChildren: Number(type.maxChildren),
              amenities: type.amenities.split(',').map((a) => a.trim()).filter(Boolean) });
            setType({ code: '', name: '', baseRate: '', maxAdults: 2, maxChildren: 0, amenities: '' });
          })}>Add type</button>
        </div>
      </section>
      <section className="card">
        <h2>Rooms</h2>
        <p className="small">{s.rooms.map((r) => `${r.room_number} (${r.room_type_name})`).join(' · ') || 'No rooms yet.'}</p>
        <div className="row wrap">
          <input placeholder="Room number" value={room.roomNumber} onChange={(e) => setRoom({ ...room, roomNumber: e.target.value })} />
          <input placeholder="Floor" value={room.floor} onChange={(e) => setRoom({ ...room, floor: e.target.value })} />
          <select value={room.roomTypeId} onChange={(e) => setRoom({ ...room, roomTypeId: e.target.value })}>
            <option value="">Type…</option>{s.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="secondary small-btn" onClick={() => run(async () => {
            await api.post(`/api/apartments/${unitId}/rooms`, { roomNumber: room.roomNumber, floor: room.floor || null, roomTypeId: room.roomTypeId,
              branchId: org.data.branches[0].id });
            setRoom({ ...room, roomNumber: '' });
          })}>Add room</button>
        </div>
      </section>
      <section className="card">
        <h2>Seasonal rates</h2>
        <ul className="plain small">{s.ratePlans.map((p) => (
          <li key={p.id}>{p.room_type_name}: {p.name}, {shortDate(p.date_from)}–{shortDate(p.date_to)} at {formatMoney(p.nightly_rate)}
            <button className="link small" onClick={() => run(() => api.delete(`/api/apartments/${unitId}/rate-plans/${p.id}`))}>Remove</button></li>
        ))}</ul>
        <div className="row wrap">
          <select value={plan.roomTypeId} onChange={(e) => setPlan({ ...plan, roomTypeId: e.target.value })}>
            <option value="">Type…</option>{s.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input placeholder="Name (e.g. Christmas)" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
          <input type="date" value={plan.dateFrom} onChange={(e) => setPlan({ ...plan, dateFrom: e.target.value })} aria-label="From" />
          <input type="date" value={plan.dateTo} onChange={(e) => setPlan({ ...plan, dateTo: e.target.value })} aria-label="To" />
          <input type="number" placeholder="Nightly rate" value={plan.nightlyRate} onChange={(e) => setPlan({ ...plan, nightlyRate: e.target.value })} />
          <button className="secondary small-btn" onClick={() => run(async () => {
            await api.post(`/api/apartments/${unitId}/rate-plans`, { ...plan, nightlyRate: Number(plan.nightlyRate) });
            setPlan({ roomTypeId: '', name: '', dateFrom: '', dateTo: '', nightlyRate: '' });
          })}>Add rate</button>
        </div>
      </section>
    </>
  );
}
