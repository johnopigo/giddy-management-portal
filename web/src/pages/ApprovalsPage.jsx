import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';

export function ApprovalsPage() {
  const pending = useLoad(() => api.get('/api/assignments?status=pending_approval'));
  const [notes, setNotes] = useState({});
  const [error, setError] = useState(null);

  const decide = async (id, action) => {
    setError(null);
    try {
      await api.post(`/api/assignments/${id}/${action}`, { note: notes[id] || undefined });
      pending.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Role grants that give finance or configuration access in your unit take effect only after you approve them."
      />
      <ErrorNote error={error ?? pending.error} />
      {pending.data?.length === 0 && <div className="card muted">Nothing is waiting for your approval.</div>}
      {pending.data?.map((a) => (
        <section key={a.id} className="card">
          <div className="row spread wrap">
            <div>
              <h2>{a.user_name} → {a.role_name}</h2>
              <div className="muted small">{a.user_email} · {a.business_unit_name}{a.department_name ? ` · ${a.department_name}` : ''}</div>
              <div className="small">Requested by {a.requested_by_name} on {formatDateTime(a.requested_at)}</div>
            </div>
            <div className="row wrap">
              <input placeholder="Note (optional)" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
              <button className="primary" onClick={() => decide(a.id, 'approve')}>Approve</button>
              <button className="danger" onClick={() => decide(a.id, 'reject')}>Reject</button>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}
