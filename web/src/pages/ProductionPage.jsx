import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { UnitPicker, formatMoney, formatQty, useSelectedUnit } from '../components/UnitPicker.jsx';

const STATUS = { planned: ['Planned', 'warn'], completed: ['Completed', 'good'], cancelled: ['Cancelled', 'neutral'] };

export function ProductionPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.OPS);
  const [unitId, setUnitId] = useSelectedUnit(units, 'production.unit');
  const orders = useLoad(() => (unitId ? api.get(`/api/production/${unitId}`) : Promise.resolve([])), [unitId]);
  const [planning, setPlanning] = useState(false);
  const canWork = unitAccess(me, unitId, 'OPS') === 'write';
  const done = orders.data?.filter((o) => o.status === 'completed') ?? [];
  const avgVariance = done.length ? done.reduce((s, o) => s + Number(o.yield_variance_pct), 0) / done.length : null;

  return (
    <>
      <PageHeader title="Production" subtitle="Prepare batches ahead of service. Ingredients come out of one store and the finished item goes into another."
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      {canWork && !planning && <div className="row"><button className="primary" onClick={() => setPlanning(true)}>+ Plan a batch</button></div>}
      {planning && <PlanForm unitId={unitId} onDone={() => { setPlanning(false); orders.reload(); }} />}
      {avgVariance !== null && (
        <div className="stat-row">
          <div className="stat"><span className="muted small">Batches completed</span><strong>{done.length}</strong></div>
          <div className="stat"><span className="muted small">Average yield variance</span><strong>{avgVariance > 0 ? '+' : ''}{avgVariance.toFixed(1)}%</strong></div>
        </div>
      )}
      <ErrorNote error={orders.error} />
      {orders.data?.length === 0 && <div className="card muted">No production yet.</div>}
      {orders.data?.map((o) => <OrderCard key={o.id} unitId={unitId} o={o} canWork={canWork} onChanged={orders.reload} />)}
    </>
  );
}

function OrderCard({ unitId, o, canWork, onChanged }) {
  const [completing, setCompleting] = useState(false);
  const [output, setOutput] = useState(String(Number(o.planned_output_qty)));
  const [actuals, setActuals] = useState(Object.fromEntries((o.lines ?? []).map((l) => [l.id, String(Number(l.planned_qty))])));
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState(null);
  const act = async (path, body) => {
    setError(null);
    try {
      await api.post(`/api/production/${unitId}/${o.id}/${path}`, body);
      setCompleting(false);
      onChanged();
    } catch (err) {
      setError(err);
    }
  };
  const variance = o.yield_variance_pct != null ? Number(o.yield_variance_pct) : null;

  return (
    <section className="card">
      <div className="row spread wrap">
        <div>
          <h2>{o.order_number}: {o.output_name} <Badge tone={STATUS[o.status][1]}>{STATUS[o.status][0]}</Badge></h2>
          <div className="small">{o.from_location_name} → {o.to_location_name}{o.planned_for ? ` · for ${o.planned_for}` : ''}</div>
          <div className="muted small">Planned by {o.created_by_name} {formatDateTime(o.created_at)}{o.completed_by_name ? ` · completed by ${o.completed_by_name} ${formatDateTime(o.completed_at)}` : ''}</div>
        </div>
        <div className="num">
          <div>Planned <strong>{formatQty(o.planned_output_qty)} {o.output_uom}</strong></div>
          {o.actual_output_qty != null && <div>Made <strong>{formatQty(o.actual_output_qty)}</strong>{' '}
            <Badge tone={variance >= 0 ? 'good' : variance > -5 ? 'warn' : 'bad'}>{variance > 0 ? '+' : ''}{variance}%</Badge></div>}
          {o.output_unit_cost != null && <div className="small muted">{formatMoney(o.output_unit_cost)} per {o.output_uom} · inputs {formatMoney(o.input_cost)}</div>}
        </div>
      </div>
      <table>
        <thead><tr><th>Ingredient</th><th className="num">Planned</th><th className="num">Used</th>{o.lines?.some((l) => l.cost_amount != null) && <th className="num">Cost</th>}</tr></thead>
        <tbody>
          {o.lines?.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td className="num">{formatQty(l.planned_qty)} {l.uom}</td>
              <td className="num">
                {completing
                  ? <input className="num-input" type="number" min="0" step="any" value={actuals[l.id]} onChange={(e) => setActuals({ ...actuals, [l.id]: e.target.value })} aria-label={`${l.name} used`} />
                  : l.actual_qty != null ? formatQty(l.actual_qty) : '—'}
              </td>
              {l.cost_amount != null && <td className="num">{formatMoney(l.cost_amount)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorNote error={error} />
      {o.status === 'planned' && canWork && !completing && (
        <div className="row"><button className="primary" onClick={() => setCompleting(true)}>Record what was made</button>
          <button className="link" onClick={() => act('cancel')}>Cancel batch</button></div>
      )}
      {completing && (
        <div className="row wrap">
          <label>Quantity made ({o.output_uom})<input type="number" min="0" step="any" value={output} onChange={(e) => setOutput(e.target.value)} /></label>
          <label>Use by (optional)<input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
          <button className="primary align-end" onClick={() => act('complete', {
            actualOutput: Number(output), expiryDate: expiry || null,
            lines: Object.entries(actuals).map(([lineId, q]) => ({ lineId, actualQty: Number(q) || 0 })) })}>Complete batch</button>
          <button className="link align-end" onClick={() => setCompleting(false)}>Back</button>
        </div>
      )}
    </section>
  );
}

function PlanForm({ unitId, onDone }) {
  const recipes = useLoad(() => api.get(`/api/recipes/${unitId}`), [unitId]);
  const locations = useLoad(() => api.get(`/api/inventory/${unitId}/locations`), [unitId]);
  const [recipeId, setRecipeId] = useState('');
  const [qty, setQty] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [plannedFor, setPlannedFor] = useState('');
  const [error, setError] = useState(null);
  const batchRecipes = recipes.data?.filter((r) => r.is_active && r.output_is_stockable) ?? [];
  const recipe = batchRecipes.find((r) => r.id === recipeId);
  const active = locations.data?.filter((l) => l.is_active) ?? [];

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/api/production/${unitId}`, { recipeId, plannedQty: Number(qty), fromLocationId: fromId, toLocationId: toId, plannedFor: plannedFor || null });
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Plan a batch</h2>
      {batchRecipes.length === 0 && <p className="muted small">No batch recipes yet. A batch recipe makes a stock item (e.g. portions of jollof rice); made-to-order drinks are deducted at the till instead.</p>}
      <div className="form-grid">
        <label>Recipe
          <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)} required>
            <option value="">Choose…</option>
            {batchRecipes.map((r) => <option key={r.id} value={r.id}>{r.output_name}</option>)}
          </select>
        </label>
        <label>Quantity to make{recipe ? ` (${recipe.output_uom})` : ''}<input type="number" min="0.001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} required /></label>
        <label>Ingredients from
          <select value={fromId} onChange={(e) => setFromId(e.target.value)} required>
            <option value="">Choose…</option>
            {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>Finished goods to
          <select value={toId} onChange={(e) => setToId(e.target.value)} required>
            <option value="">Choose…</option>
            {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>For (date)<input type="date" value={plannedFor} onChange={(e) => setPlannedFor(e.target.value)} /></label>
      </div>
      {recipe && qty > 0 && (
        <p className="small muted">Needs: {recipe.lines.map((l) => `${formatQty(Number(l.qty) * Number(qty) / Number(recipe.yield_qty))} ${l.uom} ${l.name}`).join(', ')}</p>
      )}
      <ErrorNote error={error} />
      <div className="row"><button className="primary">Plan batch</button><button type="button" className="link" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
