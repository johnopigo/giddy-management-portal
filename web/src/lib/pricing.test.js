import { describe, it, expect } from 'vitest';
import { ticketTotals, changeDue } from './pricing.js';

describe('ticketTotals (must match pos.checkout)', () => {
  it('applies service charge on net and VAT on net + service', () => {
    const t = ticketTotals([{ qty: 2, price: 800 }, { qty: 1, price: 2000 }], { servicePct: 10, vatPct: 7.5 });
    expect(t).toEqual({ subtotal: 3600, discount: 0, net: 3600, service: 360, tax: 297, total: 4257 });
  });
  it('takes the discount before charges', () => {
    const t = ticketTotals([{ qty: 1, price: 2000 }], { discountPct: 50, servicePct: 10, vatPct: 7.5 });
    expect(t.total).toBe(1182.5);
  });
  it('handles fractional quantities', () => {
    expect(ticketTotals([{ qty: 0.5, price: 801 }]).subtotal).toBe(400.5);
  });
});

describe('changeDue', () => {
  it('gives change only from cash', () => {
    expect(changeDue(946, [{ method: 'card', amount: 500 }, { method: 'cash', amount: 1000 }])).toEqual({ paid: 1500, remaining: 0, change: 554, valid: true });
    expect(changeDue(946, [{ method: 'card', amount: 5000 }]).valid).toBe(false);
    expect(changeDue(946, [{ method: 'cash', amount: 100 }])).toMatchObject({ remaining: 846, valid: false });
  });
});
