import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, formatDateTime } from './ui.jsx';
import { formatMoney } from './UnitPicker.jsx';

const ENTRY_LABELS = {
  booking: 'Booking', addon: 'Add-on', service_charge: 'Service charge', tax: 'VAT', payment: 'Payment',
  refund: 'Refund', fee: 'Fee', adjustment: 'Adjustment',
};
const METHOD_LABELS = { cash: 'Cash', card: 'Card / POS', transfer: 'Bank transfer' };

/** The running bill of an appointment: booking, add-ons, deposits and payments. */
export function AppointmentBill({ unitId, appt, onChanged }) {
  const { me } = useSession();
  const bill = appt.bill;
  const canPost = unitAccess(me, unitId, 'FIN') === 'write';
  const isManager = canPost && unitAccess(me, unitId, 'CFG') === 'write';
  const [form, setForm] = useState({ kind: 'payment', amount: '', method: 'cash', description: '', reference: '' });
  const [removing, setRemoving] = useState(null);
  const [why, setWhy] = useState('');
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const base = `/api/bookings/${unitId}`;
  const run = async (fn) => { setError(null); try { await fn(); onChanged(); return true; } catch (err) { setError(err); return false; } };

  const balance = Number(bill.balance);
  const paid = Number(bill.paid);
  const depositLeft = Math.max(Number(appt.deposit_due) - paid, 0);
  const canStillPay = Math.max(Number(bill.expected_total) - paid, 0);
  const open = bill.status === 'open';

  return (
    <section className="card">
      <div className="row spread">
        <h2>Bill {bill.bill_number}</h2>
        <Badge tone={open ? 'good' : 'neutral'}>{open ? 'Open' : 'Closed'}</Badge>
      </div>
      {appt.status === 'booked' && Number(appt.deposit_due) > 0 && (
        <p className={depositLeft > 0 ? 'notice' : 'muted small'}>
          {depositLeft > 0 ? `Deposit due: ${formatMoney(depositLeft)} of ${formatMoney(appt.deposit_due)}` : `Deposit of ${formatMoney(appt.deposit_due)} paid`}
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th className="hide-narrow">When</th><th>Item</th><th className="num hide-narrow">Charges</th><th className="num hide-narrow">Payments</th><th className="num show-narrow-cell">Amount</th><th /></tr></thead>
          <tbody>
            {bill.entries.map((e) => (
              <tr key={e.id} className={e.reversed || e.reverses_entry_id ? 'dim' : ''}>
                <td className="small hide-narrow">{formatDateTime(e.posted_at)}</td>
                <td>{e.description}<div className="muted small"><span className="show-narrow">{formatDateTime(e.posted_at)} · </span>{ENTRY_LABELS[e.entry_type]}{e.method ? ` · ${METHOD_LABELS[e.method] ?? e.method}` : ''}{e.reference ? ` · ${e.reference}` : ''} · {e.posted_by_name}</div></td>
                <td className="num hide-narrow">{Number(e.amount) > 0 ? formatMoney(e.amount) : Number(e.amount) < 0 && !['payment', 'refund'].includes(e.entry_type) ? `−${formatMoney(-e.amount)}` : ''}</td>
                <td className="num hide-narrow">{e.entry_type === 'payment' ? formatMoney(-e.amount) : ''}</td>
                <td className="num show-narrow-cell small">{e.entry_type === 'payment' ? `paid ${formatMoney(-e.amount)}` : Number(e.amount) < 0 ? `−${formatMoney(-e.amount)}` : formatMoney(e.amount)}</td>
                <td>{open && canPost && e.entry_type === 'addon' && !e.reversed && !e.reverses_entry_id && (
                  <button className="link small" onClick={() => { setRemoving(e); setWhy(''); }} aria-label={`Remove ${e.description}`}>Remove</button>
                )}</td>
              </tr>
            ))}
            {bill.entries.length === 0 && <tr><td colSpan={6} className="muted">Nothing on the bill yet. The booking is charged when it is completed.</td></tr>}
          </tbody>
          <tfoot>
            <tr><th colSpan={2} className="num hide-narrow">{balance > 0 ? 'Balance due' : balance < 0 ? 'In credit' : 'Settled'}</th>
              <th className="num show-narrow-cell">{balance > 0 ? 'Balance due' : balance < 0 ? 'In credit' : 'Settled'}</th>
              <th colSpan={3} className="num hide-narrow">{formatMoney(Math.abs(balance))}</th>
              <th colSpan={2} className="num show-narrow-cell">{formatMoney(Math.abs(balance))}</th></tr>
          </tfoot>
        </table>
      </div>
      {appt.status !== 'completed' && open && (
        <p className="muted small">Booking total when completed: {formatMoney(Number(bill.expected_total))} with service charge and VAT (add-ons included).</p>
      )}
      {removing && (
        <div className="row wrap">
          <span>Remove <strong>{removing.description}</strong>?</span>
          <input placeholder="Reason" value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Reason for removing" />
          <button className="secondary small-btn" disabled={why.trim().length < 2}
            onClick={async () => { if (await run(() => api.post(`${base}/bill-entries/${removing.id}/void`, { reason: why }))) setRemoving(null); }}>Remove</button>
          <button className="link" onClick={() => setRemoving(null)}>Keep</button>
        </div>
      )}
      {open && canPost && (
        <>
          <div className="row wrap">
            <select value={form.kind} onChange={set('kind')} aria-label="Bill action">
              <option value="payment">Take payment</option>
              <option value="refund">Refund</option>
              {isManager && <option value="adjustment">Adjustment (manager)</option>}
            </select>
            <input type="number" min="0" step="any" placeholder="Amount" value={form.amount} onChange={set('amount')} aria-label="Amount" />
            {form.kind !== 'adjustment' && (
              <select value={form.method} onChange={set('method')} aria-label="Method">
                {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            )}
            {form.kind !== 'adjustment' && <input placeholder="Reference" value={form.reference} onChange={set('reference')} />}
            <input placeholder={form.kind === 'adjustment' ? 'Reason' : 'Note'} value={form.description} onChange={set('description')} />
            {form.kind === 'payment' && depositLeft > 0 && appt.status === 'booked' && (
              <button className="link" onClick={() => setForm({ ...form, amount: String(depositLeft) })}>Deposit {formatMoney(depositLeft)}</button>
            )}
            {form.kind === 'payment' && canStillPay > 0 && (
              <button className="link" onClick={() => setForm({ ...form, amount: String(Math.round(canStillPay * 100) / 100) })}>
                {appt.status === 'completed' ? 'Full balance' : 'Pay in full'} {formatMoney(canStillPay)}</button>
            )}
            {form.kind === 'refund' && balance < 0 && <button className="link" onClick={() => setForm({ ...form, amount: String(-balance) })}>Refund credit</button>}
            <button className="primary" disabled={!form.amount} onClick={async () => {
              if (await run(() => api.post(`${base}/appointments/${appt.id}/bill`, {
                kind: form.kind, amount: Number(form.amount), method: form.kind === 'adjustment' ? null : form.method,
                reference: form.reference || null, description: form.description || null,
              }))) setForm({ ...form, amount: '', reference: '', description: '' });
            }}>Post</button>
          </div>
          {!['cancelled', 'no_show'].includes(appt.status) && <AddOn unitId={unitId} appt={appt} run={run} />}
        </>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function AddOn({ unitId, appt, run }) {
  const locations = useLoad(() => api.get(`/api/inventory/${unitId}/locations`).catch(() => []), [unitId]);
  const stores = (locations.data ?? []).filter((l) => l.is_active !== false);
  const [locationId, setLocationId] = useState('');
  const loc = locationId || stores[0]?.id || '';
  const catalog = useLoad(() => api.get(`/api/pos/${unitId}/catalog${loc ? `?locationId=${loc}` : ''}`), [unitId, loc]);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('1');
  const items = catalog.data?.items ?? [];
  const item = items.find((i) => i.id === itemId);
  return (
    <div className="row wrap">
      <strong className="small">Add-on</strong>
      <select value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Add-on item">
        <option value="">Equipment, service or product…</option>
        {items.map((i) => (
          <option key={i.id} value={i.id} disabled={i.is_stockable && Number(i.on_hand) <= 0}>
            {i.name} · {formatMoney(i.sell_price)}{i.is_stockable ? ` · ${Number(i.on_hand)} in stock` : ''}
          </option>
        ))}
      </select>
      <input type="number" min="1" step="any" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" className="num-input" />
      {stores.length > 1 && (
        <select value={loc} onChange={(e) => setLocationId(e.target.value)} aria-label="From store">
          {stores.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      )}
      <button className="secondary small-btn" disabled={!item || !(Number(qty) > 0)} onClick={async () => {
        if (await run(() => api.post(`/api/bookings/${unitId}/appointments/${appt.id}/addons`, { itemId, qty: Number(qty), locationId: loc || null }))) {
          setItemId(''); setQty('1');
        }
      }}>Add{item ? ` ${formatMoney(Number(item.sell_price) * Number(qty || 0))}` : ''}</button>
    </div>
  );
}
