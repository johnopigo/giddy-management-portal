import { useState } from 'react';
import { useSession } from '../session.jsx';
import { ErrorNote } from '../components/ui.jsx';

export function LoginPage() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">G</span>
          <div className="brand-name">Giddy Management Portal</div>
        </div>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorNote error={error} />
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
