import { Fragment, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { hasTenantPermission } from '../lib/permissions.js';
import { Badge, ErrorNote, PageHeader, formatDateTime } from '../components/ui.jsx';

const STATUS_TONE = { active: 'good', pending_approval: 'warn', rejected: 'bad', revoked: 'neutral' };
const STATUS_LABEL = { active: 'Active', pending_approval: 'Awaiting partner', rejected: 'Rejected', revoked: 'Revoked' };

export function UsersPage() {
  const { me } = useSession();
  const canManage = hasTenantPermission(me, 'users.manage');
  const canAssign = hasTenantPermission(me, 'roles.assign');
  const canAssignRestricted = hasTenantPermission(me, 'roles.assign_restricted');
  const data = useLoad(async () => {
    const [users, assignments, roles, org] = await Promise.all([
      api.get('/api/users'), api.get('/api/assignments'), api.get('/api/roles'), api.get('/api/org')]);
    return { users, assignments, roles, org };
  });
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [assigningFor, setAssigningFor] = useState(null);

  const act = async (fn) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      data.reload();
    } catch (err) {
      setError(err);
    }
  };

  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <p className="muted">Loading…</p>;
  const { users, assignments, roles, org } = data.data;

  return (
    <>
      <PageHeader title="Users & roles" subtitle="Accounts and the roles that give them access." />
      {notice && <div className="notice">{notice}</div>}
      <ErrorNote error={error} />
      {canManage && <CreateUser onCreated={(u, pw) => {
        setNotice(<>Account created for <strong>{u.email}</strong>. Temporary password: <code>{pw}</code> — share it securely; it is shown only once.</>);
        data.reload();
      }} />}

      <section className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Roles</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {users.map((u) => {
                const mine = assignments.filter((a) => a.user_id === u.id && ['active', 'pending_approval'].includes(a.status));
                return (
                  <Fragment key={u.id}>
                  <tr>
                    <td><strong>{u.full_name}</strong><div className="muted small">{u.email}</div></td>
                    <td>
                      {mine.length === 0 && <span className="muted small">No roles</span>}
                      {mine.map((a) => (
                        <div key={a.id} className="role-line">
                          {a.role_name}{a.business_unit_name ? ` · ${a.business_unit_name}` : ''}{a.department_name ? ` · ${a.department_name}` : ''}{' '}
                          <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                          {canAssign && (!a.role_is_restricted || (canAssignRestricted && u.id !== me.user.id)) && (
                            <button className="link small" onClick={() => act(() => api.post(`/api/assignments/${a.id}/revoke`))}>Revoke</button>
                          )}
                        </div>
                      ))}
                    </td>
                    <td>
                      {u.is_active ? <Badge tone="good">Active</Badge> : <Badge tone="neutral">Deactivated</Badge>}
                      {u.is_protected && <Badge tone="accent">Protected</Badge>}
                      {u.lockout_until && new Date(u.lockout_until) > new Date() && <Badge tone="bad">Locked</Badge>}
                    </td>
                    <td className="small">{formatDateTime(u.last_login_at)}</td>
                    <td className="actions-cell">
                      {canAssign && u.id !== me.user.id && <button className="link" onClick={() => setAssigningFor(assigningFor === u.id ? null : u.id)}>Assign role</button>}
                      {canManage && u.id !== me.user.id && (!u.is_protected || canAssignRestricted) && (
                        <>
                          <button className="link" onClick={() => act(async () => {
                            const { temporaryPassword } = await api.post(`/api/users/${u.id}/reset-password`);
                            setNotice(<>New temporary password for <strong>{u.email}</strong>: <code>{temporaryPassword}</code></>);
                          })}>Reset password</button>
                          <button className="link" onClick={() => act(() => api.patch(`/api/users/${u.id}`, { isActive: !u.is_active, rowVersion: u.row_version }))}>
                            {u.is_active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {assigningFor === u.id && (
                    <tr>
                      <td colSpan={5}>
                        <AssignRole
                          user={u} roles={roles} org={org}
                          canAssignRestricted={canAssignRestricted}
                          onError={setError}
                          onDone={(a) => {
                            setAssigningFor(null);
                            setNotice(a.status === 'pending_approval'
                              ? `${a.role_name} in ${a.business_unit_name} was requested. It takes effect once the unit's partner approves it.`
                              : `${a.role_name} granted to ${u.full_name}.`);
                            data.reload();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function CreateUser({ onCreated }) {
  const [form, setForm] = useState({ email: '', fullName: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const { user, temporaryPassword } = await api.post('/api/users', form);
      setForm({ email: '', fullName: '' });
      onCreated(user, temporaryPassword);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <form className="card row wrap" onSubmit={submit}>
      <label className="grow">Full name<input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required /></label>
      <label className="grow">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
      <button className="primary align-end">Create account</button>
      <ErrorNote error={error} />
    </form>
  );
}

function AssignRole({ user, roles, org, canAssignRestricted, onDone, onError }) {
  const assignable = roles.filter((r) => !r.is_restricted || canAssignRestricted);
  const [roleId, setRoleId] = useState(assignable[0]?.id ?? '');
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const role = roles.find((r) => r.id === roleId);
  const units = useMemo(
    () => org.businessUnits.filter((bu) => !role?.partnership_only || bu.management_model === 'partnership'),
    [org, role]);
  const unit = org.businessUnits.find((bu) => bu.id === businessUnitId);
  const needsUnit = role && role.scope_level !== 'tenant';
  const needsDept = role?.scope_level === 'department';
  const needsApproval = unit?.management_model === 'partnership' && !role?.is_restricted
    && role?.permissions.some((p) => p.startsWith('fin.') || p.startsWith('cfg.'));

  const submit = async (e) => {
    e.preventDefault();
    try {
      onDone(await api.post('/api/assignments', {
        userId: user.id, roleId,
        businessUnitId: needsUnit ? businessUnitId : null,
        departmentId: needsDept ? departmentId : null,
      }));
    } catch (err) {
      onError(err);
    }
  };

  return (
    <form className="assign-form row wrap" onSubmit={submit}>
      <label>Role
        <select value={roleId} onChange={(e) => { setRoleId(e.target.value); setBusinessUnitId(''); setDepartmentId(''); }}>
          {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      {needsUnit && (
        <label>Business unit
          <select value={businessUnitId} onChange={(e) => { setBusinessUnitId(e.target.value); setDepartmentId(''); }} required>
            <option value="">Choose…</option>
            {units.map((bu) => <option key={bu.id} value={bu.id}>{bu.name}</option>)}
          </select>
        </label>
      )}
      {needsDept && (
        <label>Department
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required>
            <option value="">Choose…</option>
            {org.departments.filter((d) => d.business_unit_id === businessUnitId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      <button className="primary align-end">Assign</button>
      <p className="muted small full">
        {role?.description}
        {needsApproval && <strong> This grant includes finance or configuration access in a partnership unit, so the unit's partner must approve it.</strong>}
      </p>
    </form>
  );
}
