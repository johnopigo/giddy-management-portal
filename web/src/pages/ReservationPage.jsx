import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, formatDateTime } from '../components/ui.jsx';
import { formatMoney } from '../components/UnitPicker.jsx';
import { RES_STATUS } from './FrontDeskPage.jsx';

const ENTRY_LABELS = { room: 'Room', charge: 'Charge', service_charge: 'Service charge', tax: 'VAT', payment: 'Payment',
  refund: 'Refund', adjustment: 'Adjustment', other_unit: 'From another unit' };
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export function ReservationPage() {
  const { unitId, id } = useParams();
  const { me } = useSession();
  const r = useLoad(() => api.get(`/api/apartments/${unitId}/reservations/${id}`), [unitId, id]);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [newOut, setNewOut] = useState('');
  const canAct = unitAccess(me, unitId, 'OPS') === 'write';
  const act = async (path, body) => {
    setError(null);
    try {
      await api.post(`/api/apartments/${unitId}/reservations/${id}/${path}`, body);
      r.reload();
    } catch (err) {
      setError(err);
    }
  };

  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="muted">Loading…</p>;
  const x = r.data;

  return (
    <>
      <div className="row no-print"><Link to="/front-desk">← Front desk</Link><button className="secondary" onClick={() => window.print()}>Print bill</button></div>
      <section className="card">
        <div className="row spread wrap">
          <div>
            <h1>{x.guest_name} <Badge tone={RES_STATUS[x.status][1]}>{RES_STATUS[x.status][0]}</Badge></h1>
            <div className="small">{x.booking_ref} · {x.guest_phone ?? ''} · {x.adults} adult{x.adults === 1 ? '' : 's'}{x.children ? `, ${x.children} children` : ''} · via {x.source.replace('_', ' ')}</div>
            <div className="small"><strong>{shortDate(x.check_in)} → {shortDate(x.check_out)}</strong> · {x.nights} night{x.nights === 1 ? '' : 's'} · room {x.rooms.map((rm) => rm.room_number).join(', ')}</div>
            {x.notes && <p className="small">{x.notes}</p>}
            <div className="muted small">
              Booked by {x.created_by_name} {formatDateTime(x.created_at)}
              {x.checked_in_at && ` · checked in by ${x.checked_in_by_name} ${formatDateTime(x.checked_in_at)}`}
              {x.checked_out_at && ` · checked out by ${x.checked_out_by_name} ${formatDateTime(x.checked_out_at)}`}
              {x.cancelled_at && ` · ${x.status === 'no_show' ? 'no-show' : 'cancelled'} by ${x.cancelled_by_name}${x.cancel_reason ? `: ${x.cancel_reason}` : ''}`}
            </div>
          </div>
        </div>
        <ErrorNote error={error} />
        {canAct && (
          <div className="row wrap no-print">
            {x.status === 'confirmed' && <button className="primary" onClick={() => act('check-in')}>Check in</button>}
            {x.status === 'checked_in' && <button className="primary" onClick={() => act('check-out')}>Check out</button>}
            {['confirmed', 'checked_in'].includes(x.status) && <>
              <input type="date" value={newOut} min={x.check_out} onChange={(e) => setNewOut(e.target.value)} aria-label="New departure date" />
              <button className="secondary" disabled={!newOut} onClick={() => act('extend', { checkOut: newOut })}>Extend stay</button>
            </>}
            {x.status === 'confirmed' && <>
              <input placeholder="Reason for cancelling" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="danger" onClick={() => act('cancel', { reason })}>Cancel booking</button>
              <button className="link" onClick={() => act('no-show')}>Mark no-show</button>
            </>}
          </div>
        )}
      </section>
      <section className="card no-print">
        <h2>Rooms and nights</h2>
        {x.rooms.map((rm) => (
          <div key={rm.id} className="small">
            <strong>Room {rm.room_number}</strong> ({rm.room_type_name}) ·{' '}
            {(rm.nights ?? []).map((n) => `${shortDate(n.date)} ${formatMoney(n.rate)}${n.charged ? ' ✓' : ''}`).join(' · ') || 'no nights held'}
          </div>
        ))}
      </section>
      {x.folio && <Folio unitId={unitId} folio={x.folio} onChanged={r.reload} />}
    </>
  );
}

function Folio({ unitId, folio, onChanged }) {
  const { me } = useSession();
  const canPost = unitAccess(me, unitId, 'FIN') === 'write';
  const isManager = canPost && unitAccess(me, unitId, 'CFG') === 'write';
  const [form, setForm] = useState({ kind: 'payment', amount: '', method: 'cash', description: '', reference: '' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => {
    setError(null);
    try {
      await api.post(`/api/apartments/${unitId}/folios/${folio.id}`, {
        kind: form.kind, amount: Number(form.amount), description: form.description || null,
        method: ['payment', 'refund'].includes(form.kind) ? form.method : null, reference: form.reference || null,
      });
      setForm({ ...form, amount: '', description: '', reference: '' });
      onChanged();
    } catch (err) {
      setError(err);
    }
  };
  const balance = Number(folio.balance);

  return (
    <section className="card">
      <div className="row spread">
        <h2>Guest bill {folio.folio_number}</h2>
        <Badge tone={folio.status === 'open' ? 'good' : 'neutral'}>{folio.status === 'open' ? 'Open' : 'Closed'}</Badge>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Item</th><th className="num">Charges</th><th className="num">Payments</th></tr></thead>
          <tbody>
            {folio.entries.map((e) => (
              <tr key={e.id}>
                <td className="small">{formatDateTime(e.posted_at)}</td>
                <td>{e.description}<div className="muted small">{ENTRY_LABELS[e.entry_type]}{e.source_unit_name ? ` · ${e.source_unit_name}` : ''}{e.method ? ` · ${e.method}` : ''}{e.reference ? ` · ${e.reference}` : ''} · {e.posted_by_name}</div></td>
                <td className="num">{Number(e.amount) > 0 ? formatMoney(e.amount) : ''}</td>
                <td className="num">{Number(e.amount) < 0 ? formatMoney(-e.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th colSpan={2} className="num">{balance > 0 ? 'Balance due' : balance < 0 ? 'Credit to refund' : 'Settled'}</th>
              <th colSpan={2} className="num">{formatMoney(Math.abs(balance))}</th></tr>
          </tfoot>
        </table>
      </div>
      {folio.status === 'open' && canPost && (
        <div className="row wrap no-print">
          <select value={form.kind} onChange={set('kind')} aria-label="Bill action">
            <option value="payment">Take payment</option>
            <option value="charge">Add charge</option>
            <option value="refund">Refund</option>
            {isManager && <option value="adjustment">Adjustment (manager)</option>}
          </select>
          <input type="number" min="0" step="any" placeholder="Amount" value={form.amount} onChange={set('amount')} aria-label="Amount" />
          {['payment', 'refund'].includes(form.kind) && (
            <select value={form.method} onChange={set('method')} aria-label="Method">
              <option value="cash">Cash</option><option value="card">Card / POS</option><option value="transfer">Bank transfer</option>
            </select>
          )}
          <input placeholder={form.kind === 'charge' ? 'What for (e.g. Laundry)' : form.kind === 'adjustment' ? 'Reason' : 'Note'} value={form.description} onChange={set('description')} />
          {['payment', 'refund'].includes(form.kind) && <input placeholder="Reference" value={form.reference} onChange={set('reference')} />}
          {form.kind === 'payment' && balance > 0 && <button className="link" onClick={() => setForm({ ...form, amount: String(balance) })}>Pay full balance</button>}
          <button className="primary" onClick={submit} disabled={!form.amount}>Post</button>
        </div>
      )}
      <ErrorNote error={error} />
      {form.kind === 'charge' && <p className="muted small no-print">Service charge and VAT are added to charges automatically.</p>}
    </section>
  );
}
