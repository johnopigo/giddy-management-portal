import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';

export function CustomersPage() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const results = useLoad(() => api.get(`/api/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`), [query]);
  const [selected, setSelected] = useState(null);

  return (
    <>
      <PageHeader title="Customers" subtitle="One customer record across the group. Each unit's notes stay with that unit." />
      <div className="split">
        <div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
            <input className="grow" placeholder="Name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="secondary">Search</button>
          </form>
          <NewCustomer onCreated={(c) => { setSelected(c.id); results.reload(); }} onFoundExisting={setSelected} />
          <section className="card list">
            <ErrorNote error={results.error} />
            {results.data?.length === 0 && <p className="muted">No customers found.</p>}
            {results.data?.map((c) => (
              <button key={c.id} className={`list-item ${selected === c.id ? 'active' : ''}`} onClick={() => setSelected(c.id)}>
                <strong>{c.full_name}</strong>
                <span className="muted small">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </section>
        </div>
        <div>{selected ? <CustomerDetail key={selected} id={selected} /> : <div className="card muted">Select a customer to see their details.</div>}</div>
      </div>
    </>
  );
}

function NewCustomer({ onCreated, onFoundExisting }) {
  const empty = { fullName: '', phone: '', email: '' };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  if (!open) return <div className="row"><button className="secondary" onClick={() => setOpen(true)}>+ New customer</button></div>;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const c = await api.post('/api/customers', { fullName: form.fullName, phone: form.phone || null, email: form.email || null });
      setForm(empty);
      setOpen(false);
      onCreated(c);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details?.existing) {
        setOpen(false);
        onFoundExisting(err.details.existing.id);
        return;
      }
      setError(err);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <label>Full name<input value={form.fullName} onChange={set('fullName')} required /></label>
      <label>Phone<input value={form.phone} onChange={set('phone')} /></label>
      <label>Email<input type="email" value={form.email} onChange={set('email')} /></label>
      <p className="muted small">A phone number or email is required. If the customer already exists, their record opens instead.</p>
      <ErrorNote error={error} />
      <div className="row">
        <button className="primary">Create</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function CustomerDetail({ id }) {
  const { me } = useSession();
  const customer = useLoad(() => api.get(`/api/customers/${id}`), [id]);
  const [unitForNote, setUnitForNote] = useState('');

  if (customer.error) return <ErrorNote error={customer.error} />;
  if (!customer.data) return <p className="muted">Loading…</p>;
  const c = customer.data;
  const writableUnits = me.scope.filter((s) => s.access.OPS === 'write');
  const missing = writableUnits.filter((u) => !c.profiles.some((p) => p.business_unit_id === u.business_unit_id));

  return (
    <>
      <section className="card">
        <h2>{c.full_name}</h2>
        <div className="small">{c.phone ?? ''}{c.phone && c.email ? ' · ' : ''}{c.email ?? ''}</div>
        <div className="muted small">Customer since {formatDateTime(c.created_at)}</div>
      </section>
      {c.profiles.map((p) => <ProfileCard key={p.business_unit_id} customerId={id} profile={p} onSaved={customer.reload} />)}
      {missing.length > 0 && (
        <section className="card row wrap">
          <span className="muted small">Add notes for</span>
          <select value={unitForNote} onChange={(e) => setUnitForNote(e.target.value)}>
            <option value="">Choose a unit…</option>
            {missing.map((u) => <option key={u.business_unit_id} value={u.business_unit_id}>{u.name}</option>)}
          </select>
          {unitForNote && (
            <ProfileCard customerId={id} onSaved={() => { setUnitForNote(''); customer.reload(); }}
              profile={{ business_unit_id: unitForNote, business_unit_name: missing.find((u) => u.business_unit_id === unitForNote).name,
                notes: '', tags: [], marketing_opt_in: false, can_edit: true }} startEditing />
          )}
        </section>
      )}
    </>
  );
}

function ProfileCard({ customerId, profile, onSaved, startEditing = false }) {
  const [editing, setEditing] = useState(startEditing);
  const [v, setV] = useState({ notes: profile.notes, tags: profile.tags.join(', '), marketingOptIn: profile.marketing_opt_in });
  const [error, setError] = useState(null);

  const save = async () => {
    setError(null);
    try {
      await api.put(`/api/customers/${customerId}/profiles/${profile.business_unit_id}`, {
        notes: v.notes, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean), marketingOptIn: v.marketingOptIn,
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section className="card">
      <div className="row spread">
        <h3>{profile.business_unit_name}</h3>
        {profile.can_edit && !editing && <button className="link small" onClick={() => setEditing(true)}>Edit</button>}
        {!profile.can_edit && <span className="muted small">Read only</span>}
      </div>
      {editing ? (
        <>
          <label>Notes<textarea rows={4} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
          <label>Tags (comma separated)<input value={v.tags} onChange={(e) => setV({ ...v, tags: e.target.value })} /></label>
          <label className="inline"><input type="checkbox" checked={v.marketingOptIn} onChange={(e) => setV({ ...v, marketingOptIn: e.target.checked })} /> Agreed to marketing messages</label>
          <ErrorNote error={error} />
          <div className="row"><button className="primary small-btn" onClick={save}>Save</button><button className="link" onClick={() => setEditing(false)}>Cancel</button></div>
        </>
      ) : (
        <>
          <p className="prewrap">{profile.notes || <span className="muted">No notes.</span>}</p>
          {profile.tags.length > 0 && <div className="small">{profile.tags.map((t) => <span key={t} className="badge badge-neutral">{t}</span>)}</div>}
        </>
      )}
    </section>
  );
}
