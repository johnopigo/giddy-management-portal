import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useLoad } from '../../lib/useLoad.js';
import { ErrorNote } from '../../components/ui.jsx';
import { formatMoney } from '../../components/UnitPicker.jsx';
import { addDays, formatDuration, localTime, longDate, todayIn } from '../../lib/time.js';

// The public booking site: no login. Guests book a stay, a Spa treatment or Studio hire,
// pay the deposit, and come back to their booking through the private link they are given.

const TZ = 'Africa/Lagos';
const UNIT_COPY = {
  apartments: ['Stay with us', 'Serviced apartments by the night.'],
  spa: ['Spa treatments', 'Massages, facials and more.'],
  content_studio: ['Studio hire', 'Podcast and video booths by the hour.'],
};

export function BookingSite() {
  return (
    <div className="public-shell">
      <Routes>
        <Route path="manage/:token" element={<Manage />} />
        <Route path="pay/:reference" element={<TestPayment />} />
        <Route path=":slug" element={<Home />} />
        <Route path=":slug/stay" element={<Stay />} />
        <Route path=":slug/u/:unitId" element={<Appointment />} />
        <Route path="*" element={<div className="card"><h1>Booking</h1><p className="muted">Use the booking link you were given.</p></div>} />
      </Routes>
      <footer className="public-foot muted small">Payments are processed securely by Paystack. Your card details never reach us.</footer>
    </div>
  );
}

function Brand({ name, slug }) {
  return (
    <header className="public-head">
      <Link to={slug ? `/book/${slug}` : '#'} className="brand">
        <span className="brand-mark">G</span>
        <span><span className="brand-name">{name ?? 'Giddy'}</span><span className="brand-tenant">Book online</span></span>
      </Link>
    </header>
  );
}

function TestBanner({ gateway }) {
  if (gateway !== 'test') return null;
  return <div className="notice">Test mode: payments are simulated and no money moves.</div>;
}

function useSite() {
  const { slug } = useParams();
  return { slug, site: useLoad(() => api.get(`/api/public/${slug}`), [slug]) };
}

function Home() {
  const { slug, site } = useSite();
  if (!site.data) return <ErrorNote error={site.error} />;
  return (
    <>
      <Brand name={site.data.name} slug={slug} />
      <TestBanner gateway={site.data.gateway} />
      <h1>What would you like to book?</h1>
      {site.data.units.length === 0 && <p className="muted">Online booking is not open at the moment. Please call us.</p>}
      <div className="choice-grid">
        {site.data.units.map((u) => (
          <Link key={u.id} className="card choice" to={u.unit_type === 'apartments' ? `/book/${slug}/stay?unit=${u.id}` : `/book/${slug}/u/${u.id}`}>
            <h2>{UNIT_COPY[u.unit_type]?.[0] ?? u.name}</h2>
            <p className="muted">{u.name} · {UNIT_COPY[u.unit_type]?.[1]}</p>
            <span className="link">Book →</span>
          </Link>
        ))}
      </div>
    </>
  );
}

function GuestFields({ guest, setGuest }) {
  const set = (k) => (e) => setGuest({ ...guest, [k]: e.target.value });
  return (
    <>
      <label>Full name<input value={guest.fullName} onChange={set('fullName')} autoComplete="name" required /></label>
      <label>Phone<input type="tel" value={guest.phone} onChange={set('phone')} autoComplete="tel" required /></label>
      <label>Email (for your receipt)<input type="email" value={guest.email} onChange={set('email')} autoComplete="email" required /></label>
    </>
  );
}

/** After booking: off to the payment page, or straight to the booking when nothing is due. */
function useFinish() {
  const navigate = useNavigate();
  return (r) => {
    if (r.paymentUrl) {
      if (r.paymentUrl.startsWith(window.location.origin)) navigate(r.paymentUrl.slice(window.location.origin.length));
      else window.location.assign(r.paymentUrl);
    } else navigate(`/book/manage/${r.token}`);
  };
}

function Stay() {
  const { slug, site } = useSite();
  const [params] = useSearchParams();
  const unitId = params.get('unit') ?? site.data?.units.find((u) => u.unit_type === 'apartments')?.id;
  const [checkIn, setCheckIn] = useState(addDays(todayIn(TZ), 1));
  const [checkOut, setCheckOut] = useState(addDays(todayIn(TZ), 2));
  const [adults, setAdults] = useState(2);
  const [chosen, setChosen] = useState(null);
  const [guest, setGuest] = useState({ fullName: '', phone: '', email: '' });
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const finish = useFinish();
  const valid = checkOut > checkIn;
  const rooms = useLoad(() => (unitId && valid ? api.get(`/api/public/${slug}/rooms?unitId=${unitId}&checkIn=${checkIn}&checkOut=${checkOut}&adults=${adults}`) : Promise.resolve([])),
    [slug, unitId, checkIn, checkOut, adults]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      finish(await api.post(`/api/public/${slug}/rooms`, { unitId, roomTypeId: chosen.room_type_id, checkIn, checkOut, adults: Number(adults), notes: notes || null, guest }));
    } catch (err) {
      setError(err);
      setChosen(null);
      rooms.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Brand name={site.data?.name} slug={slug} />
      <TestBanner gateway={site.data?.gateway} />
      <h1>Stay with us</h1>
      <section className="card form-grid">
        <label>Arrival<input type="date" value={checkIn} min={todayIn(TZ)} onChange={(e) => { if (!e.target.value) return; setCheckIn(e.target.value); setChosen(null); if (checkOut <= e.target.value) setCheckOut(addDays(e.target.value, 1)); }} /></label>
        <label>Departure<input type="date" value={checkOut} min={addDays(checkIn, 1)} onChange={(e) => { if (e.target.value) { setCheckOut(e.target.value); setChosen(null); } }} /></label>
        <label>Guests<select value={adults} onChange={(e) => { setAdults(e.target.value); setChosen(null); }}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} adult{n > 1 ? 's' : ''}</option>)}</select></label>
      </section>
      <ErrorNote error={rooms.error} />
      {rooms.data?.length === 0 && valid && <p className="muted">Nothing is free for those dates. Try other dates or call us.</p>}
      <div className="choice-grid">
        {rooms.data?.map((r) => (
          <button key={r.room_type_id} className={`card choice ${chosen?.room_type_id === r.room_type_id ? 'active' : ''}`} onClick={() => setChosen(r)}>
            <h2>{r.name}</h2>
            {r.description && <p className="small">{r.description}</p>}
            <p className="muted small">Sleeps {r.max_adults}{r.amenities?.length ? ` · ${r.amenities.join(' · ')}` : ''}</p>
            <p><strong>{formatMoney(r.stay_total)}</strong> <span className="muted small">for {r.nights} night{r.nights > 1 ? 's' : ''}, with service charge and VAT</span></p>
            {Number(r.deposit) > 0 && <p className="small">Pay {Number(r.deposit) === Number(r.stay_total) ? 'in full' : formatMoney(r.deposit)} now to confirm</p>}
          </button>
        ))}
      </div>
      {chosen && (
        <form className="card form-grid" onSubmit={submit}>
          <h2 className="full">{chosen.name} · {longDate(checkIn)} to {longDate(checkOut)}</h2>
          <GuestFields guest={guest} setGuest={setGuest} />
          <label className="full">Anything we should know?<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Arrival time, airport pick-up…" /></label>
          <div className="full">
            <ErrorNote error={error} />
            <button className="primary" disabled={busy}>{Number(chosen.deposit) > 0 ? `Continue to pay ${formatMoney(chosen.deposit)}` : 'Confirm booking'}</button>
          </div>
        </form>
      )}
      {!chosen && <ErrorNote error={error} />}
    </>
  );
}

function Appointment() {
  const { slug, site } = useSite();
  const { unitId } = useParams();
  const data = useLoad(() => api.get(`/api/public/${slug}/units/${unitId}/services`), [slug, unitId]);
  const [serviceId, setServiceId] = useState(null);
  const tz = data.data?.unit.timeZone ?? TZ;
  const [date, setDate] = useState(todayIn(TZ));
  const [slots, setSlots] = useState(1);
  const [time, setTime] = useState(null);
  const [guest, setGuest] = useState({ fullName: '', phone: '', email: '' });
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const finish = useFinish();
  const service = data.data?.services.find((s) => s.id === serviceId);
  const n = service?.mode === 'slot' ? Math.min(Math.max(slots, service.min_slots), service.max_slots) : 1;
  const times = useLoad(() => (service ? api.get(`/api/public/${slug}/units/${unitId}/availability?serviceId=${service.id}&date=${date}&slots=${n}`) : Promise.resolve(null)),
    [slug, unitId, service?.id, date, n]);

  if (!data.data) return <><Brand name={site.data?.name} slug={slug} /><ErrorNote error={data.error} /></>;
  const unit = data.data.unit;
  const price = service ? Number(service.price) * n : 0;
  const deposit = service ? Math.round(price * Number(service.deposit_pct)) / 100 : 0;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      finish(await api.post(`/api/public/${slug}/units/${unitId}/appointments`, { serviceId: service.id, startsAt: time.starts_at, slots: n, notes: notes || null, guest }));
    } catch (err) {
      setError(err);
      setTime(null);
      times.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Brand name={site.data?.name} slug={slug} />
      <TestBanner gateway={site.data?.gateway} />
      <h1>{UNIT_COPY[unit.unitType]?.[0] ?? unit.name}</h1>
      {data.data.services.length === 0 && <p className="muted">Nothing can be booked online here yet. Please call us.</p>}
      <div className="choice-grid">
        {data.data.services.map((s) => (
          <button key={s.id} className={`card choice ${serviceId === s.id ? 'active' : ''}`} onClick={() => { setServiceId(s.id); setTime(null); setSlots(s.min_slots); }}>
            <h2>{s.name}</h2>
            {s.description && <p className="small">{s.description}</p>}
            <p className="muted small">{s.mode === 'slot' ? `${formatDuration(s.duration_min)} slots, ${s.min_slots}–${s.max_slots}` : formatDuration(s.duration_min)}</p>
            <p><strong>{formatMoney(s.price)}</strong>{s.mode === 'slot' && <span className="muted small"> per slot</span>}<span className="muted small"> + service charge and VAT</span></p>
          </button>
        ))}
      </div>
      {service && (
        <section className="card">
          <div className="row wrap">
            <label>Day<input type="date" value={date} min={todayIn(tz)} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setTime(null); } }} /></label>
            {service.mode === 'slot' && (
              <label>How long
                <select value={n} onChange={(e) => { setSlots(Number(e.target.value)); setTime(null); }}>
                  {Array.from({ length: service.max_slots - service.min_slots + 1 }, (_, i) => service.min_slots + i)
                    .map((k) => <option key={k} value={k}>{formatDuration(k * service.duration_min)}</option>)}
                </select>
              </label>
            )}
          </div>
          <h2>Free times · {longDate(date)}</h2>
          <ErrorNote error={times.error} />
          {times.data?.length === 0 && <p className="muted">Nothing free that day. Try another day.</p>}
          <div className="slot-grid">
            {times.data?.map((t) => (
              <button key={t.starts_at} className={`slot-chip ${time?.starts_at === t.starts_at ? 'active' : ''}`} onClick={() => setTime(t)}>{localTime(t.starts_at, tz)}</button>
            ))}
          </div>
        </section>
      )}
      {service && time && (
        <form className="card form-grid" onSubmit={submit}>
          <h2 className="full">{service.name} · {longDate(date)}, {localTime(time.starts_at, tz)}–{localTime(time.ends_at, tz)}</h2>
          <p className="full">{formatMoney(price)} + service charge and VAT{deposit > 0 ? `. A deposit of ${formatMoney(deposit)} secures your booking; the rest is paid on the day.` : ', paid on the day.'}</p>
          <GuestFields guest={guest} setGuest={setGuest} />
          <label className="full">Anything we should know?<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={unit.unitType === 'spa' ? 'Preferences, occasion…' : 'What you are recording, equipment needed…'} /></label>
          <div className="full">
            <ErrorNote error={error} />
            <button className="primary" disabled={busy}>{deposit > 0 ? `Continue to pay ${formatMoney(deposit)}` : 'Confirm booking'}</button>
          </div>
        </form>
      )}
    </>
  );
}

const STATUS_COPY = {
  confirmed: 'Confirmed', booked: 'Confirmed', checked_in: 'Checked in', checked_out: 'Completed', completed: 'Completed',
  cancelled: 'Cancelled', no_show: 'Missed',
};

function Manage() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const reference = params.get('reference') ?? params.get('trxref');
  const [b, setB] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const finish = useFinish();

  useEffect(() => {
    let live = true;
    const load = reference
      ? api.post(`/api/public/manage/${token}/verify`, { reference }).catch(() => api.get(`/api/public/manage/${token}`))
      : api.get(`/api/public/manage/${token}`);
    load.then((x) => { if (live) setB(x); }).catch((err) => { if (live) setError(err); });
    return () => { live = false; };
  }, [token, reference]);

  const act = async (fn) => {
    setError(null);
    setBusy(true);
    try { await fn(); } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (!b) return <><Brand /><ErrorNote error={error} />{!error && <p className="muted">Loading your booking…</p>}</>;
  const tz = b.timeZone ?? TZ;
  const pending = b.paymentStatus === 'pending' && b.canPay;
  return (
    <>
      <Brand name={b.unitName} />
      <section className="card">
        <p className="muted small">Booking {b.bookingRef} · {b.guestName}</p>
        <h1>{pending ? 'Almost done: pay to confirm' : b.status === 'cancelled' ? 'Booking cancelled' : 'Your booking is confirmed'}</h1>
        {b.kind === 'stay'
          ? <p><strong>{b.roomTypes}</strong><br />{longDate(b.checkIn)} to {longDate(b.checkOut)}</p>
          : <p><strong>{b.serviceName}</strong><br />{longDate(b.startsAt.slice(0, 10))}, {localTime(b.startsAt, tz)}–{localTime(b.endsAt, tz)}</p>}
        <p>{b.unitName} · Status: <strong>{STATUS_COPY[b.status] ?? b.status}</strong></p>
        {b.paymentStatus === 'paid' && <p className="success">Deposit of {formatMoney(b.amountDue)} received. Thank you.</p>}
        {b.paymentStatus === 'not_needed' && b.status !== 'cancelled' && <p className="muted">No deposit needed: pay on the day.</p>}
        {b.paymentStatus === 'expired' && <p className="muted">This booking was released because the deposit was not paid in time.</p>}
        {pending && (
          <>
            <p className="notice">We are holding this for you until {localTime(b.holdExpiresAt, tz)}. Pay the deposit of <strong>{formatMoney(b.amountDue)}</strong> to confirm.</p>
            <button className="primary" disabled={busy} onClick={() => act(async () => finish(await api.post(`/api/public/manage/${token}/pay`)))}>Pay {formatMoney(b.amountDue)}</button>
          </>
        )}
        {b.cancelRequestedAt && <p className="notice">You asked to cancel. We will contact you about your refund.</p>}
        <ErrorNote error={error} />
        {(b.canCancel || b.canRequestCancel) && (
          <div className="row">
            <button className="link" disabled={busy} onClick={() => {
              if (window.confirm(b.canCancel ? 'Cancel this booking?' : 'Ask us to cancel this booking and refund your deposit?')) {
                act(async () => setB((await api.post(`/api/public/manage/${token}/cancel`)).booking));
              }
            }}>{b.canCancel ? 'Cancel this booking' : 'Ask to cancel'}</button>
          </div>
        )}
        <p className="muted small">Keep this page's address: it is your private link to this booking.</p>
      </section>
    </>
  );
}

function TestPayment() {
  const { reference } = useParams();
  const navigate = useNavigate();
  const p = useLoad(() => api.get(`/api/public/test-payments/${encodeURIComponent(reference)}`), [reference]);
  const [error, setError] = useState(null);
  const decide = async (outcome) => {
    setError(null);
    try {
      await api.post(`/api/public/test-payments/${encodeURIComponent(reference)}`, { outcome });
      navigate(`${p.data.return_url}?reference=${encodeURIComponent(reference)}`);
    } catch (err) {
      setError(err);
    }
  };
  if (!p.data) return <><Brand /><ErrorNote error={p.error} /></>;
  return (
    <>
      <Brand name={p.data.unit_name} />
      <section className="card test-pay">
        <div className="notice">Test payment page. In production, guests pay on Paystack's secure page instead.</div>
        <h1>Pay {formatMoney(p.data.amount_due)}</h1>
        <p className="muted">{p.data.unit_name} · booking {p.data.booking_ref} · reference {reference}</p>
        <div className="row">
          <button className="primary" onClick={() => decide('success')}>Pay (test)</button>
          <button className="secondary" onClick={() => decide('failed')}>Decline (test)</button>
        </div>
        <ErrorNote error={error} />
      </section>
    </>
  );
}
