import { NavLink } from 'react-router-dom';
import { useSession } from '../session.jsx';
import { hasTenantPermission, hasAnyUnitPermission } from '../lib/permissions.js';

export function Layout({ children }) {
  const { me, signOut } = useSession();
  const canSeeUsers = hasTenantPermission(me, 'users.read');
  const canApprove = hasAnyUnitPermission(me, 'grants.approve');
  const canAudit = hasAnyUnitPermission(me, 'audit.read') || hasTenantPermission(me, 'audit.read_security');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">G</span>
          <div>
            <div className="brand-name">Giddy Portal</div>
            <div className="brand-tenant">{me.user.tenant_name}</div>
          </div>
        </div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/organisation">Organisation</NavLink>
          {canSeeUsers && <NavLink to="/users">Users &amp; roles</NavLink>}
          {canApprove && <NavLink to="/approvals">Approvals</NavLink>}
          {canAudit && <NavLink to="/audit">Audit log</NavLink>}
        </nav>
        <div className="sidebar-foot">
          <div className="who">{me.user.full_name}</div>
          <div className="muted small">{me.user.email}</div>
          <NavLink to="/account/password" className="small">Change password</NavLink>
          <button className="link small" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
