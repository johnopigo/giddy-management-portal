import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { UnitPicker, formatMoney, formatQty, useSelectedUnit } from '../components/UnitPicker.jsx';

const STATUS = {
  draft: ['Draft', 'neutral'], submitted: ['Awaiting approval', 'warn'], approved: ['Approved', 'good'],
  partially_received: ['Part received', 'warn'], received: ['Received', 'good'], closed: ['Closed short', 'neutral'],
  cancelled: ['Cancelled', 'neutral'],
};
const StatusBadge = ({ status }) => <Badge tone={STATUS[status][1]}>{STATUS[status][0]}</Badge>;

export function ProcurementPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.FIN);
  const [unitId, setUnitId] = useSelectedUnit(units, 'procurement.unit');
  const [params, setParams] = useSearchParams();
  const openId = params.get('po');
  const [creating, setCreating] = useState(null); // null | { lines: [...] }
  const list = useLoad(() => (unitId ? api.get(`/api/procurement/${unitId}/purchase-orders`) : Promise.resolve([])), [unitId]);

  if (units.length === 0) return <><PageHeader title="Purchasing" /><div className="card muted">You have no access to purchasing.</div></>;
  const canDraft = unitAccess(me, unitId, 'OPS') === 'write';
  const open = (id) => setParams(id ? { po: id } : {});

  return (
    <>
      <PageHeader title="Purchasing" subtitle="Purchase orders: draft → approve → receive. Receiving puts stock in and sets its cost."
        actions={<UnitPicker units={units} value={unitId} onChange={(id) => { setUnitId(id); open(null); setCreating(null); }} />} />
      {creating && <PurchaseOrderForm unitId={unitId} editId={creating.editId} initialLines={creating.lines} initialSupplier={creating.supplierId}
        onDone={(id) => { setCreating(null); list.reload(); if (id) open(id); }} />}
      {openId && !creating && <PurchaseOrderDetail key={openId} unitId={unitId} id={openId} onClose={() => open(null)} onChanged={list.reload}
        onEdit={(po) => setCreating({ editId: po.id, lines: po.lines, supplierId: po.supplier_id })} />}
      {!creating && !openId && (
        <>
          {canDraft && <ReorderSuggestions unitId={unitId} onDraft={(lines, supplierId) => setCreating({ lines, supplierId })} />}
          <section className="card">
            <div className="row spread">
              <h2>Purchase orders</h2>
              {canDraft && <button className="primary" onClick={() => setCreating({ lines: [] })}>+ New purchase order</button>}
            </div>
            <ErrorNote error={list.error} />
            {list.data?.length === 0 && <p className="muted">No purchase orders yet.</p>}
            {list.data?.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Number</th><th>Supplier</th><th>Status</th><th className="num">Total</th><th>Raised</th><th /></tr></thead>
                  <tbody>
                    {list.data.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{p.po_number}</strong><div className="muted small">{p.line_count} line{p.line_count === 1 ? '' : 's'}</div></td>
                        <td>{p.supplier_name}</td>
                        <td><StatusBadge status={p.status} /></td>
                        <td className="num">{formatMoney(p.total)}</td>
                        <td className="small">{formatDateTime(p.created_at)}<div className="muted">{p.created_by_name}</div></td>
                        <td><button className="link" onClick={() => open(p.id)}>Open</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function ReorderSuggestions({ unitId, onDraft }) {
  const s = useLoad(() => api.get(`/api/procurement/${unitId}/reorder-suggestions`), [unitId]);
  if (!s.data?.length) return null;
  return (
    <section className="card warn-card">
      <div className="row spread wrap">
        <h2>Low stock: {s.data.length} item{s.data.length === 1 ? '' : 's'} to reorder</h2>
        <button className="secondary" onClick={() => onDraft(
          s.data.map((x) => ({ item_id: x.item_id, qty_ordered: x.suggested_qty, unit_cost: x.last_unit_cost ?? '' })),
          s.data.find((x) => x.last_supplier_id)?.last_supplier_id)}>Draft an order for these</button>
      </div>
      <ul className="plain small">
        {s.data.map((x) => (
          <li key={x.item_id}><strong>{x.item_name}</strong>: {formatQty(x.on_hand)} {x.uom} left (reorder at {formatQty(x.reorder_level)}) · suggest {formatQty(x.suggested_qty)}
            {x.last_unit_cost && <span className="muted"> · last bought at {formatMoney(x.last_unit_cost)} from {x.last_supplier_name}</span>}</li>
        ))}
      </ul>
    </section>
  );
}

function PurchaseOrderForm({ unitId, initialLines, initialSupplier, onDone, editId }) {
  const items = useLoad(() => api.get(`/api/catalog/items?businessUnitId=${unitId}`), [unitId]);
  const suppliers = useLoad(() => api.get('/api/suppliers'));
  const blank = { itemId: '', qty: '', unitCost: '' };
  const [supplierId, setSupplierId] = useState(initialSupplier ?? '');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState(initialLines?.length
    ? initialLines.map((l) => ({ itemId: l.item_id, qty: String(Number(l.qty_ordered)), unitCost: l.unit_cost === '' || l.unit_cost == null ? '' : String(Number(l.unit_cost)) }))
    : [blank]);
  const [error, setError] = useState(null);
  const stockItems = items.data?.filter((i) => i.enabled_in_unit && i.is_stockable) ?? [];
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  const save = async (submit) => {
    setError(null);
    try {
      const body = {
        supplierId, expectedDate: expectedDate || null, notes,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitCost: Number(l.unitCost) })),
      };
      const { id } = editId
        ? await api.put(`/api/procurement/${unitId}/purchase-orders/${editId}`, body)
        : await api.post(`/api/procurement/${unitId}/purchase-orders`, body);
      if (submit) await api.post(`/api/procurement/${unitId}/purchase-orders/${id}/submit`);
      onDone(id);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section className="card">
      <h2>{editId ? 'Edit draft' : 'New purchase order'}</h2>
      <div className="form-grid">
        <label>Supplier
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
            <option value="">Choose…</option>
            {suppliers.data?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Expected delivery<input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></label>
        <label className="full">Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      <table>
        <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Unit cost</th><th className="num">Line total</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select value={l.itemId} onChange={(e) => setLine(i, 'itemId', e.target.value)}>
                  <option value="">Choose item…</option>
                  {stockItems.map((it) => <option key={it.id} value={it.id}>{it.name} ({it.base_uom})</option>)}
                </select>
              </td>
              <td><input className="num-input" type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} /></td>
              <td><input className="num-input" type="number" min="0" step="any" value={l.unitCost} onChange={(e) => setLine(i, 'unitCost', e.target.value)} /></td>
              <td className="num">{formatMoney((Number(l.qty) || 0) * (Number(l.unitCost) || 0))}</td>
              <td>{lines.length > 1 && <button className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td><button className="link" onClick={() => setLines([...lines, blank])}>+ Add line</button></td><td /><th className="num">Total</th><th className="num">{formatMoney(total)}</th><td /></tr></tfoot>
      </table>
      <ErrorNote error={error} />
      <div className="row">
        <button className="primary" onClick={() => save(true)}>Save and submit for approval</button>
        <button className="secondary" onClick={() => save(false)}>Save draft</button>
        <button className="link" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </section>
  );
}

function PurchaseOrderDetail({ unitId, id, onClose, onChanged, onEdit }) {
  const { me } = useSession();
  const po = useLoad(() => api.get(`/api/procurement/${unitId}/purchase-orders/${id}`), [unitId, id]);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [receiving, setReceiving] = useState(false);

  if (po.error) return <ErrorNote error={po.error} />;
  if (!po.data) return <p className="muted">Loading…</p>;
  const p = po.data;
  const isManager = unitAccess(me, unitId, 'CFG') === 'write';
  const canDraft = unitAccess(me, unitId, 'OPS') === 'write';
  const act = async (action, body) => {
    setError(null);
    try {
      await api.post(`/api/procurement/${unitId}/purchase-orders/${id}/${action}`, body);
      setNote('');
      po.reload();
      onChanged();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <div className="row"><button className="link" onClick={onClose}>← All purchase orders</button></div>
      <section className="card">
        <div className="row spread wrap">
          <div>
            <h2>{p.po_number} <StatusBadge status={p.status} /></h2>
            <div className="small">{p.supplier_name}{p.expected_date ? ` · expected ${p.expected_date}` : ''}</div>
            <div className="muted small">
              Raised by {p.created_by_name} {formatDateTime(p.created_at)}
              {p.submitted_by_name && ` · submitted by ${p.submitted_by_name}`}
              {p.approved_by_name && ` · approved by ${p.approved_by_name} ${formatDateTime(p.approved_at)}`}
              {p.closed_by_name && ` · ${p.status === 'cancelled' ? 'cancelled' : 'closed'} by ${p.closed_by_name}${p.close_reason ? `: ${p.close_reason}` : ''}`}
            </div>
            {p.notes && <p className="small">{p.notes}</p>}
            {p.rejection_note && p.status === 'draft' && <div className="notice">Sent back: {p.rejection_note}</div>}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Unit cost</th><th className="num">Total</th></tr></thead>
            <tbody>
              {p.lines.map((l) => (
                <tr key={l.id}>
                  <td className="muted small">{l.line_no}</td>
                  <td>{l.item_name} <span className="muted small">{l.sku}</span></td>
                  <td className="num">{formatQty(l.qty_ordered)} {l.uom}</td>
                  <td className="num">{formatQty(l.qty_received)}</td>
                  <td className="num">{formatMoney(l.unit_cost)}</td>
                  <td className="num">{formatMoney(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={5} className="num"><strong>Total</strong></td><td className="num"><strong>{formatMoney(p.total)}</strong></td></tr></tfoot>
          </table>
        </div>
        <ErrorNote error={error} />
        <div className="row wrap">
          {p.status === 'draft' && canDraft && <>
            <button className="primary" onClick={() => act('submit')}>Submit for approval</button>
            <button className="secondary" onClick={() => onEdit(p)}>Edit</button>
          </>}
          {p.status === 'submitted' && isManager && <>
            <button className="primary" onClick={() => act('approve')}>Approve</button>
            <input placeholder="Reason for sending back" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="secondary" onClick={() => act('reject', { note })}>Send back</button>
          </>}
          {['approved', 'partially_received'].includes(p.status) && canDraft && !receiving &&
            <button className="primary" onClick={() => setReceiving(true)}>Receive goods</button>}
          {p.status === 'partially_received' && isManager && <>
            <input placeholder="Reason for closing short" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="secondary" onClick={() => act('close', { note })}>Close short</button>
          </>}
          {['draft', 'submitted', 'approved'].includes(p.status) && (isManager || (canDraft && p.status !== 'approved')) &&
            <button className="danger" onClick={() => act('cancel', { note: note || null })}>Cancel order</button>}
        </div>
      </section>
      {receiving && <ReceiveForm unitId={unitId} po={p} onDone={() => { setReceiving(false); po.reload(); onChanged(); }} onCancel={() => setReceiving(false)} />}
      {p.receipts.length > 0 && (
        <section className="card">
          <h2>Deliveries</h2>
          {p.receipts.map((r) => (
            <div key={r.id} className="receipt">
              <strong>{r.receipt_number}</strong> · {formatDateTime(r.received_at)} · {r.received_by_name} · into {r.location_name}
              {r.supplier_invoice_ref && <> · invoice {r.supplier_invoice_ref}</>}
              <ul className="plain small">{r.lines.map((l, i) => <li key={i}>{l.item_name}: {formatQty(l.qty)}{l.batch_no ? ` · batch ${l.batch_no}` : ''}{l.expiry_date ? ` · exp ${l.expiry_date}` : ''}</li>)}</ul>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function ReceiveForm({ unitId, po, onDone, onCancel }) {
  const locations = useLoad(() => api.get(`/api/inventory/${unitId}/locations`), [unitId]);
  const outstanding = po.lines.filter((l) => Number(l.qty_received) < Number(l.qty_ordered));
  const [locationId, setLocationId] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [rows, setRows] = useState(outstanding.map((l) => ({
    poLineId: l.id, qty: String(Number(l.qty_ordered) - Number(l.qty_received)), batchNo: '', expiryDate: '' })));
  const [error, setError] = useState(null);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const submit = async () => {
    setError(null);
    try {
      await api.post(`/api/procurement/${unitId}/purchase-orders/${po.id}/receive`, {
        locationId, supplierInvoiceRef: invoiceRef || null,
        lines: rows.map((r) => ({ poLineId: r.poLineId, qty: Number(r.qty) || 0, batchNo: r.batchNo || null, expiryDate: r.expiryDate || null })),
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section className="card">
      <h2>Receive goods</h2>
      <div className="form-grid">
        <label>Into
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
            <option value="">Choose a store…</option>
            {locations.data?.filter((l) => l.is_active && l.tier !== 'staff').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>Supplier invoice / delivery note<input value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} /></label>
      </div>
      <table>
        <thead><tr><th>Item</th><th className="num">Outstanding</th><th className="num">Received now</th><th>Batch</th><th>Expiry</th></tr></thead>
        <tbody>
          {outstanding.map((l, i) => (
            <tr key={l.id}>
              <td>{l.item_name}</td>
              <td className="num">{formatQty(Number(l.qty_ordered) - Number(l.qty_received))}</td>
              <td><input className="num-input" type="number" min="0" step="any" value={rows[i].qty} onChange={(e) => set(i, 'qty', e.target.value)} /></td>
              <td>{l.is_batch_tracked ? <input value={rows[i].batchNo} onChange={(e) => set(i, 'batchNo', e.target.value)} placeholder="Batch no." /> : <span className="muted">—</span>}</td>
              <td>{l.is_expiry_tracked ? <input type="date" value={rows[i].expiryDate} onChange={(e) => set(i, 'expiryDate', e.target.value)} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Enter 0 for anything not delivered. You can receive the rest later.</p>
      <ErrorNote error={error} />
      <div className="row"><button className="primary" onClick={submit}>Record delivery</button><button className="link" onClick={onCancel}>Cancel</button></div>
    </section>
  );
}
