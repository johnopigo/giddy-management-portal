import { useState } from 'react';
import { api } from '../lib/api.js';
import { Badge, ErrorNote, formatDateTime } from './ui.jsx';

const FIELDS = [
  ['healthConditions', 'health_conditions', 'Health conditions'], ['allergies', 'allergies', 'Allergies'],
  ['medications', 'medications', 'Medication'], ['skinType', 'skin_type', 'Skin type'],
  ['preferences', 'preferences', 'Preferences'], ['emergencyContact', 'emergency_contact', 'Emergency contact'],
  ['notes', 'notes', 'Other notes'],
];

export function intakeBadge(intake) {
  if (!intake?.on_file) return <Badge tone="bad">No intake form</Badge>;
  if (!intake.consent_given) return <Badge tone="bad">Intake without consent</Badge>;
  if (!intake.is_current) return <Badge tone="warn">Intake expired</Badge>;
  return <Badge tone="good">Intake on file</Badge>;
}

/**
 * The client's sensitive record for a Spa appointment: intake form and treatment notes.
 * Nothing sensitive is loaded until someone asks to see it, and every view is logged.
 */
export function ClientRecord({ unitId, appt, onChanged }) {
  const [intake, setIntake] = useState(null);
  const [notes, setNotes] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const base = `/api/bookings/${unitId}`;
  const i = appt.intake;
  const canWriteNote = (appt.i_am_on_it || appt.can_record_intake) && ['checked_in', 'completed'].includes(appt.status);
  const run = async (fn) => { setError(null); try { await fn(); return true; } catch (err) { setError(err); return false; } };
  const showIntake = (version) => run(async () => setIntake(await api.get(`${base}/clients/${appt.customer_id}/intake${version ? `?version=${version}` : ''}`)));
  const showNotes = () => run(async () => setNotes(await api.get(`${base}/clients/${appt.customer_id}/notes`)));

  return (
    <section className="card">
      <div className="row wrap spread">
        <h2>Client record</h2>
        <div className="row">{intakeBadge(i)}{appt.requires_intake && <span className="muted small">needed for this treatment</span>}</div>
      </div>
      {i?.on_file && (
        <p className="muted small">Version {i.version}, recorded {formatDateTime(i.recorded_at)}
          {i.consent_given ? ` · valid until ${formatDateTime(i.valid_until)}` : ' · the client has not given consent'}</p>
      )}
      <ErrorNote error={error} />
      <div className="row wrap">
        {appt.can_read_sensitive && i?.on_file && !intake && <button className="secondary" onClick={() => showIntake()}>Show health record</button>}
        {appt.can_read_sensitive && !notes && <button className="secondary" onClick={showNotes}>Show treatment notes</button>}
        {appt.can_record_intake && !editing && <button className="secondary" onClick={() => setEditing(true)}>{i?.on_file ? 'Update intake form' : 'Record intake form'}</button>}
      </div>
      {(intake || notes) && <p className="muted small">Viewing health records is logged in the audit trail.</p>}

      {intake && (
        <div className="intake">
          <div className="row wrap spread">
            <strong>Intake form · version {intake.version}</strong>
            {intake.latest_version > 1 && (
              <select value={intake.version} onChange={(e) => showIntake(e.target.value)} aria-label="Intake version">
                {Array.from({ length: intake.latest_version }, (_, k) => intake.latest_version - k).map((v) => <option key={v} value={v}>Version {v}</option>)}
              </select>
            )}
          </div>
          <dl className="facts">
            {FIELDS.map(([, col, label]) => intake[col] ? <div key={col}><dt>{label}</dt><dd>{intake[col]}</dd></div> : null)}
            {intake.pregnant != null && <div><dt>Pregnant</dt><dd>{intake.pregnant ? 'Yes' : 'No'}</dd></div>}
            <div><dt>Consent</dt><dd>{intake.consent_given ? `Given by ${intake.consent_name}` : 'Not given'}</dd></div>
            <div><dt>Recorded</dt><dd>{intake.recorded_by_name}, {formatDateTime(intake.recorded_at)}</dd></div>
          </dl>
        </div>
      )}

      {editing && (
        <IntakeForm initial={intake} onCancel={() => setEditing(false)} onSave={async (form) => {
          if (await run(() => api.post(`${base}/clients/${appt.customer_id}/intake`, form))) {
            setEditing(false); setIntake(null); onChanged();
          }
        }} />
      )}

      {notes && (
        <>
          <h3>Treatment notes</h3>
          {notes.length === 0 && <p className="muted small">No notes yet.</p>}
          <ul className="plain notes">
            {notes.map((n) => (
              <li key={n.id}>
                <div><strong>{n.service_name}</strong> <span className="muted small">{n.booking_ref} · {n.written_by_name}, {formatDateTime(n.written_at)}</span></div>
                <div className="prewrap">{n.body}</div>
                {n.products_used && <div className="small">Products: {n.products_used}</div>}
                {n.reaction && <div className="small">Reaction: {n.reaction}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {canWriteNote && (
        <NoteForm onSave={(note) => run(async () => {
          await api.post(`${base}/appointments/${appt.id}/notes`, note);
          if (appt.can_read_sensitive) await showNotes();
        })} />
      )}
    </section>
  );
}

function IntakeForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(() => ({
    ...Object.fromEntries(FIELDS.map(([k, col]) => [k, initial?.[col] ?? ''])),
    pregnant: initial?.pregnant == null ? '' : String(initial.pregnant), consentGiven: false, consentName: '',
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <form className="form-grid" onSubmit={(e) => {
      e.preventDefault();
      onSave({ ...f, pregnant: f.pregnant === '' ? null : f.pregnant === 'true', consentName: f.consentName || null });
    }}>
      <h3 className="full">Intake form</h3>
      {FIELDS.map(([k, , label]) => (
        <label key={k} className={['healthConditions', 'notes'].includes(k) ? 'full' : ''}>{label}
          {['healthConditions', 'notes'].includes(k)
            ? <textarea rows="2" value={f[k]} onChange={set(k)} />
            : <input value={f[k]} onChange={set(k)} />}
        </label>
      ))}
      <label>Pregnant
        <select value={f.pregnant} onChange={set('pregnant')}><option value="">Not asked / not applicable</option><option value="false">No</option><option value="true">Yes</option></select>
      </label>
      <label className="inline full"><input type="checkbox" checked={f.consentGiven} onChange={set('consentGiven')} />
        The client confirms this is accurate and consents to treatment</label>
      {f.consentGiven && <label>Client's name (as signature)<input value={f.consentName} onChange={set('consentName')} required /></label>}
      <div className="full row">
        <button className="primary">Save as new version</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function NoteForm({ onSave }) {
  const [n, setN] = useState({ body: '', productsUsed: '', reaction: '' });
  const set = (k) => (e) => setN({ ...n, [k]: e.target.value });
  return (
    <div className="form-grid">
      <h3 className="full">Add a treatment note</h3>
      <label className="full">What was done<textarea rows="2" value={n.body} onChange={set('body')} /></label>
      <label>Products used<input value={n.productsUsed} onChange={set('productsUsed')} /></label>
      <label>Reaction, if any<input value={n.reaction} onChange={set('reaction')} /></label>
      <div className="full"><button className="secondary" disabled={n.body.trim().length < 2}
        onClick={async () => { if (await onSave(n)) setN({ body: '', productsUsed: '', reaction: '' }); }}>Save note</button></div>
    </div>
  );
}
