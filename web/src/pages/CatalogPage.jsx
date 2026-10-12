import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { hasTenantPermission, unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader } from '../components/ui.jsx';
import { UnitPicker, formatMoney, formatQty, useSelectedUnit } from '../components/UnitPicker.jsx';

export function CatalogPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.CFG || s.access.OPS);
  const [unitId, setUnitId] = useSelectedUnit(units, 'catalog.unit');
  const [q, setQ] = useState('');
  const items = useLoad(() => api.get(`/api/catalog/items?includeInactive=true${unitId ? `&businessUnitId=${unitId}` : ''}`), [unitId]);
  const vocab = useLoad(() => api.get('/api/catalog'));
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  const canConfigureUnit = unitAccess(me, unitId, 'CFG') === 'write';
  const unit = me.scope.find((s) => s.business_unit_id === unitId);
  const shown = (items.data ?? []).filter((i) =>
    !q || i.name.toLowerCase().includes(q.toLowerCase()) || i.sku.toLowerCase().startsWith(q.toLowerCase()));

  const saveUnit = async (item, values) => {
    setError(null);
    try {
      await api.put(`/api/catalog/items/${item.id}/units/${unitId}`, values);
      setEditing(null);
      items.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader title="Catalogue" subtitle="Items shared across the group, with prices and reorder levels set per unit."
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      <ErrorNote error={error ?? items.error} />
      {vocab.data && <NewItem vocab={vocab.data} onCreated={items.reload} onVocabChanged={vocab.reload} />}

      <section className="card">
        <div className="row spread wrap">
          <h2>Items{unit ? ` · settings for ${unit.name}` : ''}</h2>
          <input placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Item</th><th>Owned by</th><th>Tracking</th><th>In this unit</th><th className="num">Price</th><th className="num">Reorder at</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                editing === i.id
                  ? <UnitSettingsRow key={i.id} item={i} onCancel={() => setEditing(null)} onSave={(v) => saveUnit(i, v)} />
                  : (
                    <tr key={i.id} className={i.is_active ? '' : 'dim'}>
                      <td><strong>{i.name}</strong><div className="muted small">{i.sku} · {i.base_uom}{i.category_name ? ` · ${i.category_name}` : ''}</div></td>
                      <td className="small">{i.owner_business_unit_name ?? 'Group'}</td>
                      <td>
                        {i.is_expiry_tracked ? <Badge tone="warn">Batch + expiry</Badge> : i.is_batch_tracked ? <Badge>Batch</Badge> : null}
                        {!i.is_stockable && <Badge>Service</Badge>}
                      </td>
                      <td>{i.enabled_in_unit ? <Badge tone="good">Enabled</Badge> : <span className="muted small">—</span>}</td>
                      <td className="num">{i.sell_price != null ? formatMoney(i.sell_price) : '—'}</td>
                      <td className="num">{i.reorder_level != null && Number(i.reorder_level) > 0 ? formatQty(i.reorder_level) : '—'}</td>
                      <td>{canConfigureUnit && <button className="link" onClick={() => setEditing(i.id)}>{i.enabled_in_unit ? 'Edit' : 'Enable'}</button>}</td>
                    </tr>
                  )
              ))}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && <p className="muted">No items yet.</p>}
      </section>
    </>
  );
}

function UnitSettingsRow({ item, onSave, onCancel }) {
  const [v, setV] = useState({
    sellPrice: item.sell_price ?? '', reorderLevel: item.reorder_level ?? 0, reorderQty: item.reorder_qty ?? 0,
    isActive: item.enabled_in_unit ?? true,
  });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <tr className="editing">
      <td><strong>{item.name}</strong></td>
      <td colSpan={2} />
      <td><label className="inline"><input type="checkbox" checked={v.isActive} onChange={set('isActive')} /> Enabled</label></td>
      <td><input type="number" min="0" step="any" placeholder="No price" value={v.sellPrice} onChange={set('sellPrice')} /></td>
      <td><input type="number" min="0" step="any" value={v.reorderLevel} onChange={set('reorderLevel')} /></td>
      <td className="actions-cell">
        <button className="primary small-btn" onClick={() => onSave({
          sellPrice: v.sellPrice === '' ? null : Number(v.sellPrice),
          reorderLevel: Number(v.reorderLevel), reorderQty: Number(v.reorderQty), isActive: v.isActive,
        })}>Save</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </td>
    </tr>
  );
}

function NewItem({ vocab, onCreated, onVocabChanged }) {
  const { me } = useSession();
  const owners = [
    ...(hasTenantPermission(me, 'tenant.settings') ? [{ id: '', name: 'Group (all units)' }] : []),
    ...me.scope.filter((s) => s.access.CFG === 'write').map((s) => ({ id: s.business_unit_id, name: s.name })),
  ];
  const empty = { sku: '', name: '', baseUomId: '', categoryId: '', ownerBusinessUnitId: owners[0]?.id ?? '', tracking: 'none', isSellable: true, isStockable: true };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [newUom, setNewUom] = useState({ code: '', name: '' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  if (owners.length === 0) return null;
  if (!open) return <div className="row"><button className="secondary" onClick={() => setOpen(true)}>+ New item</button></div>;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/catalog/items', {
        sku: form.sku, name: form.name, baseUomId: form.baseUomId, categoryId: form.categoryId || null,
        ownerBusinessUnitId: form.ownerBusinessUnitId || null, isSellable: form.isSellable, isStockable: form.isStockable,
        isBatchTracked: form.tracking !== 'none', isExpiryTracked: form.tracking === 'expiry',
      });
      setForm(empty);
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err);
    }
  };

  const addUom = async () => {
    setError(null);
    try {
      const uom = await api.post('/api/catalog/uoms', newUom);
      setNewUom({ code: '', name: '' });
      await onVocabChanged();
      setForm((f) => ({ ...f, baseUomId: uom.id }));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="card form-grid" onSubmit={submit}>
      <h2 className="full">New item</h2>
      <label>SKU<input value={form.sku} onChange={set('sku')} placeholder="e.g. WATER-75CL" required /></label>
      <label>Name<input value={form.name} onChange={set('name')} required /></label>
      <label>Owned by
        <select value={form.ownerBusinessUnitId} onChange={set('ownerBusinessUnitId')}>
          {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label>Unit of measure
        <select value={form.baseUomId} onChange={set('baseUomId')} required>
          <option value="">Choose…</option>
          {vocab.uoms.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}
        </select>
      </label>
      <label>Tracking
        <select value={form.tracking} onChange={set('tracking')}>
          <option value="none">Quantity only</option>
          <option value="batch">Batch numbers</option>
          <option value="expiry">Batch numbers and expiry dates</option>
        </select>
      </label>
      <div className="checks">
        <label className="inline"><input type="checkbox" checked={form.isStockable} onChange={set('isStockable')} /> Kept in stock</label>
        <label className="inline"><input type="checkbox" checked={form.isSellable} onChange={set('isSellable')} /> Sold to customers</label>
      </div>
      <div className="full row wrap muted small">
        Missing a unit of measure?
        <input placeholder="code, e.g. crate" value={newUom.code} onChange={(e) => setNewUom({ ...newUom, code: e.target.value })} />
        <input placeholder="name, e.g. Crate" value={newUom.name} onChange={(e) => setNewUom({ ...newUom, name: e.target.value })} />
        <button type="button" className="secondary small-btn" onClick={addUom} disabled={!newUom.code || !newUom.name}>Add</button>
      </div>
      <p className="full muted small">Tracking cannot be changed once the item is created.</p>
      <div className="full row">
        <ErrorNote error={error} />
        <button className="primary">Create item</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
