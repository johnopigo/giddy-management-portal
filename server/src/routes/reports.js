import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';

// ---------------------------------------------------------------------------------------------
// Group reports. Everything is read under the caller's own access: a unit appears only if the
// caller may read its finances (row-level security does the filtering), so the Owner sees the
// group, a partner sees their unit, a unit manager sees theirs.
// ---------------------------------------------------------------------------------------------

const rangeQuery = z.object({ from: z.iso.date(), to: z.iso.date(), unitId: z.uuid().optional() });

const REVENUE = ['4000', '4200', '4300'];
const num = (x) => Number(x ?? 0);

export function reportRoutes() {
  const router = Router();

  router.get('/summary', async (req, res) => {
    const q = parse(rangeQuery, req.query);
    if (q.to < q.from) throw badRequest('The end date is before the start date.');
    const days = Math.round((new Date(q.to) - new Date(q.from)) / 86_400_000) + 1;
    if (days > 366) throw badRequest('Choose a period of a year or less.');

    const data = await req.db(async (c) => {
      const units = (await c.query(
        `SELECT id, code, name, unit_type, management_model FROM business_unit
          WHERE tenant_id = sec.current_tenant_id() AND is_active AND sec.has_scope(id, 'FIN') AND ($1::uuid IS NULL OR id = $1)
          ORDER BY CASE unit_type WHEN 'apartments' THEN 1 WHEN 'food_beverage' THEN 2 WHEN 'content_studio' THEN 3 ELSE 4 END`,
        [q.unitId ?? null])).rows;
      const ids = units.map((u) => u.id);
      if (ids.length === 0) return { units: [], daily: [], occupancy: [], appointments: [], topItems: [], settlements: [] };

      // Period movements by account (credit − debit: revenue and liabilities positive).
      const period = (await c.query(
        `SELECT e.business_unit_id AS unit_id, a.code, sum(l.credit - l.debit) AS amt,
                sum(l.debit - l.credit) FILTER (WHERE e.source_doc_type <> 'settlement') AS takings_amt
           FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id JOIN ledger_account a ON a.id = l.account_id
          WHERE e.business_unit_id = ANY ($3::uuid[]) AND e.entry_date BETWEEN $1 AND $2
          GROUP BY 1, 2`, [q.from, q.to, ids])).rows;
      // Balances at the end of the period (debit − credit: assets positive).
      const closing = (await c.query(
        `SELECT e.business_unit_id AS unit_id, a.code, sum(l.debit - l.credit) AS bal
           FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id JOIN ledger_account a ON a.id = l.account_id
          WHERE e.business_unit_id = ANY ($2::uuid[]) AND e.entry_date <= $1 AND a.code IN ('1100', '1200')
          GROUP BY 1, 2`, [q.to, ids])).rows;
      const amt = (u, code) => num(period.find((p) => p.unit_id === u && p.code === code)?.amt);
      const take = (u, code) => num(period.find((p) => p.unit_id === u && p.code === code)?.takings_amt);
      const bal = (u, code) => num(closing.find((p) => p.unit_id === u && p.code === code)?.bal);

      const unitRows = units.map((u) => {
        const net = REVENUE.reduce((s, code) => s + amt(u.id, code), 0);
        const cogs = -amt(u.id, '5000');
        return {
          ...u,
          net, serviceCharge: amt(u.id, '4100'), vat: amt(u.id, '2100'),
          cogs, grossProfit: net - cogs, marginPct: net ? Math.round(((net - cogs) / net) * 1000) / 10 : null,
          takings: { cash: take(u.id, '1000'), card: take(u.id, '1010'), transfer: take(u.id, '1020'), rooms: take(u.id, '1150') },
          openBills: bal(u.id, '1100'), stockValue: bal(u.id, '1200'),
          revenueShare: amt(u.id, '4400') - (-amt(u.id, '5400')),
        };
      });

      const daily = (await c.query(
        `SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.business_unit_id AS unit_id, sum(l.credit - l.debit) AS net
           FROM journal_line l JOIN journal_entry e ON e.id = l.journal_entry_id JOIN ledger_account a ON a.id = l.account_id
          WHERE e.business_unit_id = ANY ($3::uuid[]) AND e.entry_date BETWEEN $1 AND $2 AND a.code = ANY ($4::text[])
          GROUP BY 1, 2 ORDER BY 1`, [q.from, q.to, ids, REVENUE])).rows.map((r) => ({ ...r, net: num(r.net) }));

      // Apartments: occupancy, average daily rate, revenue per available room.
      const occupancy = [];
      for (const u of units.filter((x) => x.unit_type === 'apartments')) {
        const r = (await c.query(
          `SELECT (SELECT count(*) FROM room WHERE business_unit_id = $3 AND is_active)::int AS rooms,
                  (SELECT count(*) FROM room_night n JOIN room rm ON rm.id = n.room_id
                    WHERE rm.business_unit_id = $3 AND n.stay_date BETWEEN $1 AND $2)::int AS nights_sold`,
          [q.from, q.to, u.id])).rows[0];
        const available = r.rooms * days;
        const roomRevenue = amt(u.id, '4200');
        occupancy.push({
          unitId: u.id, unitName: u.name, rooms: r.rooms, availableNights: available, nightsSold: r.nights_sold,
          occupancyPct: available ? Math.round((r.nights_sold / available) * 1000) / 10 : null,
          roomRevenue, adr: r.nights_sold ? Math.round((roomRevenue / r.nights_sold) * 100) / 100 : null,
          revpar: available ? Math.round((roomRevenue / available) * 100) / 100 : null,
        });
      }

      // Spa and Studio: what happened to the appointments that fell in the period.
      const appointments = (await c.query(
        `SELECT bu.id AS unit_id, bu.name AS unit_name,
                count(a.*) FILTER (WHERE a.status = 'completed')::int AS completed,
                count(a.*) FILTER (WHERE a.status IN ('booked', 'checked_in'))::int AS upcoming,
                count(a.*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
                count(a.*) FILTER (WHERE a.status = 'no_show')::int AS no_show,
                count(a.*) FILTER (WHERE a.source = 'online')::int AS online,
                count(a.*)::int AS total
           FROM business_unit bu
           LEFT JOIN appointment a ON a.business_unit_id = bu.id
                AND (a.starts_at AT TIME ZONE bu.time_zone)::date BETWEEN $1 AND $2
          WHERE bu.id = ANY ($3::uuid[]) AND bu.unit_type IN ('spa', 'content_studio')
          GROUP BY bu.id, bu.name`, [q.from, q.to, ids])).rows.map((r) => ({ ...r, revenue: amt(r.unit_id, '4300') }));

      // Best sellers: till lines (less voids) and appointment add-ons (less removals), by net sales.
      const topItems = (await c.query(
        `WITH lines AS (
           SELECT t.business_unit_id AS unit_id, l.item_id, l.qty * CASE WHEN t.status = 'voided' THEN 0 ELSE 1 END AS qty,
                  round(l.line_total * (1 - t.discount_pct / 100), 2) * CASE WHEN t.status = 'voided' THEN 0 ELSE 1 END AS net
             FROM sale_line l JOIN sale_ticket t ON t.id = l.sale_ticket_id JOIN business_unit bu ON bu.id = t.business_unit_id
            WHERE t.business_unit_id = ANY ($3::uuid[]) AND (t.created_at AT TIME ZONE bu.time_zone)::date BETWEEN $1 AND $2
           UNION ALL
           SELECT be.business_unit_id, be.item_id, coalesce(be.qty, 0), be.amount
             FROM bill_entry be JOIN business_unit bu ON bu.id = be.business_unit_id
            WHERE be.business_unit_id = ANY ($3::uuid[]) AND be.entry_type = 'addon'
              AND (be.posted_at AT TIME ZONE bu.time_zone)::date BETWEEN $1 AND $2)
         SELECT i.name AS item_name, bu.name AS unit_name, sum(x.qty) AS qty, sum(x.net) AS net
           FROM lines x JOIN item i ON i.id = x.item_id JOIN business_unit bu ON bu.id = x.unit_id
          GROUP BY i.name, bu.name HAVING sum(x.net) <> 0 ORDER BY sum(x.net) DESC LIMIT 10`, [q.from, q.to, ids])).rows
        .map((r) => ({ ...r, qty: num(r.qty), net: num(r.net) }));

      const settlements = (await c.query(
        `SELECT DISTINCT ON (s.business_unit_id) s.business_unit_id AS unit_id, bu.name AS unit_name, s.statement_number,
                to_char(s.period_start, 'YYYY-MM-DD') AS period_start, s.status, s.payer, s.payee, s.amount
           FROM settlement_statement s JOIN business_unit bu ON bu.id = s.business_unit_id
          WHERE s.business_unit_id = ANY ($1::uuid[]) AND s.status <> 'withdrawn'
          ORDER BY s.business_unit_id, s.period_start DESC`, [ids])).rows.map((r) => ({ ...r, amount: num(r.amount) }));

      return { units: unitRows, daily, occupancy, appointments, topItems, settlements };
    });

    const sum = (f) => Math.round(data.units.reduce((s, u) => s + f(u), 0) * 100) / 100;
    res.json({
      from: q.from, to: q.to, days,
      totals: {
        net: sum((u) => u.net), serviceCharge: sum((u) => u.serviceCharge), vat: sum((u) => u.vat), cogs: sum((u) => u.cogs),
        grossProfit: sum((u) => u.grossProfit),
        takings: sum((u) => u.takings.cash + u.takings.card + u.takings.transfer),
        openBills: sum((u) => u.openBills), stockValue: sum((u) => u.stockValue),
      },
      ...data,
    });
  });

  return router;
}
