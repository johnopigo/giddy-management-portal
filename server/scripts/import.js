// Imports existing records from CSV files through the portal's own API, as a named staff member:
// the same checks and permissions apply as on screen, and the audit trail shows who imported what.
// Dry run by default (checks every row and reports); add --commit to write.
//
//   npm run import -w server -- --as owner@example.com --kind customers --file customers.csv [--commit]
//
// Kinds and columns (templates in docs/import-templates):
//   customers      full_name, phone, email, date_of_birth
//   suppliers      name, contact_name, phone, email, tax_id, address
//   items          sku, name, uom, category, owner_unit, stockable, sellable
//   prices         sku, unit, sell_price, reorder_level, reorder_qty
//   room-types     code, name, description, max_adults, max_children, base_rate, amenities   (--unit, default the apartments unit)
//   rooms          room_number, room_type, floor, branch                                     (--unit, as above)
//   locations      unit, name, department, parent, branch  (a department's store sits under a main store: parent)
//   opening-stock  unit, location, sku, qty, unit_cost, batch_no, expiry_date
// Rows that already exist (same phone/email, SKU, code or room number) are skipped, so a file can be
// imported again after fixing the rows that failed.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { newSessionToken, hashToken } from '../src/auth/tokens.js';
import { closePools } from '../src/db/pool.js';

const KINDS = {
  customers: ['full_name', 'phone', 'email', 'date_of_birth'],
  suppliers: ['name', 'contact_name', 'phone', 'email', 'tax_id', 'address'],
  items: ['sku', 'name', 'uom', 'category', 'owner_unit', 'stockable', 'sellable'],
  prices: ['sku', 'unit', 'sell_price', 'reorder_level', 'reorder_qty'],
  'room-types': ['code', 'name', 'description', 'max_adults', 'max_children', 'base_rate', 'amenities'],
  rooms: ['room_number', 'room_type', 'floor', 'branch'],
  locations: ['unit', 'name', 'department', 'parent', 'branch'],
  'opening-stock': ['unit', 'location', 'sku', 'qty', 'unit_cost', 'batch_no', 'expiry_date'],
};
const REQUIRED = {
  customers: ['full_name'], suppliers: ['name'], items: ['sku', 'name', 'uom'], prices: ['sku', 'unit'],
  'room-types': ['code', 'name', 'base_rate'], rooms: ['room_number', 'room_type'], locations: ['unit', 'name'], 'opening-stock': ['unit', 'location', 'sku', 'qty'],
};

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  const [header = [], ...data] = nonEmpty;
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return { keys, records: data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()]))) };
}

const blank = (v) => v === undefined || v === '';
const num = (v, name) => {
  if (blank(v)) return undefined;
  const n = Number(String(v).replace(/[,₦\s]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`${name} "${v}" is not a number`);
  return n;
};
const int = (v, name) => { const n = num(v, name); if (n !== undefined && !Number.isInteger(n)) throw new Error(`${name} must be a whole number`); return n; };
const bool = (v, fallback) => (blank(v) ? fallback : /^(y|yes|true|1)$/i.test(v));
const date = (v, name) => {
  if (blank(v)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name} "${v}" must be written YYYY-MM-DD`);
  return v;
};

async function main() {
  process.env.ACCESS_LOG = 'false'; // the in-process API's requests are reported below instead
  const { values: args } = parseArgs({
    options: {
      as: { type: 'string' }, kind: { type: 'string' }, file: { type: 'string' }, unit: { type: 'string' }, commit: { type: 'boolean', default: false },
    },
  });
  if (!args.as || !KINDS[args.kind] || !args.file) {
    console.error(`Usage: npm run import -w server -- --as <staff email> --kind <${Object.keys(KINDS).join('|')}> --file <csv> [--unit CODE] [--commit]`);
    process.exit(2);
  }
  const { keys, records } = parseCsv(fs.readFileSync(args.file, 'utf8'));
  const missing = REQUIRED[args.kind].filter((k) => !keys.includes(k));
  if (missing.length) throw new Error(`The file has no ${missing.join(', ')} column. Expected columns: ${KINDS[args.kind].join(', ')}`);
  const unknown = keys.filter((k) => !KINDS[args.kind].includes(k));
  if (unknown.length) console.warn(`Ignoring columns: ${unknown.join(', ')}`);

  // A short-lived session for the named staff member, ended when the import finishes.
  const owner = new pg.Client({ connectionString: config.ownerDatabaseUrl });
  await owner.connect();
  const user = (await owner.query(
    `SELECT u.id, u.tenant_id, u.full_name FROM app_user u JOIN tenant t ON t.id = u.tenant_id
      WHERE u.email = $1::citext AND u.is_active AND NOT u.is_system AND t.status = 'active'`, [args.as])).rows[0];
  if (!user) throw new Error(`No active staff account for ${args.as}`);
  const token = newSessionToken();
  await owner.query(
    `INSERT INTO app_session (user_id, tenant_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, now() + interval '2 hours', $4)`,
    [user.id, user.tenant_id, hashToken(token), `import:${args.kind}`]);

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    for (;;) {
      const res = await fetch(base + path, {
        method, headers: { cookie: `giddy_session=${token}`, 'x-requested-with': 'giddy', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) { const e = new Error(data?.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
      return data;
    }
  };

  const report = { created: 0, skipped: 0, failed: 0, wouldCreate: 0 };
  try {
    const me = await call('GET', '/me');
    if (me.user?.must_change_password ?? me.mustChangePassword) throw new Error(`${args.as} must change their temporary password first.`);
    const org = await call('GET', '/org');
    const unitByCode = (code) => {
      const u = org.businessUnits.find((x) => x.code.toLowerCase() === String(code).toLowerCase() || x.name.toLowerCase() === String(code).toLowerCase());
      if (!u) throw new Error(`no business unit "${code}"`);
      return u;
    };
    const aptUnit = () => (args.unit ? unitByCode(args.unit) : org.businessUnits.find((u) => u.unit_type === 'apartments'));
    const cache = {};
    const once = async (key, fn) => (cache[key] ??= await fn());
    const catalog = () => once('catalog', () => call('GET', '/catalog'));
    const items = () => once('items', async () => new Map((await call('GET', '/catalog/items?includeInactive=true')).map((i) => [i.sku, i])));
    const setup = (bu) => once(`setup:${bu}`, () => call('GET', `/apartments/${bu}/setup`));
    const locations = (bu) => once(`loc:${bu}`, () => call('GET', `/inventory/${bu}/locations`));
    const itemBySku = async (sku) => {
      const i = (await items()).get(String(sku).trim().toUpperCase());
      if (!i) throw new Error(`no item with SKU "${sku}" (import items first)`);
      return i;
    };

    // Each kind: check(row) → { describe, write() }. check() throws for a bad row.
    const kinds = {
      async customers(r) {
        if (blank(r.phone) && blank(r.email)) throw new Error('a phone number or an email is needed');
        const body = { fullName: r.full_name, phone: r.phone || null, email: r.email || null, dateOfBirth: date(r.date_of_birth, 'date_of_birth') };
        return { describe: r.full_name, write: () => call('POST', '/customers', body) };
      },
      async suppliers(r) {
        const body = { name: r.name, contactName: r.contact_name || null, phone: r.phone || null, email: r.email || '', taxId: r.tax_id || null, address: r.address || null };
        return { describe: r.name, write: () => call('POST', '/suppliers', body) };
      },
      async items(r) {
        const sku = r.sku.toUpperCase();
        if ((await items()).has(sku)) return { skip: `${sku} already exists` };
        const owner = blank(r.owner_unit) ? null : unitByCode(r.owner_unit).id;
        return {
          describe: `${sku} ${r.name}`,
          write: async () => {
            const cat = await catalog();
            let uom = cat.uoms.find((u) => u.code === r.uom.toLowerCase() || u.name.toLowerCase() === r.uom.toLowerCase());
            if (!uom) { uom = await call('POST', '/catalog/uoms', { code: r.uom.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 16), name: r.uom }); cat.uoms.push(uom); }
            let category = blank(r.category) ? null : cat.categories.find((x) => x.name.toLowerCase() === r.category.toLowerCase());
            if (!blank(r.category) && !category) { category = await call('POST', '/catalog/categories', { name: r.category }); cat.categories.push(category); }
            const made = await call('POST', '/catalog/items', {
              sku, name: r.name, baseUomId: uom.id, categoryId: category?.id ?? null, ownerBusinessUnitId: owner,
              isStockable: bool(r.stockable, true), isSellable: bool(r.sellable, false),
            });
            (await items()).set(sku, { ...made, sku });
          },
        };
      },
      async prices(r) {
        const item = await itemBySku(r.sku);
        const unit = unitByCode(r.unit);
        const body = { sellPrice: num(r.sell_price, 'sell_price') ?? null, reorderLevel: num(r.reorder_level, 'reorder_level') ?? 0, reorderQty: num(r.reorder_qty, 'reorder_qty') ?? 0 };
        return { describe: `${item.sku} in ${unit.code}: ${body.sellPrice ?? 'no price'}`, write: () => call('PUT', `/catalog/items/${item.id}/units/${unit.id}`, body) };
      },
      async 'room-types'(r) {
        const unit = aptUnit();
        const code = r.code.toUpperCase();
        if ((await setup(unit.id)).roomTypes.some((t) => t.code === code)) return { skip: `${code} already exists` };
        const body = {
          code, name: r.name, description: r.description ?? '', maxAdults: int(r.max_adults, 'max_adults') ?? 2,
          maxChildren: int(r.max_children, 'max_children') ?? 0, baseRate: num(r.base_rate, 'base_rate'),
          amenities: blank(r.amenities) ? [] : r.amenities.split(/[;|]/).map((a) => a.trim()).filter(Boolean),
        };
        return { describe: `${code} ${r.name}`, write: async () => { (await setup(unit.id)).roomTypes.push(await call('POST', `/apartments/${unit.id}/room-types`, body)); } };
      },
      async rooms(r) {
        const unit = aptUnit();
        const s = await setup(unit.id);
        const type = s.roomTypes.find((t) => t.code === r.room_type.toUpperCase() || t.name.toLowerCase() === r.room_type.toLowerCase());
        if (!type) throw new Error(`no room type "${r.room_type}" (import room types first)`);
        if (s.rooms.some((x) => x.room_number === r.room_number)) return { skip: `room ${r.room_number} already exists` };
        const branch = blank(r.branch) ? org.branches[0] : org.branches.find((b) => b.name.toLowerCase() === r.branch.toLowerCase());
        if (!branch) throw new Error(`no branch "${r.branch}"`);
        return {
          describe: `room ${r.room_number} (${type.code})`,
          write: async () => { s.rooms.push(await call('POST', `/apartments/${unit.id}/rooms`, { roomNumber: r.room_number, roomTypeId: type.id, floor: r.floor || null, branchId: branch.id })); },
        };
      },
      async locations(r) {
        const unit = unitByCode(r.unit);
        const all = await locations(unit.id);
        if (all.some((l) => l.name.toLowerCase() === r.name.toLowerCase())) return { skip: `${r.name} already exists in ${unit.code}` };
        const branch = blank(r.branch) ? org.branches[0] : org.branches.find((b) => b.name.toLowerCase() === r.branch.toLowerCase());
        if (!branch) throw new Error(`no branch "${r.branch}"`);
        const dept = blank(r.department) ? null
          : org.departments.find((d) => d.business_unit_id === unit.id && d.name.toLowerCase() === r.department.toLowerCase());
        if (!blank(r.department) && !dept) throw new Error(`no department "${r.department}" in ${unit.code}`);
        const parent = !dept ? null : all.find((l) => l.tier === 'branch' && l.branch_id === branch.id
          && (blank(r.parent) || l.name.toLowerCase() === r.parent.toLowerCase()));
        if (dept && !parent) throw new Error(`a department store needs its main store${blank(r.parent) ? '' : ` "${r.parent}"`} first`);
        const body = { tier: dept ? 'department' : 'branch', name: r.name, branchId: branch.id, departmentId: dept?.id ?? null, parentLocationId: parent?.id ?? null };
        return { describe: `${r.name} (${unit.code})`, write: async () => { all.push(await call('POST', `/inventory/${unit.id}/locations`, body)); } };
      },
      async 'opening-stock'(r) {
        const unit = unitByCode(r.unit);
        const item = await itemBySku(r.sku);
        const loc = (await locations(unit.id)).find((l) => l.name.toLowerCase() === r.location.toLowerCase());
        if (!loc) throw new Error(`no stock location "${r.location}" in ${unit.code}`);
        const body = {
          type: 'opening_balance', itemId: item.id, qty: num(r.qty, 'qty'), toLocationId: loc.id, unitCost: num(r.unit_cost, 'unit_cost') ?? null,
          batchNo: r.batch_no || null, expiryDate: date(r.expiry_date, 'expiry_date'), reason: 'Opening stock (import)',
        };
        if (!(body.qty > 0)) throw new Error('qty must be more than 0');
        const moves = await call('GET', `/inventory/${unit.id}/movements?itemId=${item.id}&locationId=${loc.id}&limit=200`);
        if ((moves.items ?? moves).some((m) => (m.movement_type ?? m.type) === 'opening_balance' && (blank(r.batch_no) || m.batch_no === r.batch_no))) {
          return { skip: `${item.sku} already has an opening balance at ${loc.name}` };
        }
        return { describe: `${item.sku} × ${body.qty} at ${loc.name}`, write: () => call('POST', `/inventory/${unit.id}/movements`, body) };
      },
    };

    console.log(`${args.commit ? 'Importing' : 'Checking (dry run)'} ${records.length} ${args.kind} as ${user.full_name}…`);
    for (const [i, r] of records.entries()) {
      const line = i + 2; // the header is line 1
      try {
        const empty = REQUIRED[args.kind].filter((k) => blank(r[k]));
        if (empty.length) throw new Error(`${empty.join(', ')} ${empty.length > 1 ? 'are' : 'is'} empty`);
        const plan = await kinds[args.kind](r);
        if (plan.skip) { report.skipped++; console.log(`  line ${line}: skipped, ${plan.skip}`); continue; }
        if (!args.commit) { report.wouldCreate++; continue; }
        await plan.write();
        report.created++;
      } catch (err) {
        if (err.status === 409) { report.skipped++; console.log(`  line ${line}: skipped, already exists`); continue; }
        report.failed++;
        console.log(`  line ${line}: ${err.message}`);
      }
    }
  } finally {
    server.close();
    await owner.query('UPDATE app_session SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
    await owner.end();
    await closePools();
  }
  console.log(args.commit
    ? `Done: ${report.created} created, ${report.skipped} skipped, ${report.failed} failed.`
    : `Dry run: ${report.wouldCreate} would be created, ${report.skipped} skipped, ${report.failed} with problems. Nothing was written; add --commit to import.`);
  if (report.failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
