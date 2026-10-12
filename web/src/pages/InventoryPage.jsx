import { Fragment, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { Tabs, UnitPicker, formatMoney, formatQty, useSelectedUnit, useUnitChoices } from '../components/UnitPicker.jsx';

const MOVEMENT_LABELS = {
  opening_balance: 'Opening balance', adjustment_in: 'Adjustment in', adjustment_out: 'Adjustment out',
  transfer: 'Transfer', issue: 'Issue', wastage: 'Wastage',
  receipt: 'Purchase receipt', inter_unit_out: 'Sent to another unit', inter_unit_in: 'Received from another unit',
};
const MANUAL_TYPES = ['opening_balance', 'adjustment_in', 'adjustment_out', 'transfer', 'issue', 'wastage'];
const TIER_LABELS = { branch: 'Branch store', department: 'Department store', staff: 'Staff holding' };

export function InventoryPage() {
  const { me } = useSession();
  const units = useUnitChoices('OPS');
  const [unitId, setUnitId] = useSelectedUnit(units, 'inventory.unit');
  const [tab, setTab] = useState('stock');

  if (units.length === 0) {
    return <><PageHeader title="Inventory" /><div className="card muted">You have no access to stock in any unit.</div></>;
  }
  const canMove = unitAccess(me, unitId, 'OPS') === 'write';
  const canConfigure = unitAccess(me, unitId, 'CFG') === 'write';
  const canSeeValue = Boolean(unitAccess(me, unitId, 'FIN'));

  return (
    <>
      <PageHeader title="Inventory" subtitle="Stock held at branch stores, department stores and by staff."
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      <Tabs value={tab} onChange={setTab} tabs={[
        ['stock', 'Stock on hand'], ['move', 'Record movement'], ['ledger', 'Movement history'], ['locations', 'Locations'],
        ...(canSeeValue ? [['value', 'Stock value']] : [])]} />
      {unitId && tab === 'stock' && <StockTab unitId={unitId} />}
      {unitId && tab === 'move' && (canMove
        ? <MovementForm unitId={unitId} canAdjust={canConfigure} onPosted={() => setTab('ledger')} />
        : <div className="card muted">You have read-only access to stock in this unit.</div>)}
      {unitId && tab === 'ledger' && <LedgerTab unitId={unitId} />}
      {unitId && tab === 'locations' && <LocationsTab unitId={unitId} canConfigure={canConfigure} />}
      {unitId && tab === 'value' && canSeeValue && <ValueTab unitId={unitId} />}
    </>
  );
}

function StockTab({ unitId }) {
  const summary = useLoad(() => api.get(`/api/inventory/${unitId}/summary`), [unitId]);
  const expiring = useLoad(() => api.get(`/api/inventory/${unitId}/expiring?days=30`), [unitId]);
  const balances = useLoad(() => api.get(`/api/inventory/${unitId}/balances`), [unitId]);
  const [open, setOpen] = useState(null);

  return (
    <>
      <ErrorNote error={summary.error} />
      {expiring.data?.length > 0 && (
        <section className="card warn-card">
          <h2>Expiring within 30 days</h2>
          <ul className="plain small">
            {expiring.data.map((e) => (
              <li key={`${e.batch_id}-${e.location_id}`}>
                <strong>{e.item_name}</strong> · batch {e.batch_no} · {formatQty(e.qty_on_hand)} at {e.location_name} ·{' '}
                {e.is_expired ? <Badge tone="bad">Expired {e.expiry_date}</Badge> : <Badge tone="warn">Expires {e.expiry_date}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        {summary.data?.length === 0 && <p className="muted">No items are enabled in this unit yet. Enable them from the Catalogue.</p>}
        {summary.data?.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item</th><th className="num">On hand</th><th className="num">Reorder at</th><th>Nearest expiry</th><th /></tr></thead>
              <tbody>
                {summary.data.map((s) => (
                  <Fragment key={s.item_id}>
                    <tr>
                      <td><strong>{s.item_name}</strong><div className="muted small">{s.sku}</div></td>
                      <td className="num">{formatQty(s.on_hand)} {s.uom} {s.is_low && <Badge tone="bad">Low</Badge>}</td>
                      <td className="num">{Number(s.reorder_level) > 0 ? formatQty(s.reorder_level) : '—'}</td>
                      <td>{s.nearest_expiry ?? '—'}</td>
                      <td><button className="link small" onClick={() => setOpen(open === s.item_id ? null : s.item_id)}>{open === s.item_id ? 'Hide' : 'Where?'}</button></td>
                    </tr>
                    {open === s.item_id && (
                      <tr>
                        <td colSpan={5}>
                          <table className="inner">
                            <tbody>
                              {balances.data?.filter((b) => b.item_id === s.item_id).map((b) => (
                                <tr key={`${b.location_id}-${b.batch_id}`}>
                                  <td>{b.location_name} <span className="muted small">· {TIER_LABELS[b.tier]}</span></td>
                                  <td>{b.batch_no ? `Batch ${b.batch_no}` : ''}{b.expiry_date ? ` · exp ${b.expiry_date}` : ''}</td>
                                  <td className="num">{formatQty(b.qty_on_hand)} {b.uom}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function MovementForm({ unitId, canAdjust, onPosted }) {
  const items = useLoad(() => api.get(`/api/catalog/items?businessUnitId=${unitId}`), [unitId]);
  const locations = useLoad(() => api.get(`/api/inventory/${unitId}/locations`), [unitId]);
  const empty = { type: 'transfer', itemId: '', qty: '', fromLocationId: '', toLocationId: '', batchNo: '', expiryDate: '', unitCost: '', reason: '' };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const enabled = items.data?.filter((i) => i.enabled_in_unit && i.is_stockable) ?? [];
  const item = enabled.find((i) => i.id === form.itemId);
  const activeLocations = locations.data?.filter((l) => l.is_active) ?? [];
  const incoming = ['opening_balance', 'adjustment_in'].includes(form.type);
  const needsFrom = !incoming;
  const needsTo = incoming || form.type === 'transfer';
  const types = MANUAL_TYPES.map((k) => [k, MOVEMENT_LABELS[k]])
    .filter(([k]) => canAdjust || !['opening_balance', 'adjustment_in', 'adjustment_out'].includes(k));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/inventory/${unitId}/movements`, {
        type: form.type, itemId: form.itemId, qty: Number(form.qty),
        fromLocationId: needsFrom ? form.fromLocationId : null,
        toLocationId: needsTo ? form.toLocationId : null,
        batchNo: incoming && item?.is_batch_tracked ? form.batchNo : null,
        expiryDate: incoming && item?.is_expiry_tracked ? form.expiryDate : null,
        unitCost: incoming && form.unitCost !== '' ? Number(form.unitCost) : null,
        reason: form.reason || null,
      });
      setForm(empty);
      onPosted();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!items.data || !locations.data) return <p className="muted">Loading…</p>;
  if (activeLocations.length === 0) return <div className="card muted">Set up a stock location first (Locations tab).</div>;

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label>Movement
        <select value={form.type} onChange={set('type')}>{types.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <label>Item
        <select value={form.itemId} onChange={set('itemId')} required>
          <option value="">Choose…</option>
          {enabled.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
        </select>
      </label>
      <label>Quantity{item ? ` (${item.base_uom})` : ''}
        <input type="number" min="0.001" step="any" value={form.qty} onChange={set('qty')} required />
      </label>
      {needsFrom && (
        <label>From
          <select value={form.fromLocationId} onChange={set('fromLocationId')} required>
            <option value="">Choose…</option>
            {activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}
      {needsTo && (
        <label>To
          <select value={form.toLocationId} onChange={set('toLocationId')} required>
            <option value="">Choose…</option>
            {activeLocations.filter((l) => l.id !== form.fromLocationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}
      {incoming && item?.is_batch_tracked && <label>Batch number<input value={form.batchNo} onChange={set('batchNo')} required /></label>}
      {incoming && item?.is_expiry_tracked && <label>Expiry date<input type="date" value={form.expiryDate} onChange={set('expiryDate')} required /></label>}
      {incoming && (
        <label>Unit cost{form.type === 'opening_balance' ? '' : ' (optional)'}
          <input type="number" min="0" step="any" value={form.unitCost} onChange={set('unitCost')} required={form.type === 'opening_balance'} />
        </label>
      )}
      {form.type === 'wastage' ? (
        <label>Reason
          <select value={form.reason} onChange={set('reason')} required>
            <option value="">Choose…</option>
            {['damage', 'expiry', 'theft', 'spillage', 'other'].map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
          </select>
        </label>
      ) : (
        <label>Reason{form.type.startsWith('adjustment') ? '' : ' (optional)'}
          <input value={form.reason} onChange={set('reason')} required={form.type.startsWith('adjustment')} />
        </label>
      )}
      <div className="full">
        {item?.is_batch_tracked && !incoming && <p className="muted small">Stock is taken from the batch closest to expiry first; expired batches are skipped.</p>}
        <ErrorNote error={error} />
        <button className="primary" disabled={busy}>{busy ? 'Recording…' : 'Record movement'}</button>
      </div>
    </form>
  );
}

function LedgerTab({ unitId }) {
  const moves = useLoad(() => api.get(`/api/inventory/${unitId}/movements?limit=100`), [unitId]);
  return (
    <section className="card">
      <ErrorNote error={moves.error} />
      {moves.data?.length === 0 && <p className="muted">No stock movements yet.</p>}
      {moves.data?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>When</th><th>Type</th><th>Item</th><th className="num">Qty</th><th>From → To</th><th className="num">Unit cost</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>
              {moves.data.map((m) => (
                <tr key={m.id}>
                  <td className="muted small">{m.id}</td>
                  <td className="small">{formatDateTime(m.posted_at)}</td>
                  <td>{MOVEMENT_LABELS[m.movement_type]}</td>
                  <td>{m.item_name}{m.batch_no && <div className="muted small">Batch {m.batch_no}</div>}</td>
                  <td className="num">{formatQty(m.qty)}</td>
                  <td className="small">{m.from_location_name ?? '—'} → {m.to_location_name ?? '—'}</td>
                  <td className="num small">{m.unit_cost === null ? '—' : formatMoney(m.unit_cost)}</td>
                  <td className="small">{m.reason ?? ''}</td>
                  <td className="small">{m.posted_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LocationsTab({ unitId, canConfigure }) {
  const locations = useLoad(() => api.get(`/api/inventory/${unitId}/locations`), [unitId]);
  const org = useLoad(() => api.get('/api/org'));
  const users = useLoad(() => api.get('/api/users').catch(() => []));
  const empty = { tier: 'branch', name: '', branchId: '', departmentId: '', staffUserId: '', parentLocationId: '' };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  if (!locations.data || !org.data) return <p className="muted">Loading…</p>;
  const byParent = (parentId) => locations.data.filter((l) => (l.parent_location_id ?? null) === parentId);
  const parentTier = form.tier === 'department' ? 'branch' : form.tier === 'staff' ? 'department' : null;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const parent = locations.data.find((l) => l.id === form.parentLocationId);
      await api.post(`/api/inventory/${unitId}/locations`, {
        tier: form.tier, name: form.name,
        branchId: parent ? parent.branch_id : form.branchId,
        departmentId: form.tier === 'department' ? form.departmentId : null,
        staffUserId: form.tier === 'staff' ? form.staffUserId : null,
        parentLocationId: parentTier ? form.parentLocationId : null,
      });
      setForm(empty);
      locations.reload();
    } catch (err) {
      setError(err);
    }
  };

  const renderTree = (parentId, depth) => byParent(parentId).map((l) => (
    <div key={l.id}>
      <div className="tree-row" style={{ paddingLeft: depth * 22 }}>
        <strong>{l.name}</strong> <span className="muted small">· {TIER_LABELS[l.tier]}{l.department_name ? ` · ${l.department_name}` : ''}{l.staff_name ? ` · ${l.staff_name}` : ''}</span>
        {!l.is_active && <Badge>Inactive</Badge>}
      </div>
      {renderTree(l.id, depth + 1)}
    </div>
  ));

  return (
    <>
      <section className="card">
        {locations.data.length === 0 ? <p className="muted">No stock locations yet.</p> : renderTree(null, 0)}
      </section>
      {canConfigure && (
        <form className="card form-grid" onSubmit={submit}>
          <h2 className="full">Add a location</h2>
          <label>Level
            <select value={form.tier} onChange={(e) => setForm({ ...empty, tier: e.target.value })}>
              {Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Name<input value={form.name} onChange={set('name')} required /></label>
          {form.tier === 'branch' && (
            <label>Branch
              <select value={form.branchId} onChange={set('branchId')} required>
                <option value="">Choose…</option>
                {org.data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          {parentTier && (
            <label>Inside
              <select value={form.parentLocationId} onChange={set('parentLocationId')} required>
                <option value="">Choose…</option>
                {locations.data.filter((l) => l.tier === parentTier).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
          {form.tier === 'department' && (
            <label>Department
              <select value={form.departmentId} onChange={set('departmentId')} required>
                <option value="">Choose…</option>
                {org.data.departments.filter((d) => d.business_unit_id === unitId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          {form.tier === 'staff' && (
            <label>Staff member
              <select value={form.staffUserId} onChange={set('staffUserId')} required>
                <option value="">Choose…</option>
                {(users.data ?? []).filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
          )}
          <div className="full"><ErrorNote error={error} /><button className="primary">Add location</button></div>
        </form>
      )}
    </>
  );
}

function ValueTab({ unitId }) {
  const rows = useLoad(() => api.get(`/api/inventory/${unitId}/valuation`), [unitId]);
  const total = (rows.data ?? []).reduce((s, r) => s + Number(r.stock_value), 0);
  return (
    <section className="card">
      <ErrorNote error={rows.error} />
      <p className="muted small">Valued at moving average cost: each purchase receipt re-averages the cost of what is in stock.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th className="num">On hand</th><th className="num">Average cost</th><th className="num">Value</th></tr></thead>
          <tbody>
            {rows.data?.map((r) => (
              <tr key={r.item_id}>
                <td>{r.item_name} <span className="muted small">{r.sku}</span></td>
                <td className="num">{formatQty(r.on_hand)} {r.uom}</td>
                <td className="num">{formatMoney(r.avg_unit_cost)}</td>
                <td className="num">{formatMoney(r.stock_value)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={3} className="num"><strong>Total stock value</strong></td><td className="num"><strong>{formatMoney(total)}</strong></td></tr></tfoot>
        </table>
      </div>
    </section>
  );
}
