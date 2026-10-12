/**
 * Mirrors pos.checkout's arithmetic so the till can show totals before the sale is posted.
 * The server recalculates everything; these numbers are for display only.
 *   subtotal − discount = net; service charge on net; VAT on (net + service charge).
 */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function ticketTotals(lines, { discountPct = 0, servicePct = 0, vatPct = 0 } = {}) {
  const subtotal = round2(lines.reduce((s, l) => s + round2(Number(l.qty) * Number(l.price)), 0));
  const discount = round2((subtotal * discountPct) / 100);
  const net = round2(subtotal - discount);
  const service = round2((net * servicePct) / 100);
  const tax = round2(((net + service) * vatPct) / 100);
  return { subtotal, discount, net, service, tax, total: round2(net + service + tax) };
}

export function changeDue(total, payments) {
  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const cash = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const nonCash = paid - cash;
  return {
    paid: round2(paid),
    remaining: round2(Math.max(total - paid, 0)),
    change: round2(Math.max(paid - total, 0)),
    valid: paid >= total && nonCash <= total + 0.001,
  };
}
