import { Fragment, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';

const ENTITY_LABELS = {
  app_user: 'User', user_role_assignment: 'Role assignment', business_unit: 'Business unit',
  business_unit_setting: 'Unit setting', department: 'Department', branch: 'Branch', legal_entity: 'Legal entity',
  customer: 'Customer', appointment: 'Appointment', appointment_bill: 'Appointment bill', bill_entry: 'Bill line',
  bookable_resource: 'Bookable resource', bookable_service: 'Bookable service', service_resource: 'Service resource',
  resource_block: 'Blocked time', client_intake: 'Intake form (sensitive)', treatment_note: 'Treatment note (sensitive)',
  reservation: 'Reservation', folio: 'Guest bill', folio_entry: 'Guest bill line', room: 'Room', room_type: 'Room type',
  rate_plan: 'Rate plan', housekeeping_task: 'Housekeeping task',
};

export function AuditPage() {
  const [entity, setEntity] = useState('');
  const log = useLoad(() => api.get(`/api/audit?limit=100${entity ? `&entity=${entity}` : ''}`), [entity]);
  const [verify, setVerify] = useState(null);
  const [open, setOpen] = useState(null);

  const runVerify = async () => {
    try {
      setVerify(await api.get('/api/audit/verify'));
    } catch (err) {
      setVerify({ error: err });
    }
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every change, and every view of a sensitive record: who, and when. Entries cannot be edited or deleted."
        actions={<button className="secondary" onClick={runVerify}>Verify integrity</button>}
      />
      {verify?.intact === true && <div className="success">The audit chain is intact: no entry has been altered.</div>}
      {verify?.intact === false && <div className="error">Tampering detected starting at entry #{verify.firstBrokenId}.</div>}
      <ErrorNote error={verify?.error ?? log.error} />
      <div className="row">
        <label>Show
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All changes</option>
            {Object.entries(ENTITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>What</th><th>Unit</th><th /></tr></thead>
            <tbody>
              {log.data?.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td className="muted small">{e.id}</td>
                    <td className="small">{formatDateTime(e.at)}</td>
                    <td>{e.user_name ?? <span className="muted">System</span>}</td>
                    <td>{e.action.replace('_', ' ')}</td>
                    <td>{ENTITY_LABELS[e.entity] ?? e.entity}</td>
                    <td className="small">{e.business_unit_name ?? '—'}</td>
                    <td><button className="link small" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide' : 'Details'}</button></td>
                  </tr>
                  {open === e.id && (
                    <tr>
                      <td colSpan={7}>
                        <div className="diff">
                          <div><h3>Before</h3><pre>{e.before_data ? JSON.stringify(e.before_data, null, 2) : '—'}</pre></div>
                          <div><h3>After</h3><pre>{e.after_data ? JSON.stringify(e.after_data, null, 2) : '—'}</pre></div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {log.data?.length === 0 && <p className="muted">No entries you are allowed to see.</p>}
      </section>
    </>
  );
}
