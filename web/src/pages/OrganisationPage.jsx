import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';
import { UNIT_TYPE_LABELS, unitAccess } from '../lib/permissions.js';

export function OrganisationPage() {
  const { me } = useSession();
  const org = useLoad(() => api.get('/api/org'));
  const [selected, setSelected] = useState(null);

  if (org.error) return <ErrorNote error={org.error} />;
  if (!org.data) return <p className="muted">Loading…</p>;
  const { businessUnits, branches, departments } = org.data;
  const branchName = (id) => branches.find((b) => b.id === id)?.name ?? '';

  return (
    <>
      <PageHeader title="Organisation" subtitle="Business units, departments and unit settings." />
      {me.user.public_slug && (
        <div className="card">
          <strong>Online booking page:</strong>{' '}
          <a href={`/book/${me.user.public_slug}`} target="_blank" rel="noreferrer">{window.location.origin}/book/{me.user.public_slug}</a>
          <p className="muted small">Guests book rooms, Spa treatments and Studio hire there. Each unit appears once its managers set
            <code> online.enabled</code> to <code>true</code> in its settings below; <code>online.deposit_pct</code>,
            <code> online.hold_minutes</code> and <code>online.cancel_hours</code> set the deposit, how long an unpaid booking is held,
            and how late guests may cancel online. Limits against bookings that are never paid: <code>online.max_open_per_guest</code>
            (unpaid bookings one guest or address may have open), <code>online.max_unpaid_holds</code> (unpaid holds a unit keeps at
            once), <code>online.max_nights</code> and <code>online.max_days_ahead</code>. Spa and Studio services also need "Bookable
            online" ticked; give them a deposit so free bookings cannot fill the diary.</p>
        </div>
      )}
      <div className="grid-2">
        {businessUnits.map((bu) => (
          <section key={bu.id} className={`card unit-card ${selected === bu.id ? 'selected' : ''}`}>
            <div className="row spread">
              <div>
                <h2>{bu.name}</h2>
                <div className="muted small">{UNIT_TYPE_LABELS[bu.unit_type]} · {bu.code} · {bu.currency_code}</div>
              </div>
              <Badge tone={bu.management_model === 'partnership' ? 'accent' : 'neutral'}>
                {bu.management_model === 'partnership' ? 'Partnership-managed' : 'Owner-managed'}
              </Badge>
            </div>
            <h3>Departments</h3>
            <ul className="plain small">
              {departments.filter((d) => d.business_unit_id === bu.id).map((d) => (
                <li key={d.id}>{d.name} <span className="muted">· {branchName(d.branch_id)}</span></li>
              ))}
            </ul>
            {unitAccess(me, bu.id, 'CFG') ? (
              <button className="secondary small-btn" onClick={() => setSelected(selected === bu.id ? null : bu.id)}>
                {selected === bu.id ? 'Hide settings' : 'Settings'}
              </button>
            ) : (
              <p className="muted small">You have no access to this unit's settings.</p>
            )}
            {selected === bu.id && <UnitSettings unit={bu} canWrite={unitAccess(me, bu.id, 'CFG') === 'write'} />}
          </section>
        ))}
      </div>
    </>
  );
}

function UnitSettings({ unit, canWrite }) {
  const settings = useLoad(() => api.get(`/api/org/business-units/${unit.id}/settings`), [unit.id]);
  const [editing, setEditing] = useState({});
  const [error, setError] = useState(null);

  const save = async (key) => {
    setError(null);
    try {
      await api.put(`/api/org/business-units/${unit.id}/settings/${key}`, { value: JSON.parse(editing[key]) });
      setEditing(({ [key]: _, ...rest }) => rest);
      settings.reload();
    } catch (err) {
      setError(err instanceof SyntaxError ? new Error('Enter a number, text in quotes, true/false, or JSON.') : err);
    }
  };

  if (!settings.data) return <p className="muted small">Loading settings…</p>;
  return (
    <div className="settings">
      {!canWrite && <p className="muted small">Read only: this unit's settings are managed by its own team.</p>}
      <table>
        <thead><tr><th>Setting</th><th>Value</th><th>Updated</th>{canWrite && <th />}</tr></thead>
        <tbody>
          {settings.data.map((s) => (
            <tr key={s.key}>
              <td><code>{s.key}</code></td>
              <td>
                {editing[s.key] !== undefined
                  ? <input value={editing[s.key]} onChange={(e) => setEditing({ ...editing, [s.key]: e.target.value })} />
                  : <code>{JSON.stringify(s.value)}</code>}
              </td>
              <td className="small muted">{formatDateTime(s.updated_at)}</td>
              {canWrite && (
                <td>
                  {editing[s.key] !== undefined
                    ? <button className="primary small-btn" onClick={() => save(s.key)}>Save</button>
                    : <button className="link" onClick={() => setEditing({ ...editing, [s.key]: JSON.stringify(s.value) })}>Edit</button>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorNote error={error} />
    </div>
  );
}
