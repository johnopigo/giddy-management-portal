import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, PageHeader } from '../components/ui.jsx';
import { formatMoney } from '../components/UnitPicker.jsx';
import { addDays, longDate, todayIn } from '../lib/time.js';

const TZ = 'Africa/Lagos';
// A unit's colour follows the unit, never its rank: filtering never repaints the others.
export const UNIT_SLOT = { apartments: 1, food_beverage: 2, content_studio: 3, spa: 4 };

export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** The headline figure: whole naira, so it reads at a glance (the exact figure is in the tooltip and tables). */
export const wholeMoney = (n) => `NGN ${Math.round(n).toLocaleString('en-NG')}`;

/** Width of an element, kept current as the layout changes. */
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function presetRange(preset, today) {
  const [y, m] = today.split('-').map(Number);
  const first = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  switch (preset) {
    case 'today': return [today, today];
    case '7d': return [addDays(today, -6), today];
    case '30d': return [addDays(today, -29), today];
    case 'month': return [first(y, m), today];
    case 'last-month': {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return [first(py, pm), addDays(first(y, m), -1)];
    }
    default: return null;
  }
}

function csv(rows) {
  const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.FIN);
  const today = todayIn(TZ);
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState([addDays(today, -6), today]);
  const [unitId, setUnitId] = useState('');
  const [from, to] = presetRange(preset, today) ?? custom;
  const r = useLoad(() => api.get(`/api/reports/summary?from=${from}&to=${to}${unitId ? `&unitId=${unitId}` : ''}`), [from, to, unitId]);

  if (units.length === 0) return <><PageHeader title="Reports" /><div className="card muted">Your roles do not include any unit's finances.</div></>;
  const d = r.data;
  return (
    <>
      <PageHeader title="Reports" subtitle="Revenue, takings and activity across the units you can see, straight from the books." />
      <div className="card filter-row">
        <label>Period
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
            <option value="month">This month</option><option value="last-month">Last month</option><option value="custom">Choose dates…</option>
          </select>
        </label>
        {preset === 'custom' && <>
          <label>From<input type="date" value={custom[0]} max={custom[1]} onChange={(e) => e.target.value && setCustom([e.target.value, custom[1]])} /></label>
          <label>To<input type="date" value={custom[1]} min={custom[0]} onChange={(e) => e.target.value && setCustom([custom[0], e.target.value])} /></label>
        </>}
        <label>Units
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">{units.length > 1 ? 'All my units' : units[0].name}</option>
            {units.length > 1 && units.map((u) => <option key={u.business_unit_id} value={u.business_unit_id}>{u.name}</option>)}
          </select>
        </label>
        <span className="muted small grow">{longDate(from)}{from !== to ? ` – ${longDate(to)}` : ''}</span>
      </div>
      <ErrorNote error={r.error} />
      {d && <Report d={d} />}
    </>
  );
}

function Report({ d }) {
  const t = d.totals;
  const margin = t.net ? Math.round((t.grossProfit / t.net) * 1000) / 10 : null;
  return (
    <>
      <section className="card kpis">
        <div className="hero-figure">
          <span className="muted">Revenue (net)</span>
          <strong title={formatMoney(t.net)}>{wholeMoney(t.net)}</strong>
          <span className="muted small">plus {formatMoney(t.serviceCharge)} service charge and {formatMoney(t.vat)} VAT collected</span>
        </div>
        <div className="stat-tiles">
          <Stat label="Gross profit" value={formatMoney(t.grossProfit)} note={margin != null ? `${margin}% margin after ${formatMoney(t.cogs)} cost of goods` : null} />
          <Stat label="Takings" value={formatMoney(t.takings)} note="cash, card and transfers received" />
          <Stat label="Owed on open bills" value={formatMoney(t.openBills)} note="guests and clients, at the end of the period" />
          <Stat label="Stock value" value={formatMoney(t.stockValue)} note="at average cost, end of the period" />
        </div>
      </section>
      <RevenueChart d={d} />
      <UnitTable d={d} />
      {d.occupancy.length > 0 && <Occupancy rows={d.occupancy} />}
      {d.appointments.length > 0 && <Appointments rows={d.appointments} />}
      <div className="grid-2">
        <TopItems rows={d.topItems} />
        {d.settlements.length > 0 && <Settlements rows={d.settlements} />}
      </div>
    </>
  );
}

function Stat({ label, value, note }) {
  return (
    <div className="stat-tile">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- chart
const CH = 220; // plot height
const PAD = { top: 12, right: 8, bottom: 26, left: 44 };

function buckets(d) {
  // Days for up to two months; weeks beyond that, so columns stay readable.
  const days = [];
  for (let x = d.from; x <= d.to; x = addDays(x, 1)) days.push(x);
  const weekly = days.length > 62;
  const keyOf = (day) => (weekly ? days[Math.floor(days.indexOf(day) / 7) * 7] : day);
  const keys = [...new Set(days.map(keyOf))];
  const byKey = Object.fromEntries(keys.map((k) => [k, {}]));
  for (const row of d.daily) {
    const k = keyOf(row.day);
    if (byKey[k]) byKey[k][row.unit_id] = (byKey[k][row.unit_id] ?? 0) + row.net;
  }
  return { weekly, keys, byKey };
}

function RevenueChart({ d }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState(null);
  const [boxRef, boxW] = useWidth();
  const units = d.units;
  const { weekly, keys, byKey } = useMemo(() => buckets(d), [d]);
  const totals = keys.map((k) => units.reduce((s, u) => s + Math.max(byKey[k][u.id] ?? 0, 0), 0));
  const max = Math.max(...totals, 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  // Fill the card; below ~12px a column scrolls sideways instead of shrinking further.
  const W = Math.max(boxW || 320, keys.length * 12 + PAD.left + PAD.right);
  const band = (W - PAD.left - PAD.right) / keys.length;
  const barW = Math.min(24, Math.max(4, band - 6));
  const y = (v) => PAD.top + CH - (v / top) * CH;
  const label = (k) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const every = Math.ceil(keys.length / 8);

  return (
    <section className="card viz" ref={boxRef}>
      <div className="row wrap spread">
        <h2>{weekly ? 'Weekly' : 'Daily'} revenue by unit</h2>
        <div className="row">
          <button className="link" onClick={() => setAsTable(!asTable)}>{asTable ? 'Show chart' : 'Show as table'}</button>
          <button className="link" onClick={() => download(`revenue-${d.from}-${d.to}.csv`, csv([
            [weekly ? 'Week starting' : 'Day', ...units.map((u) => u.name), 'Total'],
            ...keys.map((k, i) => [k, ...units.map((u) => (byKey[k][u.id] ?? 0).toFixed(2)), totals[i].toFixed(2)]),
          ]))}>Download CSV</button>
        </div>
      </div>
      {units.length > 1 && (
        <ul className="legend" aria-label="Units">
          {units.map((u) => <li key={u.id}><span className={`key s${UNIT_SLOT[u.unit_type]}`} />{u.name}</li>)}
        </ul>
      )}
      {asTable ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{weekly ? 'Week of' : 'Day'}</th>{units.map((u) => <th key={u.id} className="num">{u.name}</th>)}<th className="num">Total</th></tr></thead>
            <tbody>{keys.map((k, i) => (
              <tr key={k}><td>{label(k)}</td>{units.map((u) => <td key={u.id} className="num">{formatMoney(byKey[k][u.id] ?? 0)}</td>)}<td className="num"><strong>{formatMoney(totals[i])}</strong></td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="chart-scroll" onMouseLeave={() => setHover(null)}>
          <svg className="chart" width={W} height={PAD.top + CH + PAD.bottom} role="img"
            aria-label={`${weekly ? 'Weekly' : 'Daily'} net revenue by unit, ${label(d.from)} to ${label(d.to)}`}>
            {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
                <text className="tick" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">{compact(v)}</text>
              </g>
            ))}
            {keys.map((k, i) => {
              const x = PAD.left + i * band + (band - barW) / 2;
              let acc = 0;
              const segs = units.map((u) => ({ u, v: Math.max(byKey[k][u.id] ?? 0, 0) })).filter((s) => s.v > 0);
              return (
                <g key={k}>
                  {segs.map((s, j) => {
                    const y0 = y(acc);
                    acc += s.v;
                    const y1 = y(acc);
                    const h = Math.max(y0 - y1 - (j < segs.length - 1 ? 2 : 0), 1); // 2px surface gap between segments
                    const isTop = j === segs.length - 1;
                    return isTop
                      ? <path key={s.u.id} className={`mark s${UNIT_SLOT[s.u.unit_type]}`} d={roundTop(x, y0 - h, barW, h, Math.min(4, h, barW / 2))} />
                      : <rect key={s.u.id} className={`mark s${UNIT_SLOT[s.u.unit_type]}`} x={x} y={y0 - h} width={barW} height={h} />;
                  })}
                  {i % every === 0 && <text className="tick" x={x + barW / 2} y={PAD.top + CH + 16} textAnchor="middle">{label(k)}</text>}
                  {/* hit target: the whole band, taller than the marks */}
                  <rect className="hit" x={PAD.left + i * band} y={PAD.top} width={band} height={CH} tabIndex={0}
                    onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    aria-label={`${label(k)}: ${formatMoney(totals[i])}`} />
                </g>
              );
            })}
            <line className="axis" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
          </svg>
          {hover != null && (
            <div className="viz-tip" style={{ left: Math.min(PAD.left + hover * band + band + 8, W - 200) }}>
              <div className="small muted">{weekly ? 'Week of ' : ''}{label(keys[hover])}</div>
              <div><strong>{formatMoney(totals[hover])}</strong> total</div>
              {units.map((u) => (
                <div key={u.id} className="tip-row"><span className={`line-key s${UNIT_SLOT[u.unit_type]}`} />
                  <strong>{formatMoney(byKey[keys[hover]][u.id] ?? 0)}</strong> <span className="muted">{u.name}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function niceStep(max) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}
function roundTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ---------------------------------------------------------------- tables
function UnitTable({ d }) {
  const rows = d.units;
  return (
    <section className="card">
      <div className="row spread">
        <h2>By unit</h2>
        <button className="link" onClick={() => download(`units-${d.from}-${d.to}.csv`, csv([
          ['Unit', 'Revenue (net)', 'Service charge', 'VAT', 'Cost of goods', 'Gross profit', 'Margin %', 'Cash', 'Card', 'Transfer', 'Charged to rooms', 'Open bills', 'Stock value'],
          ...rows.map((u) => [u.name, u.net, u.serviceCharge, u.vat, u.cogs, u.grossProfit, u.marginPct ?? '', u.takings.cash, u.takings.card,
            u.takings.transfer, u.takings.rooms, u.openBills, u.stockValue]),
        ]))}>Download CSV</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Unit</th><th className="num">Revenue</th><th className="num">Cost of goods</th><th className="num">Gross profit</th>
            <th className="num">Cash</th><th className="num">Card</th><th className="num">Transfer</th><th className="num">Open bills</th><th className="num">Stock</th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td><span className={`key s${UNIT_SLOT[u.unit_type]}`} /> <strong>{u.name}</strong>
                  {u.management_model === 'partnership' && <div><Badge tone="accent">Partnership</Badge></div>}</td>
                <td className="num">{formatMoney(u.net)}<div className="muted small">+{formatMoney(u.serviceCharge + u.vat)} svc &amp; VAT</div></td>
                <td className="num">{formatMoney(u.cogs)}</td>
                <td className="num">{formatMoney(u.grossProfit)}{u.marginPct != null && <div className="muted small">{u.marginPct}%</div>}</td>
                <td className="num">{formatMoney(u.takings.cash)}</td>
                <td className="num">{formatMoney(u.takings.card)}</td>
                <td className="num">{formatMoney(u.takings.transfer)}{u.takings.rooms ? <div className="muted small">{formatMoney(u.takings.rooms)} to rooms</div> : null}</td>
                <td className="num">{formatMoney(u.openBills)}</td>
                <td className="num">{formatMoney(u.stockValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Occupancy({ rows }) {
  return (
    <section className="card">
      <h2>Apartments</h2>
      {rows.map((o) => (
        <div key={o.unitId} className="stat-tiles">
          <Stat label="Occupancy" value={o.occupancyPct != null ? `${o.occupancyPct}%` : '—'} note={`${o.nightsSold} of ${o.availableNights} room-nights (${o.rooms} rooms)`} />
          <Stat label="Average daily rate" value={o.adr != null ? formatMoney(o.adr) : '—'} note="room revenue per night sold" />
          <Stat label="Revenue per available room" value={o.revpar != null ? formatMoney(o.revpar) : '—'} note="room revenue per room-night" />
          <Stat label="Room revenue" value={formatMoney(o.roomRevenue)} note="net of service charge and VAT" />
        </div>
      ))}
    </section>
  );
}

function Appointments({ rows }) {
  return (
    <section className="card">
      <h2>Appointments</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Unit</th><th className="num">Completed</th><th className="num">Still to come</th><th className="num">Cancelled</th>
            <th className="num">No-shows</th><th className="num">Booked online</th><th className="num">Bookings revenue</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.unit_id}><td><strong>{a.unit_name}</strong></td><td className="num">{a.completed}</td><td className="num">{a.upcoming}</td>
              <td className="num">{a.cancelled}</td><td className="num">{a.no_show}</td>
              <td className="num">{a.online}{a.total ? <span className="muted small"> ({Math.round((a.online / a.total) * 100)}%)</span> : null}</td>
              <td className="num">{formatMoney(a.revenue)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function TopItems({ rows }) {
  return (
    <section className="card">
      <h2>Best sellers</h2>
      {rows.length === 0 ? <p className="muted">No item sales in this period.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Net sales</th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={`${i.item_name}-${i.unit_name}`}><td>{i.item_name}<div className="muted small">{i.unit_name}</div></td>
                <td className="num">{Number(i.qty.toFixed(3))}</td><td className="num">{formatMoney(i.net)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const SIDE = { owner: 'Owner', partner: 'Partner' };
function Settlements({ rows }) {
  return (
    <section className="card">
      <h2>Partnership settlements</h2>
      <ul className="plain">{rows.map((s) => (
        <li key={s.unit_id}><strong>{s.unit_name}</strong>: latest statement {s.statement_number} for{' '}
          {new Date(`${s.period_start}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })},{' '}
          {SIDE[s.payer]} pays {SIDE[s.payee]} {formatMoney(s.amount)} <Badge tone={s.status === 'paid' ? 'good' : 'warn'}>{s.status}</Badge></li>
      ))}</ul>
    </section>
  );
}
