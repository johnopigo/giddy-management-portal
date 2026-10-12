import { useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../session.jsx';
import { ErrorNote, PageHeader } from '../components/ui.jsx';

export function ChangePasswordPage({ forced = false }) {
  const { refresh, signOut } = useSession();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (form.newPassword !== form.confirm) return setError(new Error('The new passwords do not match.'));
    try {
      await api.post('/api/me/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      setDone(true);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      await refresh();
    } catch (err) {
      setError(err);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const body = (
    <form className="card narrow" onSubmit={submit}>
      {forced && <p>Please choose your own password before continuing. It must be at least 10 characters and include letters and numbers.</p>}
      <label>Current password<input type="password" autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} required /></label>
      <label>New password<input type="password" autoComplete="new-password" value={form.newPassword} onChange={set('newPassword')} required /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required /></label>
      <ErrorNote error={error} />
      {done && <div className="success">Password changed. Your other sessions have been signed out.</div>}
      <div className="row">
        <button className="primary">Change password</button>
        {forced && <button type="button" className="link" onClick={signOut}>Sign out</button>}
      </div>
    </form>
  );

  if (forced) return <div className="auth-screen"><div><h1 className="center">Set your password</h1>{body}</div></div>;
  return <><PageHeader title="Change password" />{body}</>;
}
