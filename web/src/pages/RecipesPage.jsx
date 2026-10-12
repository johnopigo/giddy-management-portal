import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader } from '../components/ui.jsx';
import { UnitPicker, formatMoney, formatQty, useSelectedUnit } from '../components/UnitPicker.jsx';

export function RecipesPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.OPS || s.access.CFG);
  const [unitId, setUnitId] = useSelectedUnit(units, 'recipes.unit');
  const recipes = useLoad(() => (unitId ? api.get(`/api/recipes/${unitId}`) : Promise.resolve([])), [unitId]);
  const [editing, setEditing] = useState(null); // null | 'new' | recipe
  const canEdit = unitAccess(me, unitId, 'CFG') === 'write';

  return (
    <>
      <PageHeader title="Recipes" subtitle="What each dish or drink is made of. Selling a made-to-order item deducts its ingredients."
        actions={<UnitPicker units={units} value={unitId} onChange={(id) => { setUnitId(id); setEditing(null); }} />} />
      {editing && <RecipeEditor unitId={unitId} recipe={editing === 'new' ? null : editing}
        onDone={() => { setEditing(null); recipes.reload(); }} />}
      {!editing && canEdit && <div className="row"><button className="primary" onClick={() => setEditing('new')}>+ New recipe</button></div>}
      <ErrorNote error={recipes.error} />
      {recipes.data?.length === 0 && <div className="card muted">No recipes yet.</div>}
      <div className="grid-2">
        {recipes.data?.map((r) => (
          <section key={r.id} className={`card ${r.is_active ? '' : 'dim'}`}>
            <div className="row spread">
              <div>
                <h2>{r.output_name}</h2>
                <div className="muted small">
                  {r.output_is_stockable ? 'Prepared in batches (production)' : 'Made to order'} · makes {formatQty(r.yield_qty)} {r.output_uom}
                  {!r.is_active && ' · inactive'}
                </div>
              </div>
              {canEdit && <button className="link" onClick={() => setEditing(r)}>Edit</button>}
            </div>
            <ul className="plain small">
              {r.lines?.map((l) => <li key={l.item_id}>{formatQty(l.qty)} {l.uom} {l.name}{l.avg_cost != null && <span className="muted"> · {formatMoney(Number(l.avg_cost) * Number(l.qty))}</span>}</li>)}
            </ul>
            {r.unit_cost != null && (
              <div className="row wrap small">
                <span>Cost per {r.output_uom}: <strong>{formatMoney(r.unit_cost)}</strong></span>
                {r.sell_price != null && <span>Price: {formatMoney(r.sell_price)}</span>}
                {r.margin_pct != null && <Badge tone={r.margin_pct >= 60 ? 'good' : r.margin_pct >= 30 ? 'warn' : 'bad'}>{r.margin_pct}% margin</Badge>}
              </div>
            )}
            {r.notes && <p className="small muted prewrap">{r.notes}</p>}
          </section>
        ))}
      </div>
    </>
  );
}

function RecipeEditor({ unitId, recipe, onDone }) {
  const items = useLoad(() => api.get(`/api/catalog/items?businessUnitId=${unitId}`), [unitId]);
  const [outputId, setOutputId] = useState(recipe?.output_item_id ?? '');
  const [yieldQty, setYieldQty] = useState(String(Number(recipe?.yield_qty ?? 1)));
  const [notes, setNotes] = useState(recipe?.notes ?? '');
  const [active, setActive] = useState(recipe?.is_active ?? true);
  const [lines, setLines] = useState(recipe?.lines?.map((l) => ({ itemId: l.item_id, qty: String(Number(l.qty)) })) ?? [{ itemId: '', qty: '' }]);
  const [error, setError] = useState(null);
  const enabled = items.data?.filter((i) => i.enabled_in_unit) ?? [];
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  const save = async () => {
    setError(null);
    try {
      await api.put(`/api/recipes/${unitId}/${outputId}`, {
        yieldQty: Number(yieldQty), notes, isActive: active,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section className="card">
      <h2>{recipe ? `Edit recipe: ${recipe.output_name}` : 'New recipe'}</h2>
      <div className="form-grid">
        <label>Dish or drink
          <select value={outputId} onChange={(e) => setOutputId(e.target.value)} disabled={Boolean(recipe)}>
            <option value="">Choose…</option>
            {enabled.filter((i) => i.is_sellable || i.is_stockable).map((i) => <option key={i.id} value={i.id}>{i.name}{i.is_stockable ? ' (batch-prepared)' : ''}</option>)}
          </select>
        </label>
        <label>Makes (quantity)<input type="number" min="0.001" step="any" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} /></label>
        <label className="inline"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      </div>
      <h3>Ingredients (in each ingredient's unit)</h3>
      {lines.map((l, i) => (
        <div key={i} className="row">
          <select className="grow" value={l.itemId} onChange={(e) => setLine(i, 'itemId', e.target.value)}>
            <option value="">Choose ingredient…</option>
            {enabled.filter((it) => it.is_stockable && it.id !== outputId).map((it) => <option key={it.id} value={it.id}>{it.name} ({it.base_uom})</option>)}
          </select>
          <input className="num-input" type="number" min="0" step="any" placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} />
          {lines.length > 1 && <button className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      <button className="link" onClick={() => setLines([...lines, { itemId: '', qty: '' }])}>+ Add ingredient</button>
      <label>Method / notes<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <ErrorNote error={error} />
      <div className="row"><button className="primary" onClick={save} disabled={!outputId}>Save recipe</button><button className="link" onClick={onDone}>Cancel</button></div>
    </section>
  );
}
