import { NavLink } from 'react-router-dom';
import { useSession } from '../session.jsx';
import { hasTenantPermission, hasAnyUnitPermission } from '../lib/permissions.js';
import { NotificationBell } from './Notifications.jsx';

export function Layout({ children }) {
  const { me, signOut } = useSession();
  const canSeeUsers = hasTenantPermission(me, 'users.read');
  const canApprove = hasAnyUnitPermission(me, 'grants.approve');
  const hasClass = (c) => me.scope.some((s) => s.access[c]);
  const canAudit = hasAnyUnitPermission(me, 'audit.read') || hasTenantPermission(me, 'audit.read_security');

  return (
    <div className="shell">
      <aside className="sidebar no-print">
        <div className="brand">
          <span className="brand-mark">G</span>
          <div>
            <div className="brand-name">Giddy Portal</div>
            <div className="brand-tenant">{me.user.tenant_name}</div>
          </div>
        </div>
        <NotificationBell />
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          {me.scope.some((s) => s.unit_type === 'apartments' && s.access.OPS) && <NavLink to="/front-desk">Front desk</NavLink>}
          {me.scope.some((s) => ['spa', 'content_studio'].includes(s.unit_type) && s.access.OPS) && <NavLink to="/appointments">Appointments</NavLink>}
          {me.scope.some((s) => s.access.FIN === 'write') && <NavLink to="/till">Till</NavLink>}
          {hasClass('FIN') && <NavLink to="/sales">Sales</NavLink>}
          {hasClass('OPS') && <NavLink to="/inventory">Inventory</NavLink>}
          {hasClass('OPS') && <NavLink to="/recipes">Recipes</NavLink>}
          {hasClass('OPS') && <NavLink to="/production">Production</NavLink>}
          {hasClass('OPS') && <NavLink to="/requests">Item requests</NavLink>}
          {hasClass('FIN') && <NavLink to="/procurement">Purchasing</NavLink>}
          {hasClass('OPS') && <NavLink to="/transfers">Transfers</NavLink>}
          {hasClass('OPS') && <NavLink to="/customers">Customers</NavLink>}
          {(hasClass('OPS') || hasClass('CFG')) && <NavLink to="/catalog">Catalogue</NavLink>}
          {(hasClass('FIN') || hasClass('CFG')) && <NavLink to="/suppliers">Suppliers</NavLink>}
          {hasClass('FIN') && <NavLink to="/books">Books</NavLink>}
          <div className="nav-sep" />
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
