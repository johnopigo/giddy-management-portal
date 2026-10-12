import { useSession } from '../session.jsx';
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

      <section className="card">
        <h2>Your roles</h2>
        {active.length === 0 && <p className="muted">You have no active roles yet.</p>}
        <ul className="plain">
          {active.map((a) => (
            <li key={a.id}><strong>{a.role_name}</strong>{a.business_unit_name ? ` · ${a.business_unit_name}` : ' · All owner-managed units'}</li>
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
