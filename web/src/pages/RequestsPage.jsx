import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { UnitPicker, formatQty, useSelectedUnit } from '../components/UnitPicker.jsx';

const STATUS = {
  pending: ['Awaiting approval', 'warn'], approved: ['Approved: to issue', 'good'], rejected: ['Rejected', 'bad'],
  fulfilled: ['Issued', 'neutral'], cancelled: ['Cancelled', 'neutral'],
};

export function RequestsPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.OPS);
  const [unitId, setUnitId] = useSelectedUnit(units, 'requests.unit');
  const list = useLoad(() => (unitId ? api.get(`/api/requests/${unitId}`) : Promise.resolve([])), [unitId]);
  const [creating, setCreating] = useState(false);

  if (units.length === 0) return <><PageHeader title="Item requests" /><div className="card muted">You do not work in any unit.</div></>;

  return (
    <>
      <PageHeader title="Item requests" subtitle="Ask the store for items; a manager approves and the store issues them."
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      {!creating && <div className="row"><button className="primary" onClick={() => setCreating(true)}>+ New request</button></div>}
      {creating && <NewRequest unitId={unitId} onDone={() => { setCreating(false); list.reload(); }} />}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 && <div className="card muted">No requests yet.</div>}
      {list.data?.map((r) => <RequestCard key={r.id} unitId={unitId} r={r} onChanged={list.reload} />)}
    </>
  );
}

function RequestCard({ unitId, r, onChanged }) {
  const { me } = useSession();
  const isManager = unitAccess(me, unitId, 'CFG') === 'write';
  const canIssue = unitAccess(me, unitId, 'OPS') === 'write';
  const [note, setNote] = useState('');
  const [approved, setApproved] = useState(Object.fromEntries((r.lines ?? []).map((l) => [l.id, String(Number(l.qty_requested))])));
  const [error, setError] = useState(null);
  const act = async (action, body = {}) => {
    setError(null);
    try {
      await api.post(`/api/requests/${unitId}/${r.id}/${action}`, body);
      onChanged();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section className="card">
      <div className="row spread wrap">
        <div>
          <h2>{r.request_number} <Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge></h2>
          <div className="small">{r.requested_by_name} · {r.from_location_name} → {r.to_location_name}{r.needed_by ? ` · needed by ${r.needed_by}` : ''}</div>
          <div className="muted small">
            {formatDateTime(r.requested_at)}
            {r.decided_by_name && ` · ${r.status === 'rejected' ? 'rejected' : 'approved'} by ${r.decided_by_name}`}
            {r.decision_note && `: ${r.decision_note}`}
            {r.fulfilled_by_name && ` · issued by ${r.fulfilled_by_name} ${formatDateTime(r.fulfilled_at)}`}
          </div>
          {r.notes && <p className="small">{r.notes}</p>}
        </div>
      </div>
      <table>
        <thead><tr><th>Item</th><th className="num">Requested</th><th className="num">Approved</th></tr></thead>
        <tbody>
          {r.lines?.map((l) => (
            <tr key={l.id}>
              <td>{l.item_name}</td>
              <td className="num">{formatQty(l.qty_requested)} {l.uom}</td>
              <td className="num">
                {r.status === 'pending' && isManager && !r.is_mine
                  ? <input className="num-input" type="number" min="0" step="any" value={approved[l.id]} onChange={(e) => setApproved({ ...approved, [l.id]: e.target.value })} />
                  : l.qty_approved !== null ? formatQty(l.qty_approved) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorNote error={error} />
      <div className="row wrap">
        {r.status === 'pending' && isManager && <>
          <button className="primary" onClick={() => act('approve', {
            note: note || null, lines: Object.entries(approved).map(([lineId, q]) => ({ lineId, qtyApproved: Number(q) || 0 })) })}>Approve</button>
          <input placeholder="Note / reason" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="danger" onClick={() => act('reject', { note })}>Reject</button>
        </>}
        {r.status === 'approved' && canIssue && <button className="primary" onClick={() => act('fulfil')}>Issue items</button>}
        {r.status === 'pending' && r.is_mine && <button className="link" onClick={() => act('cancel')}>Cancel my request</button>}
      </div>
    </section>
  );
}

function NewRequest({ unitId, onDone }) {
  const locations = useLoad(() => api.get(`/api/inventory/${unitId}/locations`), [unitId]);
  const items = useLoad(() => api.get(`/api/catalog/items?businessUnitId=${unitId}`), [unitId]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([{ itemId: '', qty: '' }]);
  const [error, setError] = useState(null);
  const active = locations.data?.filter((l) => l.is_active) ?? [];
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/api/requests/${unitId}`, {
        fromLocationId: fromId, toLocationId: toId, neededBy: neededBy || null, notes: notes || null,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New item request</h2>
      <div className="form-grid">
        <label>From store
          <select value={fromId} onChange={(e) => setFromId(e.target.value)} required>
            <option value="">Choose…</option>
            {active.filter((l) => l.tier !== 'staff').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>Deliver to
          <select value={toId} onChange={(e) => setToId(e.target.value)} required>
            <option value="">Choose…</option>
            {active.filter((l) => l.id !== fromId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>Needed by<input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} /></label>
        <label>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="row">
          <select className="grow" value={l.itemId} onChange={(e) => setLine(i, 'itemId', e.target.value)}>
            <option value="">Choose item…</option>
            {items.data?.filter((it) => it.enabled_in_unit && it.is_stockable).map((it) => <option key={it.id} value={it.id}>{it.name} ({it.base_uom})</option>)}
          </select>
          <input className="num-input" type="number" min="0" step="any" placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} />
          {lines.length > 1 && <button type="button" className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      <button type="button" className="link" onClick={() => setLines([...lines, { itemId: '', qty: '' }])}>+ Add item</button>
      <ErrorNote error={error} />
      <div className="row"><button className="primary">Send request</button><button type="button" className="link" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
