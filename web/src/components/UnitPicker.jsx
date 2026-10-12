import { useState } from 'react';
import { useSession } from '../session.jsx';

/** The business units the user can access for a data class. */
export function useUnitChoices(dataClass) {
  const { me } = useSession();
  return me.scope.filter((s) => s.access[dataClass]);
}

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * Selected business unit for a page, defaulting to the last one chosen there (a convenience
 * kept in localStorage) or the first available. Resolved during render, so there is no
 * moment where the page has no unit or shows the wrong one.
 */
export function useSelectedUnit(units, storageKey) {
  const [chosen, setChosen] = useState(() => readStored(storageKey));
  const valid = units.some((u) => u.business_unit_id === chosen) ? chosen : units[0]?.business_unit_id ?? null;
  const select = (id) => {
    try { localStorage.setItem(storageKey, id); } catch { /* storage unavailable */ }
    setChosen(id);
  };
  return [valid, select];
}

export function UnitPicker({ units, value, onChange }) {
  if (units.length === 0) return null;
  return (
    <label className="unit-picker">Business unit
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {units.map((u) => <option key={u.business_unit_id} value={u.business_unit_id}>{u.name}</option>)}
      </select>
    </label>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={value === key ? 'tab active' : 'tab'} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function formatQty(n) {
  return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 3 });
}

export function formatMoney(n, currency = 'NGN') {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-GB', { style: 'currency', currency, minimumFractionDigits: 2 });
}
