import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { formatMoney, formatQty } from '../components/UnitPicker.jsx';

const STATUS = { in_transit: ['In transit', 'warn'], received: ['Received', 'good'], rejected: ['Refused', 'bad'], returned: ['Returned', 'neutral'] };

export function TransfersPage() {
  const { me } = useSession();
  const transfers = useLoad(() => api.get('/api/transfers'));
  const [sending, setSending] = useState(false);
  const canSend = me.scope.some((s) => s.access.OPS === 'write');

  return (
    <>
      <PageHeader title="Transfers between units" subtitle="Stock sent from one business unit to another travels at its average cost."
        actions={canSend && !sending && <button className="primary" onClick={() => setSending(true)}>+ Send stock</button>} />
      {sending && <SendForm onDone={() => { setSending(false); transfers.reload(); }} />}
      <ErrorNote error={transfers.error} />
      {transfers.data?.length === 0 && <div className="card muted">No transfers yet.</div>}
      {transfers.data?.map((t) => <TransferCard key={t.id} t={t} onChanged={transfers.reload} />)}
    </>
  );
}

function TransferCard({ t, onChanged }) {
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [locationId, setLocationId] = useState('');
  const locations = useLoad(() => (t.status === 'in_transit' && t.can_receive
    ? api.get(`/api/inventory/${t.to_business_unit_id}/locations`) : Promise.resolve([])), [t.id, t.status]);
  const act = async (action, body) => {
    setError(null);
    try {
      await api.post(`/api/transfers/${t.id}/${action}`, body);
      onChanged();
    } catch (err) {
      setError(err);
    }
  };
  const showCost = t.lines?.some((l) => l.unit_cost !== null);

  return (
    <section className="card">
      <div className="row spread wrap">
        <div>
          <h2>{t.transfer_number} <Badge tone={STATUS[t.status][1]}>{STATUS[t.status][0]}</Badge></h2>
          <div className="small"><strong>{t.from_unit_name}</strong>{t.from_location_name ? ` (${t.from_location_name})` : ''} → <strong>{t.to_unit_name}</strong>{t.to_location_name ? ` (${t.to_location_name})` : ''}</div>
          <div className="muted small">
            Sent by {t.dispatched_by_name} {formatDateTime(t.dispatched_at)}
            {t.received_at && ` · received by ${t.received_by_name} ${formatDateTime(t.received_at)}`}
            {t.reject_reason && ` · refused: ${t.reject_reason}`}
          </div>
        </div>
      </div>
      <ul className="plain small">
        {t.lines?.map((l, i) => (
          <li key={i}>{l.item_name}: {formatQty(l.qty)}{l.batch_no ? ` · batch ${l.batch_no}` : ''}{showCost && l.unit_cost !== null ? ` · ${formatMoney(l.unit_cost)} each` : ''}</li>
        ))}
      </ul>
      <ErrorNote error={error} />
      {t.status === 'in_transit' && t.can_receive && (
        <div className="row wrap">
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Receive into…</option>
            {locations.data?.filter((l) => l.is_active && l.tier !== 'staff').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="primary" disabled={!locationId} onClick={() => act('receive', { toLocationId: locationId })}>Accept</button>
          <input placeholder="Reason for refusing" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="danger" onClick={() => act('reject', { reason })}>Refuse</button>
        </div>
      )}
      {t.status === 'rejected' && t.can_return && (
        <button className="primary" onClick={() => act('return')}>Put back into {t.from_location_name}</button>
      )}
    </section>
  );
}

function SendForm({ onDone }) {
  const { me } = useSession();
  const fromUnits = me.scope.filter((s) => s.access.OPS === 'write');
  const org = useLoad(() => api.get('/api/org'));
  const [fromId, setFromId] = useState(fromUnits[0]?.business_unit_id ?? '');
  const [toId, setToId] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([{ itemId: '', qty: '' }]);
  const [error, setError] = useState(null);
  const locations = useLoad(() => (fromId ? api.get(`/api/inventory/${fromId}/locations`) : Promise.resolve([])), [fromId]);
  const items = useLoad(() => (fromId ? api.get(`/api/catalog/items?businessUnitId=${fromId}`) : Promise.resolve([])), [fromId]);
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/transfers', {
        fromBusinessUnitId: fromId, toBusinessUnitId: toId, fromLocationId, notes: notes || null,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Send stock to another unit</h2>
      <div className="form-grid">
        <label>From unit
          <select value={fromId} onChange={(e) => { setFromId(e.target.value); setFromLocationId(''); setLines([{ itemId: '', qty: '' }]); }}>
            {fromUnits.map((u) => <option key={u.business_unit_id} value={u.business_unit_id}>{u.name}</option>)}
          </select>
        </label>
        <label>From store
          <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} required>
            <option value="">Choose…</option>
            {locations.data?.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>To unit
          <select value={toId} onChange={(e) => setToId(e.target.value)} required>
            <option value="">Choose…</option>
            {org.data?.businessUnits.filter((b) => b.id !== fromId && b.is_active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="row">
          <select className="grow" value={l.itemId} onChange={(e) => setLine(i, 'itemId', e.target.value)}>
            <option value="">Choose item…</option>
            {items.data?.filter((it) => it.enabled_in_unit && it.is_stockable && !it.owner_business_unit_id).map((it) => (
              <option key={it.id} value={it.id}>{it.name} ({it.base_uom})</option>))}
          </select>
          <input className="num-input" type="number" min="0" step="any" placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} />
          {lines.length > 1 && <button type="button" className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      <button type="button" className="link" onClick={() => setLines([...lines, { itemId: '', qty: '' }])}>+ Add item</button>
      <p className="muted small">Only group items can move between units. The receiving unit must stock the item and accepts the delivery into one of its stores.</p>
      <ErrorNote error={error} />
      <div className="row"><button className="primary">Send</button><button type="button" className="link" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
