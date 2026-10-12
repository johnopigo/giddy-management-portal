import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { formatMoney } from '../components/UnitPicker.jsx';

const SIDE = { owner: 'the Owner', partner: 'the partner' };
const SIDE_CAP = { owner: 'Owner', partner: 'Partner' };
const BASIS = {
  gross: 'Gross (with service charge and VAT)',
  net_of_vat: 'Without VAT (service charge included)',
  net: 'Net (without service charge and VAT)',
};
const AGREEMENT_STATUS = { proposed: ['Proposed', 'warn'], agreed: ['Agreed', 'good'], rejected: ['Rejected', 'bad'], withdrawn: ['Withdrawn', 'neutral'] };
const STATEMENT_STATUS = { issued: ['Issued', 'warn'], agreed: ['Agreed', 'accent'], paid: ['Paid', 'good'], withdrawn: ['Withdrawn', 'neutral'] };
const NOT_SET = <Badge tone="warn">Not set yet</Badge>;
const monthLabel = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

function terms(g) {
  return {
    rate: g.rate_pct ?? g.ratePct, beneficiary: g.beneficiary, basis: g.basis, collector: g.collector,
    retail: g.include_retail ?? g.includeRetail, from: g.effective_from ?? g.effectiveFrom,
  };
}

/** One sentence saying what the terms mean, or what is still open. */
export function explain(g) {
  const t = terms(g);
  if ([t.rate, t.beneficiary, t.basis, t.collector, t.retail].some((x) => x == null)) return 'Some terms are not decided yet; no statement can be issued until they are.';
  const base = `${Number(t.rate)}% of ${t.basis === 'gross' ? 'gross' : t.basis === 'net' ? 'net' : 'VAT-exclusive'} revenue (${t.retail ? 'services and retail' : 'services only'}) goes to ${SIDE[t.beneficiary]}.`;
  return t.collector !== t.beneficiary
    ? `${base} ${SIDE_CAP[t.collector]} collects client payments and pays ${SIDE[t.beneficiary]} that share each month.`
    : `${base} ${SIDE_CAP[t.collector]} collects client payments, keeps that share and pays ${SIDE[t.collector === 'owner' ? 'partner' : 'owner']} the rest each month.`;
}

function TermsTable({ g }) {
  const t = terms(g);
  const show = (v, f) => (v == null ? NOT_SET : f(v));
  return (
    <dl className="facts">
      <div><dt>Revenue share</dt><dd>{show(t.rate, (v) => `${Number(v)}%`)}</dd></div>
      <div><dt>Goes to</dt><dd>{show(t.beneficiary, (v) => SIDE_CAP[v])}</dd></div>
      <div><dt>Of revenue measured</dt><dd>{show(t.basis, (v) => BASIS[v])}</dd></div>
      <div><dt>Client payments collected by</dt><dd>{show(t.collector, (v) => SIDE_CAP[v])}</dd></div>
      <div><dt>Retail (product) sales</dt><dd>{show(t.retail, (v) => (v ? 'Count' : 'Do not count'))}</dd></div>
      <div><dt>Applies from</dt><dd>{monthLabel(t.from)}</dd></div>
    </dl>
  );
}

export function PartnershipPage() {
  const units = useLoad(() => api.get('/api/partnership/units'));
  const [unitId, setUnitId] = useState(null);
  const unit = units.data?.find((u) => u.id === unitId) ?? units.data?.[0];
  if (units.data && units.data.length === 0) return <><PageHeader title="Partnership" /><div className="card muted">There is no partnership you can see.</div></>;
  return (
    <>
      <PageHeader title="Partnership" subtitle="Revenue-share terms and monthly settlements between the Owner and the unit's partner."
        actions={units.data?.length > 1 && (
          <label className="unit-picker">Business unit
            <select value={unit?.id ?? ''} onChange={(e) => setUnitId(e.target.value)}>
              {units.data.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        )} />
      <ErrorNote error={units.error} />
      {unit && <Partnership key={unit.id} unit={unit} />}
    </>
  );
}

function Partnership({ unit }) {
  const agreements = useLoad(() => api.get(`/api/partnership/${unit.id}/agreements`), [unit.id]);
  const statements = useLoad(() => api.get(`/api/partnership/${unit.id}/statements`), [unit.id]);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = () => { agreements.reload(); statements.reload(); setTick((t) => t + 1); };
  const run = async (fn) => { setError(null); try { await fn(); reload(); return true; } catch (err) { setError(err); return false; } };
  const a = agreements.data;
  if (!a) return <ErrorNote error={agreements.error} />;
  const mySide = a.mySide;
  const current = a.agreements.find((g) => g.id === a.currentId);
  const pending = a.agreements.find((g) => g.status === 'proposed');
  const base = `/api/partnership/${unit.id}`;

  return (
    <>
      <p className="muted">{unit.name} · {mySide ? <>You act for <strong>{SIDE_CAP[mySide]}</strong>.</> : 'You can view this partnership.'}</p>
      <ErrorNote error={error} />
      <section className="card">
        <div className="row spread"><h2>Agreed terms</h2>{current && <Badge tone="good">Version {current.version}</Badge>}</div>
        {current ? (
          <>
            <TermsTable g={current} />
            <p>{explain(current)}</p>
            <p className="muted small">Proposed by {current.proposed_by_name} ({SIDE[current.proposed_side]}), agreed by {current.decided_by_name} {formatDateTime(current.decided_at)}.
              {current.notes && ` ${current.notes}`}</p>
          </>
        ) : <p className="muted">No terms agreed yet. Either side proposes; the other accepts. Terms can be agreed with blanks and completed later.</p>}
      </section>

      {pending && <Pending g={pending} mySide={mySide} base={base} run={run} />}
      {mySide && !pending && <ProposeForm base={base} current={current} run={run} />}

      <Statement unit={unit} mySide={mySide} statements={statements.data ?? []} run={run} tick={tick} />

      <section className="card">
        <h2>Statements</h2>
        <StatementList rows={statements.data} mySide={mySide} base={base} run={run} />
      </section>

      <section className="card">
        <h2>Terms history</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Version</th><th>Terms</th><th>From</th><th>Proposed</th><th>Decision</th></tr></thead>
            <tbody>
              {a.agreements.map((g) => (
                <tr key={g.id}>
                  <td>{g.version} <Badge tone={AGREEMENT_STATUS[g.status][1]}>{AGREEMENT_STATUS[g.status][0]}</Badge></td>
                  <td className="small">{[g.rate_pct, g.beneficiary, g.basis, g.collector, g.include_retail].every((x) => x == null) ? 'All terms still to be decided' : <>{g.rate_pct != null ? `${Number(g.rate_pct)}%` : '—'} to {g.beneficiary ? SIDE_CAP[g.beneficiary] : '—'} · {g.basis ? BASIS[g.basis] : 'basis —'} · collected by {g.collector ? SIDE_CAP[g.collector] : '—'} · retail {g.include_retail == null ? '—' : g.include_retail ? 'counts' : 'excluded'}</>}</td>
                  <td className="small">{monthLabel(g.effective_from)}</td>
                  <td className="small">{g.proposed_by_name}, {formatDateTime(g.proposed_at)}</td>
                  <td className="small">{g.decided_by_name ? `${g.decided_by_name}, ${formatDateTime(g.decided_at)}` : '—'}{g.decision_note ? ` · ${g.decision_note}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {a.agreements.length === 0 && <p className="muted">No proposals yet.</p>}
      </section>
    </>
  );
}

function Pending({ g, mySide, base, run }) {
  const [note, setNote] = useState('');
  const mine = mySide === g.proposed_side;
  return (
    <section className="card warn-card">
      <div className="row spread"><h2>Proposed terms · version {g.version}</h2><Badge tone="warn">Waiting for {SIDE[g.proposed_side === 'owner' ? 'partner' : 'owner']}</Badge></div>
      <TermsTable g={g} />
      <p>{explain(g)}</p>
      <p className="muted small">Proposed by {g.proposed_by_name} ({SIDE[g.proposed_side]}), {formatDateTime(g.proposed_at)}.{g.notes && ` ${g.notes}`}</p>
      {mySide && !mine && (
        <div className="row wrap">
          <button className="primary" onClick={() => run(() => api.post(`${base}/agreements/${g.id}/decide`, { accept: true, note: note || null }))}>Accept</button>
          <input placeholder="Note (needed to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="secondary" disabled={!note.trim()} onClick={() => run(() => api.post(`${base}/agreements/${g.id}/decide`, { accept: false, note }))}>Reject</button>
        </div>
      )}
      {mine && <button className="secondary" onClick={() => run(() => api.post(`${base}/agreements/${g.id}/withdraw`))}>Withdraw proposal</button>}
    </section>
  );
}

function ProposeForm({ base, current, run }) {
  const t = current ? terms(current) : {};
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    ratePct: t.rate != null ? String(Number(t.rate)) : '', beneficiary: t.beneficiary ?? '', basis: t.basis ?? '',
    collector: t.collector ?? '', includeRetail: t.retail == null ? '' : String(t.retail), effectiveFrom: new Date().toISOString().slice(0, 7), notes: '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  if (!open) return <div className="row"><button className="secondary" onClick={() => setOpen(true)}>{current ? 'Propose new terms' : 'Propose terms'}</button></div>;
  const draft = { rate_pct: f.ratePct === '' ? null : f.ratePct, beneficiary: f.beneficiary || null, basis: f.basis || null,
    collector: f.collector || null, include_retail: f.includeRetail === '' ? null : f.includeRetail === 'true', effective_from: `${f.effectiveFrom}-01` };
  return (
    <form className="card form-grid" onSubmit={async (e) => {
      e.preventDefault();
      if (await run(() => api.post(`${base}/agreements`, {
        ratePct: f.ratePct === '' ? null : Number(f.ratePct), beneficiary: f.beneficiary || null, basis: f.basis || null,
        collector: f.collector || null, includeRetail: f.includeRetail === '' ? null : f.includeRetail === 'true',
        effectiveFrom: `${f.effectiveFrom}-01`, notes: f.notes || null,
      }))) setOpen(false);
    }}>
      <h2 className="full">Propose terms</h2>
      <p className="full muted small">Leave anything undecided blank. The other side must accept before the terms apply.</p>
      <label>Revenue share (%)<input type="number" min="0" max="100" step="0.01" value={f.ratePct} onChange={set('ratePct')} placeholder="Not decided" /></label>
      <label>Goes to
        <select value={f.beneficiary} onChange={set('beneficiary')}><option value="">Not decided</option><option value="owner">Owner</option><option value="partner">Partner</option></select>
      </label>
      <label>Of revenue measured
        <select value={f.basis} onChange={set('basis')}><option value="">Not decided</option>{Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <label>Client payments collected by
        <select value={f.collector} onChange={set('collector')}><option value="">Not decided</option><option value="partner">Partner</option><option value="owner">Owner</option></select>
      </label>
      <label>Retail (product) sales
        <select value={f.includeRetail} onChange={set('includeRetail')}><option value="">Not decided</option><option value="true">Count</option><option value="false">Do not count</option></select>
      </label>
      <label>Applies from (month)<input type="month" value={f.effectiveFrom} onChange={set('effectiveFrom')} required /></label>
      <label className="full">Notes<input value={f.notes} onChange={set('notes')} placeholder="e.g. as per the signed agreement of 1 March" /></label>
      <p className="full">{explain(draft)}</p>
      <div className="full row"><button className="primary">Send proposal</button><button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

const MISSING = { agreement: 'agreed terms', rate: 'the rate', beneficiary: 'who receives it', basis: 'the revenue basis', collector: 'who collects payments', retail: 'whether retail counts' };

function Statement({ unit, mySide, statements, run, tick }) {
  const [month, setMonth] = useState(lastMonth());
  const p = useLoad(() => api.get(`/api/partnership/${unit.id}/preview?month=${month}`), [unit.id, month, tick]);
  const taken = statements.some((s) => s.period_start.slice(0, 7) === month && s.status !== 'withdrawn');
  const c = p.data;
  const f = c?.figures;
  return (
    <section className="card">
      <div className="row wrap spread">
        <h2>Monthly statement</h2>
        <label className="unit-picker">Month<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
      </div>
      <ErrorNote error={p.error} />
      {c && (
        <>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr><td>Revenue (net)</td><td className="num">{formatMoney(f.net)}</td></tr>
                <tr><td>Service charge</td><td className="num">{formatMoney(f.serviceCharge)}</td></tr>
                <tr><td>VAT</td><td className="num">{formatMoney(f.vat)}</td></tr>
                <tr className="dim"><td>of which retail (products): net · service charge · VAT</td>
                  <td className="num small">{formatMoney(f.retailNet)} · {formatMoney(f.retailServiceCharge)} · {formatMoney(f.retailVat)}</td></tr>
                <tr className="dim"><td>Completed appointments · till sales</td><td className="num small">{f.appointments} · {f.tickets}</td></tr>
                {c.base != null && <>
                  <tr><th>Base ({BASIS[c.agreement.basis]}, {c.agreement.includeRetail ? 'retail included' : 'retail excluded'})</th><th className="num">{formatMoney(c.base)}</th></tr>
                  <tr><td>{Number(c.agreement.ratePct)}% to {SIDE_CAP[c.agreement.beneficiary]}</td><td className="num">{formatMoney(c.share)}</td></tr>
                  <tr><th>{SIDE_CAP[c.payer]} pays {SIDE[c.payee]}</th><th className="num">{formatMoney(c.amount)}</th></tr>
                </>}
              </tbody>
            </table>
          </div>
          {c.missing.length > 0 && <p className="notice">Cannot settle yet: missing {c.missing.map((m) => MISSING[m]).join(', ')}.</p>}
          {!c.ended && <p className="muted small">This month has not ended; figures are so far.</p>}
          {mySide && c.ended && c.missing.length === 0 && !taken && (
            <button className="primary" onClick={() => run(() => api.post(`/api/partnership/${unit.id}/statements`, { month }))}>
              Issue statement for {monthLabel(`${month}-01`)}</button>
          )}
          {taken && <p className="muted small">A statement for this month has been issued; see below.</p>}
        </>
      )}
    </section>
  );
}

function StatementList({ rows, mySide, base, run }) {
  const [paying, setPaying] = useState(null);
  const [pay, setPay] = useState({ method: 'transfer', reference: '' });
  if (!rows?.length) return <p className="muted">No statements yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Month</th><th>Statement</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={s.status === 'withdrawn' ? 'dim' : ''}>
              <td>{monthLabel(s.period_start)}</td>
              <td className="small">{s.statement_number}<div className="muted">{SIDE_CAP[s.payer]} pays {SIDE[s.payee]} · issued by {s.issued_by_name}
                {s.agreed_by_name ? ` · agreed by ${s.agreed_by_name}` : ''}{s.paid_at ? ` · paid ${formatDateTime(s.paid_at)}${s.payment_reference ? ` (${s.payment_reference})` : ''}` : ''}</div></td>
              <td className="num">{formatMoney(s.amount)}</td>
              <td><Badge tone={STATEMENT_STATUS[s.status][1]}>{STATEMENT_STATUS[s.status][0]}</Badge></td>
              <td className="actions-cell">
                {mySide && s.status === 'issued' && mySide !== s.issued_side && <button className="primary small-btn" onClick={() => run(() => api.post(`${base}/statements/${s.id}/agree`))}>Agree</button>}
                {mySide && s.status === 'issued' && mySide === s.issued_side && <button className="link" onClick={() => run(() => api.post(`${base}/statements/${s.id}/withdraw`))}>Withdraw</button>}
                {mySide && s.status === 'agreed' && paying !== s.id && <button className="secondary small-btn" onClick={() => setPaying(s.id)}>Record payment</button>}
                {paying === s.id && (
                  <div className="row wrap">
                    <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} aria-label="Payment method">
                      <option value="transfer">Bank transfer</option><option value="cash">Cash</option>
                    </select>
                    <input placeholder="Reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                    <button className="primary small-btn" onClick={async () => {
                      if (await run(() => api.post(`${base}/statements/${s.id}/payment`, { method: pay.method, reference: pay.reference || null }))) setPaying(null);
                    }}>Save</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
