import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatDateTime } from './ui.jsx';

const POLL_MS = 60_000;

/** Sidebar bell: unread count, refreshed every minute, with a drop-down list. */
export function NotificationBell() {
  const [data, setData] = useState({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    try { setData(await api.get('/api/notifications')); } catch { /* keep the last list */ }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const openItem = async (n) => {
    if (!n.read_at) await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
    setOpen(false);
    load();
    if (n.link) navigate(n.link);
  };

  return (
    <div className="bell">
      <button className="bell-button" onClick={() => setOpen(!open)} aria-label={`Notifications, ${data.unread} unread`}>
        Notifications {data.unread > 0 && <span className="bell-count">{data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="row spread">
            <strong>Notifications</strong>
            {data.unread > 0 && <button className="link small" onClick={async () => { await api.post('/api/notifications/read-all'); load(); }}>Mark all read</button>}
          </div>
          {data.items.length === 0 && <p className="muted small">Nothing yet.</p>}
          {data.items.map((n) => (
            <button key={n.id} className={`bell-item ${n.read_at ? '' : 'unread'}`} onClick={() => openItem(n)}>
              <strong>{n.title}</strong>
              {n.body && <span className="small">{n.body}</span>}
              <span className="muted small">{n.business_unit_name ? `${n.business_unit_name} · ` : ''}{formatDateTime(n.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
