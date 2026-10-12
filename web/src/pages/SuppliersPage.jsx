import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useLoad.js';
import { useSession } from '../session.jsx';
import { hasTenantPermission, unitAccess } from '../lib/permissions.js';
import { ErrorNote, PageHeader } from '../components/ui.jsx';
import { UnitPicker, useSelectedUnit } from '../components/UnitPicker.jsx';

export function SuppliersPage() {
  const { me } = useSession();
  const units = me.scope.filter((s) => s.access.FIN || s.access.CFG);
  const [unitId, setUnitId] = useSelectedUnit(units, 'suppliers.unit');
  const suppliers = useLoad(() => api.get(`/api/suppliers${unitId ? `?businessUnitId=${unitId}` : ''}`), [unitId]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const canSeeAccounts = Boolean(unitAccess(me, unitId, 'FIN'));
  const canEditAccounts = unitAccess(me, unitId, 'FIN') === 'write';
  const unit = me.scope.find((s) => s.business_unit_id === unitId);

  const saveAccount = async (s, values) => {
    setError(null);
    try {
      await api.put(`/api/suppliers/${s.id}/units/${unitId}`, values);
      setEditing(null);
      suppliers.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader title="Suppliers" subtitle="One supplier list for the group; each unit keeps its own account and payment terms."
        actions={<UnitPicker units={units} value={unitId} onChange={setUnitId} />} />
      <ErrorNote error={error ?? suppliers.error} />
      <NewSupplier onCreated={suppliers.reload} />
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Supplier</th><th>Contact</th><th>Owned by</th>
                {canSeeAccounts && <><th>{unit?.name} account</th><th>Terms</th><th /></>}</tr>
            </thead>
            <tbody>
              {suppliers.data?.map((s) => (
                <tr key={s.id} className={s.is_active ? '' : 'dim'}>
                  <td><strong>{s.name}</strong>{s.tax_id && <div className="muted small">TIN {s.tax_id}</div>}</td>
                  <td className="small">{[s.contact_name, s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="small">{s.owner_business_unit_name ?? 'Group'}</td>
                  {canSeeAccounts && (editing === s.id
                    ? <AccountEditor supplier={s} onSave={(v) => saveAccount(s, v)} onCancel={() => setEditing(null)} />
                    : <>
                        <td className="small">{s.account_number ?? '—'}</td>
                        <td className="small">{s.account_number != null || s.payment_terms_days != null ? `${s.payment_terms_days ?? 0} days` : '—'}</td>
                        <td>{canEditAccounts && <button className="link" onClick={() => setEditing(s.id)}>{s.account_number != null || s.payment_terms_days != null ? 'Edit' : 'Set up'}</button>}</td>
                      </>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {suppliers.data?.length === 0 && <p className="muted">No suppliers yet.</p>}
      </section>
    </>
  );
}

function AccountEditor({ supplier, onSave, onCancel }) {
  const [v, setV] = useState({ accountNumber: supplier.account_number ?? '', paymentTermsDays: supplier.payment_terms_days ?? 0 });
  return (
    <>
      <td><input value={v.accountNumber} onChange={(e) => setV({ ...v, accountNumber: e.target.value })} placeholder="Account no." /></td>
      <td><input type="number" min="0" max="365" value={v.paymentTermsDays} onChange={(e) => setV({ ...v, paymentTermsDays: e.target.value })} /></td>
      <td className="actions-cell">
        <button className="primary small-btn" onClick={() => onSave({ accountNumber: v.accountNumber || null, paymentTermsDays: Number(v.paymentTermsDays) })}>Save</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </td>
    </>
  );
}

function NewSupplier({ onCreated }) {
  const { me } = useSession();
  const owners = [
    ...(hasTenantPermission(me, 'tenant.settings') ? [{ id: '', name: 'Group (all units)' }] : []),
    ...me.scope.filter((s) => s.access.CFG === 'write').map((s) => ({ id: s.business_unit_id, name: s.name })),
  ];
  const empty = { name: '', contactName: '', phone: '', email: '', taxId: '', ownerBusinessUnitId: owners[0]?.id ?? '' };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  if (owners.length === 0) return null;
  if (!open) return <div className="row"><button className="secondary" onClick={() => setOpen(true)}>+ New supplier</button></div>;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/suppliers', {
        name: form.name, contactName: form.contactName || null, phone: form.phone || null, email: form.email || null,
        taxId: form.taxId || null, ownerBusinessUnitId: form.ownerBusinessUnitId || null,
      });
      setForm(empty);
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="card form-grid" onSubmit={submit}>
      <h2 className="full">New supplier</h2>
      <label>Name<input value={form.name} onChange={set('name')} required /></label>
      <label>Contact person<input value={form.contactName} onChange={set('contactName')} /></label>
      <label>Phone<input value={form.phone} onChange={set('phone')} /></label>
      <label>Email<input type="email" value={form.email} onChange={set('email')} /></label>
      <label>Tax ID (TIN)<input value={form.taxId} onChange={set('taxId')} /></label>
      <label>Owned by
        <select value={form.ownerBusinessUnitId} onChange={set('ownerBusinessUnitId')}>
          {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <div className="full row">
        <ErrorNote error={error} />
        <button className="primary">Create supplier</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
