import { Link } from 'react-router-dom';
import { useSession } from '../session.jsx';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { formatMoney } from '../components/UnitPicker.jsx';
import { todayIn } from '../lib/time.js';
import { AccessPill, Badge, PageHeader } from '../components/ui.jsx';
import { DATA_CLASS_LABELS, UNIT_TYPE_LABELS } from '../lib/permissions.js';

const CLASSES = ['OPS', 'FIN', 'CFG', 'SEN'];

export function DashboardPage() {
  const { me } = useSession();
  const active = me.assignments.filter((a) => a.status === 'active');
  const pending = me.assignments.filter((a) => a.status === 'pending_approval');

  return (
    <>
      <PageHeader title={`Welcome, ${me.user.full_name.split(' ')[0]}`} subtitle="Your roles and what you can access in each business unit." />

      {me.scope.some((u) => u.access.FIN) && <Today />}

      <section className="card">
        <h2>Your roles</h2>
        {active.length === 0 && <p className="muted">You have no active roles yet.</p>}
        <ul className="plain">
          {active.map((a) => (
            <li key={a.id}><strong>{a.role_name}</strong>{a.business_unit_name ? ` · ${a.business_unit_name}` : ' · All units (partnership units read-only)'}</li>
          ))}
        </ul>
        {pending.length > 0 && (
          <p className="muted small">
            Waiting for partner approval: {pending.map((a) => `${a.role_name} (${a.business_unit_name})`).join(', ')}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Business data you can access</h2>
        {me.scope.length === 0 ? (
          <p className="muted">Your roles do not give access to business data in any unit.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Business unit</th><th>Managed by</th>{CLASSES.map((c) => <th key={c}>{DATA_CLASS_LABELS[c]}</th>)}</tr>
              </thead>
              <tbody>
                {me.scope.map((s) => (
                  <tr key={s.business_unit_id}>
                    <td><strong>{s.name}</strong><div className="muted small">{UNIT_TYPE_LABELS[s.unit_type]}</div></td>
                    <td><Badge tone={s.management_model === 'partnership' ? 'accent' : 'neutral'}>{s.management_model === 'partnership' ? 'Partnership' : 'Owner'}</Badge></td>
                    {CLASSES.map((c) => <td key={c}><AccessPill level={s.access[c]} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Today() {
  const today = todayIn('Africa/Lagos');
  const r = useLoad(() => api.get(`/api/reports/summary?from=${today}&to=${today}`), [today]);
  if (!r.data) return null;
  const t = r.data.totals;
  const occ = r.data.occupancy[0];
  const appts = r.data.appointments.reduce((s, a) => s + a.completed + a.upcoming, 0);
  return (
    <section className="card">
      <div className="row spread"><h2>Today across your units</h2><Link to="/reports">Open reports →</Link></div>
      <div className="stat-tiles">
        <div className="stat-tile"><span className="muted small">Revenue so far</span><strong>{formatMoney(t.net)}</strong></div>
        <div className="stat-tile"><span className="muted small">Takings</span><strong>{formatMoney(t.takings)}</strong></div>
        <div className="stat-tile"><span className="muted small">Owed on open bills</span><strong>{formatMoney(t.openBills)}</strong></div>
        {occ && <div className="stat-tile"><span className="muted small">Rooms occupied tonight</span><strong>{occ.nightsSold} of {occ.rooms}</strong></div>}
        {r.data.appointments.length > 0 && <div className="stat-tile"><span className="muted small">Appointments today</span><strong>{appts}</strong></div>}
      </div>
    </section>
  );
}
