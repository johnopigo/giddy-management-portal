import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { unitAccess } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { Tabs, UnitPicker, formatMoney, useSelectedUnit } from '../components/UnitPicker.jsx';

const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const TYPE_LABELS = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' };

export function FinancePage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.FIN);
  const [unitId, setUnitId] = useSelectedUnit(units, 'finance.unit');
  const [tab, setTab] = useState('tb');
  if (units.length === 0) return <><PageHeader title="Books" /><div className="card muted">You have no access to the books.</div></>;
  return (
    <>
      <PageHeader title="Books" subtitle="Double-entry ledger: every sale, purchase and stock movement posts here automatically."
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      <Tabs value={tab} onChange={setTab} tabs={[['tb', 'Trial balance'], ['journal', 'Journal'], ['periods', 'Month-end']]} />
      {unitId && tab === 'tb' && <TrialBalance unitId={unitId} />}
      {unitId && tab === 'journal' && <Journal unitId={unitId} />}
      {unitId && tab === 'periods' && <Periods unitId={unitId} canClose={unitAccess(me, unitId, 'FIN') === 'write' && unitAccess(me, unitId, 'CFG') === 'write'} />}
    </>
  );
}

function TrialBalance({ unitId }) {
  const rows = useLoad(() => api.get(`/api/finance/${unitId}/trial-balance`), [unitId]);
  if (!rows.data) return <ErrorNote error={rows.error} />;
  const totalDr = rows.data.reduce((s, r) => s + Number(r.debit), 0);
  const totalCr = rows.data.reduce((s, r) => s + Number(r.credit), 0);
  return (
    <section className="card">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Account</th><th className="num">Debits</th><th className="num">Credits</th><th className="num">Balance</th></tr></thead>
          {TYPE_ORDER.map((type) => (
            <tbody key={type}>
              <tr className="group-row"><td colSpan={4}>{TYPE_LABELS[type]}</td></tr>
              {rows.data.filter((r) => r.account_type === type).map((r) => (
                <tr key={r.code} className={Number(r.debit) === 0 && Number(r.credit) === 0 ? 'dim' : ''}>
                  <td><span className="muted small">{r.code}</span> {r.name}</td>
                  <td className="num">{formatMoney(r.debit)}</td>
                  <td className="num">{formatMoney(r.credit)}</td>
                  <td className="num">{formatMoney(Math.abs(Number(r.balance)))} {Number(r.balance) > 0 ? 'Dr' : Number(r.balance) < 0 ? 'Cr' : ''}</td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot>
            <tr><th>Totals</th><th className="num">{formatMoney(totalDr)}</th><th className="num">{formatMoney(totalCr)}</th>
              <th className="num">{Math.abs(totalDr - totalCr) < 0.005 ? <Badge tone="good">Balanced</Badge> : <Badge tone="bad">Out by {formatMoney(totalDr - totalCr)}</Badge>}</th></tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function Journal({ unitId }) {
  const rows = useLoad(() => api.get(`/api/finance/${unitId}/journal?limit=100`), [unitId]);
  return (
    <section className="card">
      <ErrorNote error={rows.error} />
      {rows.data?.length === 0 && <p className="muted">Nothing posted yet.</p>}
      {rows.data?.map((e) => (
        <div key={e.id} className="journal-entry">
          <div className="row spread">
            <div><strong>#{e.id}</strong> {e.entry_date} · {e.memo || e.source_doc_type.replace('_', ' ')}
              {e.reverses_entry_id && <Badge tone="warn">reverses #{e.reverses_entry_id}</Badge>}</div>
            <span className="muted small">{e.posted_by_name ?? 'System'} · {formatDateTime(e.posted_at)}</span>
          </div>
          <table className="inner">
            <tbody>
              {e.lines.map((l, i) => (
                <tr key={i}>
                  <td className={Number(l.credit) > 0 ? 'indent' : ''}>{l.code} {l.name}{l.counterparty ? ` (${l.counterparty})` : ''}</td>
                  <td className="num">{Number(l.debit) > 0 ? formatMoney(l.debit) : ''}</td>
                  <td className="num">{Number(l.credit) > 0 ? formatMoney(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function Periods({ unitId, canClose }) {
  const periods = useLoad(() => api.get(`/api/finance/${unitId}/periods`), [unitId]);
  const [error, setError] = useState(null);
  const close = async (id) => {
    setError(null);
    try {
      await api.post(`/api/finance/${unitId}/periods/${id}/close`);
      periods.reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card">
      <p className="muted small">Closing a month locks it: nothing more can be posted to it, and it cannot be reopened. Close months in order, after they end.</p>
      <ErrorNote error={error ?? periods.error} />
      <table>
        <thead><tr><th>Month</th><th>Entries</th><th>Status</th><th /></tr></thead>
        <tbody>
          {periods.data?.map((p) => (
            <tr key={p.id}>
              <td>{new Date(`${p.period_start}T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</td>
              <td>{p.entries}</td>
              <td>{p.status === 'closed' ? <Badge>Closed by {p.closed_by_name}</Badge> : <Badge tone="good">Open</Badge>}</td>
              <td>{p.status === 'open' && canClose && <button className="secondary small-btn" onClick={() => close(p.id)}>Close month</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
