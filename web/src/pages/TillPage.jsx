import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { ErrorNote, PageHeader } from '../components/ui.jsx';
import { UnitPicker, formatMoney, formatQty, useSelectedUnit } from '../components/UnitPicker.jsx';
import { changeDue, ticketTotals } from '../lib/pricing.js';

const METHODS = [['cash', 'Cash'], ['card', 'Card / POS'], ['transfer', 'Bank transfer'], ['room', 'Charge to room']];

export function TillPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.FIN === 'write');
  const [unitId, setUnitId] = useSelectedUnit(units, 'till.unit');
  if (units.length === 0) return <><PageHeader title="Till" /><div className="card muted">You cannot take sales in any unit.</div></>;
  return (
    <>
      <PageHeader title="Till" actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      {unitId && <Till key={unitId} unitId={unitId} />}
    </>
  );
}

function Till({ unitId }) {
  const navigate = useNavigate();
  const [departmentId, setDepartmentId] = useState(() => { try { return localStorage.getItem(`till.dept.${unitId}`) ?? ''; } catch { return ''; } });
  const [locationId, setLocationId] = useState(() => { try { return localStorage.getItem(`till.loc.${unitId}`) ?? ''; } catch { return ''; } });
  const catalog = useLoad(() => api.get(`/api/pos/${unitId}/catalog${locationId ? `?locationId=${locationId}` : ''}`), [unitId, locationId]);
  const locations = useLoad(() => api.get(`/api/inventory/${unitId}/locations`), [unitId]);
  const inHouse = useLoad(() => api.get('/api/apartments/in-house').catch(() => []), [unitId]);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState([]);           // [{ itemId, name, price, qty, uom, isStockable }]
  const [discountPct, setDiscountPct] = useState(0);
  const [payments, setPayments] = useState([{ method: 'cash', amount: '', reference: '' }]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const rates = catalog.data?.rates ?? {};
  const totals = useMemo(() => ticketTotals(cart, {
    discountPct: Number(discountPct) || 0, servicePct: rates['charges.service_pct'] ?? 0, vatPct: rates['tax.vat_pct'] ?? 0,
  }), [cart, discountPct, rates]);
  const pay = changeDue(totals.total, payments);
  const departments = catalog.data?.departments ?? [];
  // A cashier assigned to one department gets it automatically.
  const effectiveDept = departments.some((d) => d.id === departmentId) ? departmentId
    : departments.length === 1 ? departments[0].id : '';
  const deptValid = Boolean(effectiveDept);
  const remember = (k, v) => { try { localStorage.setItem(`till.${k}.${unitId}`, v); } catch { /* ignore */ } };

  const add = (item) => setCart((c) => {
    const found = c.find((l) => l.itemId === item.id);
    if (found) return c.map((l) => (l.itemId === item.id ? { ...l, qty: Number(l.qty) + 1 } : l));
    return [...c, { itemId: item.id, name: item.name, price: Number(item.sell_price), qty: 1, uom: item.uom, isStockable: item.is_stockable }];
  });
  const setQty = (itemId, qty) => setCart((c) => c.map((l) => (l.itemId === itemId ? { ...l, qty } : l)));
  const remove = (itemId) => setCart((c) => c.filter((l) => l.itemId !== itemId));
  const setPayment = (i, k, v) => setPayments(payments.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.post(`/api/pos/${unitId}/checkout`, {
        departmentId: effectiveDept, locationId: locationId || null, discountPct: Number(discountPct) || 0,
        lines: cart.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
        payments: payments.filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference || null,
            reservationId: p.method === 'room' ? p.reservationId || null : null })),
      });
      navigate(`/sales/${unitId}/${id}?printed=0`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (catalog.error) return <ErrorNote error={catalog.error} />;
  if (!catalog.data) return <p className="muted">Loading…</p>;
  if (departments.length === 0) return <div className="card muted">You are not assigned to sell in any department of this unit.</div>;

  const shown = catalog.data.items.filter((i) => !search || i.name.toLowerCase().includes(search.toLowerCase()) || i.sku.toLowerCase().startsWith(search.toLowerCase()));

  return (
    <div className="till">
      <section className="card till-items">
        <div className="row wrap">
          <label>Department
            <select value={effectiveDept} onChange={(e) => { setDepartmentId(e.target.value); remember('dept', e.target.value); }}>
              <option value="">Choose…</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label>Sell from store
            <select value={locationId} onChange={(e) => { setLocationId(e.target.value); remember('loc', e.target.value); }}>
              <option value="">Choose…</option>
              {locations.data?.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="grow">Find<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or SKU" /></label>
        </div>
        <div className="item-grid">
          {shown.map((i) => {
            const out = i.is_stockable && locationId && Number(i.on_hand) <= 0;
            return (
              <button key={i.id} className={`item-tile ${out ? 'out' : ''}`} onClick={() => add(i)} disabled={out}>
                <strong>{i.name}</strong>
                <span>{formatMoney(i.sell_price)}</span>
                {i.is_stockable && locationId && <span className="muted small">{formatQty(i.on_hand)} {i.uom} in store</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="card till-cart">
        <h2>Ticket</h2>
        {cart.length === 0 && <p className="muted">Tap items to add them.</p>}
        {cart.map((l) => (
          <div key={l.itemId} className="cart-line">
            <div className="grow"><strong>{l.name}</strong><div className="muted small">{formatMoney(l.price)} / {l.uom}</div></div>
            <input className="qty-input" type="number" min="0.001" step="any" value={l.qty} onChange={(e) => setQty(l.itemId, e.target.value)} aria-label={`Quantity of ${l.name}`} />
            <span className="num">{formatMoney(Number(l.qty) * l.price)}</span>
            <button className="link" onClick={() => remove(l.itemId)} aria-label={`Remove ${l.name}`}>×</button>
          </div>
        ))}
        <div className="totals">
          <div><span>Subtotal</span><span>{formatMoney(totals.subtotal)}</span></div>
          <div className="row spread">
            <label className="inline">Discount % <input className="qty-input" type="number" min="0" max="100" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} /></label>
            <span>−{formatMoney(totals.discount)}</span>
          </div>
          <div><span>Service charge {rates['charges.service_pct'] ?? 0}%</span><span>{formatMoney(totals.service)}</span></div>
          <div><span>VAT {rates['tax.vat_pct'] ?? 0}%</span><span>{formatMoney(totals.tax)}</span></div>
          <div className="grand"><span>Total</span><span>{formatMoney(totals.total)}</span></div>
        </div>
        <h3>Payment</h3>
        {payments.map((p, i) => (
          <div key={i} className="row wrap pay-row">
            <select value={p.method} onChange={(e) => setPayment(i, 'method', e.target.value)}>
              {METHODS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="grow" type="number" min="0" step="any" placeholder="Amount" value={p.amount} onChange={(e) => setPayment(i, 'amount', e.target.value)} aria-label="Payment amount" />
            {['card', 'transfer'].includes(p.method) && <input placeholder="Ref." value={p.reference} onChange={(e) => setPayment(i, 'reference', e.target.value)} aria-label="Payment reference" />}
            {p.method === 'room' && (
              <select className="pay-guest" value={p.reservationId ?? ''} onChange={(e) => setPayment(i, 'reservationId', e.target.value)} aria-label="Guest room">
                <option value="">Room / guest…</option>
                {(inHouse.data ?? []).map((g) => <option key={g.reservation_id} value={g.reservation_id}>Room {g.room_numbers} · {g.guest_name}</option>)}
              </select>
            )}
            {payments.length > 1 && <button className="link" onClick={() => setPayments(payments.filter((_, j) => j !== i))}>×</button>}
          </div>
        ))}
        <div className="row wrap">
          <button className="link" onClick={() => setPayments([...payments, { method: 'card', amount: '', reference: '' }])}>+ Split payment</button>
          {pay.remaining > 0 && <button className="link" onClick={() => setPayment(payments.length - 1, 'amount', String(Number(payments[payments.length - 1].amount || 0) + pay.remaining))}>Fill remaining {formatMoney(pay.remaining)}</button>}
        </div>
        <div className="totals">
          <div><span>Paid</span><span>{formatMoney(pay.paid)}</span></div>
          {pay.remaining > 0 && <div className="due"><span>Still to pay</span><span>{formatMoney(pay.remaining)}</span></div>}
          {pay.change > 0 && <div className="grand"><span>Change</span><span>{formatMoney(pay.change)}</span></div>}
        </div>
        <ErrorNote error={error} />
        <button className="primary big" disabled={busy || cart.length === 0 || !pay.valid || !deptValid || (cart.some((l) => l.isStockable) && !locationId)} onClick={complete}>
          {busy ? 'Recording…' : `Complete sale ${formatMoney(totals.total)}`}
        </button>
        {cart.length > 0 && <button className="link" onClick={() => { setCart([]); setPayments([{ method: 'cash', amount: '', reference: '' }]); setDiscountPct(0); }}>Clear ticket</button>}
      </section>
    </div>
  );
}
