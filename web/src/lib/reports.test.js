import { describe, it, expect } from 'vitest';
import { compact, presetRange, UNIT_SLOT } from '../pages/ReportsPage.jsx';

describe('report helpers', () => {
  it('compacts axis values', () => {
    expect(compact(950)).toBe('950');
    expect(compact(1500)).toBe('1.5K');
    expect(compact(25000)).toBe('25K');
    expect(compact(2_400_000)).toBe('2.4M');
  });
  it('turns presets into date ranges', () => {
    expect(presetRange('today', '2026-10-12')).toEqual(['2026-10-12', '2026-10-12']);
    expect(presetRange('7d', '2026-10-12')).toEqual(['2026-10-06', '2026-10-12']);
    expect(presetRange('month', '2026-10-12')).toEqual(['2026-10-01', '2026-10-12']);
    expect(presetRange('last-month', '2026-01-15')).toEqual(['2025-12-01', '2025-12-31']);
    expect(presetRange('custom', '2026-10-12')).toBeNull();
  });
  it('gives each kind of unit a fixed colour slot', () => {
    expect(new Set(Object.values(UNIT_SLOT)).size).toBe(4);
  });
});
