import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { ErrorNote } from './ui.jsx';

/** Find a guest in the shared customer list, or add a new one. */
export function GuestPicker({ guest, onChange }) {
  const [q, setQ] = useState('');
  const [fresh, setFresh] = useState({ fullName: '', phone: '', email: '' });
  const [error, setError] = useState(null);
  const found = useLoad(() => (q.trim().length >= 2 ? api.get(`/api/customers?q=${encodeURIComponent(q.trim())}`) : Promise.resolve([])), [q]);

  const create = async () => {
    setError(null);
    try {
      onChange(await api.post('/api/customers', { fullName: fresh.fullName, phone: fresh.phone || null, email: fresh.email || null }));
    } catch (err) {
      if (err.status === 409 && err.details?.existing) onChange(err.details.existing);
      else setError(err);
    }
  };

  if (guest) {
    return (
      <div className="row"><strong>{guest.full_name}</strong><span className="muted small">{guest.phone ?? guest.email}</span>
        <button className="link" onClick={() => onChange(null)}>Change</button></div>
    );
  }
  return (
    <>
      <input placeholder="Search guests by name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list">
        {found.data?.map((c) => <button key={c.id} className="list-item" onClick={() => onChange(c)}><strong>{c.full_name}</strong><span className="muted small">{c.phone ?? c.email}</span></button>)}
      </div>
      <div className="row wrap">
        <input placeholder="New guest: full name" value={fresh.fullName} onChange={(e) => setFresh({ ...fresh, fullName: e.target.value })} />
        <input placeholder="Phone" value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} />
        <input placeholder="Email" value={fresh.email} onChange={(e) => setFresh({ ...fresh, email: e.target.value })} />
        <button className="secondary small-btn" onClick={create} disabled={!fresh.fullName}>Add guest</button>
      </div>
      <ErrorNote error={error} />
    </>
  );
}
