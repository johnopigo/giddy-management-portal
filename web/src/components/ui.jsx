export function PageHeader({ title, subtitle, actions }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="error" role="alert">{error.message ?? String(error)}</div>;
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function AccessPill({ level }) {
  if (!level) return <span className="pill pill-none">—</span>;
  return <span className={`pill pill-${level}`}>{level === 'write' ? 'Read & write' : 'Read only'}</span>;
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
