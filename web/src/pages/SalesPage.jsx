import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { UnitPicker, formatMoney, formatQty, useSelectedUnit } from '../components/UnitPicker.jsx';

const METHOD_LABELS = { cash: 'Cash', card: 'Card / POS', transfer: 'Bank transfer', room: 'Charged to room' };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

export function SalesPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.FIN);
  const [unitId, setUnitId] = useSelectedUnit(units, 'sales.unit');
  const [date, setDate] = useState(today());
  const summary = useLoad(() => (unitId ? api.get(`/api/pos/${unitId}/summary?date=${date}`) : Promise.resolve(null)), [unitId, date]);
  const tickets = useLoad(() => (unitId ? api.get(`/api/pos/${unitId}/tickets?date=${date}`) : Promise.resolve([])), [unitId, date]);
  const navigate = useNavigate();

  if (units.length === 0) return <><PageHeader title="Sales" /><div className="card muted">You have no access to sales.</div></>;
  const s = summary.data;

  return (
    <>
      <PageHeader title="Sales" subtitle="Tickets and takings for the day."
        actions={<div className="row"><label>Day<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <UnitPicker units={units} value={unitId} onChange={setUnitId} /></div>} />
      <ErrorNote error={summary.error ?? tickets.error} />
      {s && (
        <div className="stat-row">
          <div className="stat"><span className="muted small">Takings</span><strong>{formatMoney(s.gross)}</strong><span className="muted small">{s.tickets} ticket{s.tickets === 1 ? '' : 's'}</span></div>
          {s.byMethod.map((m) => <div key={m.method} className="stat"><span className="muted small">{METHOD_LABELS[m.method]}</span><strong>{formatMoney(m.amount)}</strong></div>)}
          <div className="stat"><span className="muted small">VAT collected</span><strong>{formatMoney(s.tax)}</strong></div>
          <div className="stat"><span className="muted small">Discounts given</span><strong>{formatMoney(s.discounts)}</strong></div>
          <div className="stat"><span className="muted small">Voids</span><strong>{s.voids}</strong><span className="muted small">{formatMoney(s.voided_value)}</span></div>
        </div>
      )}
      <section className="card">
        {tickets.data?.length === 0 && <p className="muted">No sales on this day.</p>}
        {tickets.data?.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ticket</th><th>Time</th><th>Department</th><th>Seller</th><th className="num">Total</th><th /></tr></thead>
              <tbody>
                {tickets.data.map((t) => (
                  <tr key={t.id} className={t.status === 'voided' ? 'dim' : ''}>
                    <td><strong>{t.ticket_number}</strong> {t.status === 'voided' && <Badge tone="bad">Voided</Badge>}</td>
                    <td className="small">{formatDateTime(t.created_at)}</td>
                    <td>{t.department_name}</td>
                    <td>{t.seller_name}</td>
                    <td className="num">{formatMoney(t.total)}</td>
                    <td><button className="link" onClick={() => navigate(`/sales/${unitId}/${t.id}`)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {s?.top?.length > 0 && (
        <section className="card">
          <h2>Best sellers</h2>
          <ul className="plain small">{s.top.map((x) => <li key={x.name}>{x.name}: {formatQty(x.qty)} sold · {formatMoney(x.value)}</li>)}</ul>
        </section>
      )}
    </>
  );
}

export function TicketPage() {
  const { unitId, id } = useParams();
  const { me } = useSession();
  const t = useLoad(() => api.get(`/api/pos/${unitId}/tickets/${id}`), [unitId, id]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const canVoid = unitAccess(me, unitId, 'FIN') === 'write' && unitAccess(me, unitId, 'CFG') === 'write';

  if (t.error) return <ErrorNote error={t.error} />;
  if (!t.data) return <p className="muted">Loading…</p>;
  const x = t.data;
  const doVoid = async () => {
    setError(null);
    try {
      await api.post(`/api/pos/${unitId}/tickets/${id}/void`, { reason });
      t.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <div className="row no-print">
        <Link to="/till">← Back to the till</Link>
        <Link to="/sales">Sales</Link>
        <button className="primary" onClick={() => window.print()}>Print receipt</button>
      </div>
      <section className="card receipt-paper">
        <div className="center-text">
          <strong>{me.user.tenant_name}</strong>
          <div>{x.business_unit_name} · {x.department_name}</div>
          <div className="small">{x.ticket_number} · {formatDateTime(x.created_at)}</div>
          <div className="small">Served by {x.seller_name}</div>
          {x.status === 'voided' && <div className="void-stamp">VOIDED</div>}
        </div>
        <table className="receipt-lines">
          <tbody>
            {x.lines.map((l) => (
              <tr key={l.line_no}>
                <td>{l.item_name}<div className="small muted">{formatQty(l.qty)} × {formatMoney(l.unit_price)}</div></td>
                <td className="num">{formatMoney(l.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="totals">
          <div><span>Subtotal</span><span>{formatMoney(x.subtotal)}</span></div>
          {Number(x.discount_amount) > 0 && <div><span>Discount {Number(x.discount_pct)}%</span><span>−{formatMoney(x.discount_amount)}</span></div>}
          {Number(x.service_charge_amount) > 0 && <div><span>Service charge {Number(x.service_charge_pct)}%</span><span>{formatMoney(x.service_charge_amount)}</span></div>}
          {Number(x.tax_amount) > 0 && <div><span>VAT {Number(x.tax_pct)}%</span><span>{formatMoney(x.tax_amount)}</span></div>}
          <div className="grand"><span>Total</span><span>{formatMoney(x.total)}</span></div>
          {x.payments.map((p, i) => <div key={i}><span>{METHOD_LABELS[p.method]}{p.room_numbers ? ` ${p.room_numbers}` : ''}{p.reference ? ` (${p.reference})` : ''}</span><span>{formatMoney(p.amount)}</span></div>)}
          {Number(x.change_due) > 0 && <div><span>Change</span><span>{formatMoney(x.change_due)}</span></div>}
        </div>
        <p className="center-text small">Thank you.</p>
      </section>
      {x.status === 'voided' && <div className="card no-print">Voided by {x.voided_by_name} on {formatDateTime(x.voided_at)}: {x.void_reason}</div>}
      {x.status === 'completed' && canVoid && (
        <section className="card no-print">
          <h2>Void this sale</h2>
          <p className="muted small">Stock goes back to the store and the takings are reversed in the books. This cannot be undone.</p>
          <div className="row">
            <input className="grow" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="danger" onClick={doVoid}>Void sale</button>
          </div>
          <ErrorNote error={error} />
        </section>
      )}
    </>
  );
}
