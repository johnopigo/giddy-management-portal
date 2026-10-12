// The Spa: a partnership unit. The partner runs it; the Owner sees everything, read-only, sensitive
// records included; therapists see the health record only of clients they are treating. Every read
// of a sensitive record is audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, staffMember, ownerQuery, asUser } from './helpers.js';

let seed, owner, partner, ada, bisi;
let rAda, room, deep, express, guest, appt, later;
const SPA = () => `/api/bookings/${seed.units.SPA}`;
const day = (o) => { const d = new Date(Date.now() + 3600_000); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
const at = (date, hhmm) => `${date}T${hhmm}:00+01:00`;
const allDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: '00:00', closes: '24:00' }));
const startedAgo = (id, mins) => ownerQuery(
  `WITH a AS (UPDATE appointment SET starts_at = date_trunc('minute', now()) - make_interval(mins => $2),
                ends_at = date_trunc('minute', now()) - make_interval(mins => $2) + (ends_at - starts_at) WHERE id = $1 RETURNING starts_at, ends_at)
   UPDATE appointment_resource SET during = tstzrange((SELECT starts_at FROM a), (SELECT ends_at FROM a)) WHERE appointment_id = $1`, [id, mins]);
const intakeUrl = (c = guest.id) => `${SPA()}/clients/${c}/intake`;
const FORM = {
  healthConditions: 'Mild hypertension', allergies: 'Nut oils', medications: 'Amlodipine', pregnant: false,
  skinType: 'Combination', preferences: 'Medium pressure, no lavender', emergencyContact: 'Chidi 08030000009',
};

before(async () => {
  seed = await resetDatabase();
  [owner, partner] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local')]);
  ada = await staffMember(owner, { email: 'ada@test.local', role: 'STAFF', businessUnitId: seed.units.SPA });
  bisi = await staffMember(owner, { email: 'bisi@test.local', role: 'STAFF', businessUnitId: seed.units.SPA });
  rAda = (await partner.post(`${SPA()}/resources`, { kind: 'staff', name: 'Ada', userId: ada.userId, hours: allDay })).body;
  await partner.post(`${SPA()}/resources`, { kind: 'staff', name: 'Bisi', userId: bisi.userId, hours: allDay });
  room = (await partner.post(`${SPA()}/resources`, { kind: 'room', name: 'Room 1', hours: allDay })).body;
  const svc = async (code, name, requiresIntake) => (await partner.post(`${SPA()}/services`, {
    code, name, mode: 'service', durationMin: 60, price: 40000, requiresIntake,
    resources: [{ resourceId: rAda.id, role: 'therapist' }, { resourceId: room.id, role: 'room' }],
  })).body;
  deep = await svc('DEEP', 'Deep tissue massage', true);
  express = await svc('EXP', 'Express manicure', false);
  guest = (await partner.post('/api/customers', { fullName: 'Ngozi Obi', phone: '08037770000' })).body;
  appt = (await partner.post(`${SPA()}/appointments`, { serviceId: deep.id, customerId: guest.id, startsAt: at(day(2), '10:00') })).body.id;
  later = (await partner.post(`${SPA()}/appointments`, { serviceId: express.id, customerId: guest.id, startsAt: at(day(2), '15:00') })).body.id;
});
after(closePools);

test('the Owner sees everything in the Spa, sensitive data included, read-only', async () => {
  const spa = (await owner.get('/api/me')).body.scope.find((s) => s.code === 'SPA');
  assert.deepEqual(spa.access, { OPS: 'read', FIN: 'read', CFG: 'read', SEN: 'read' });
  assert.ok((await owner.get(`${SPA()}/appointments/${appt}`)).body.bill, 'the bill too');
  assert.equal((await owner.post(intakeUrl(), { ...FORM, consentGiven: false })).status, 403);
});

test('a treatment that needs an intake cannot start without a current, consented one', async () => {
  await startedAgo(appt, 5);
  let r = await partner.post(`${SPA()}/appointments/${appt}/check-in`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /intake form/i);
  assert.equal((await partner.get(`${SPA()}/appointments/${appt}`)).body.intake.on_file, false);

  assert.equal((await partner.post(intakeUrl(), { ...FORM, consentGiven: false })).status, 201);
  r = await partner.post(`${SPA()}/appointments/${appt}/check-in`);
  assert.equal(r.status, 400, 'on file, but no consent');
  assert.equal((await partner.post(intakeUrl(), { ...FORM, consentGiven: true })).status, 400, 'consent needs the client\'s name');
  const v2 = await partner.post(intakeUrl(), { ...FORM, consentGiven: true, consentName: 'Ngozi Obi' });
  assert.equal(v2.status, 201);
  assert.equal(v2.body.version, 2);

  const status = (await partner.get(`${SPA()}/appointments/${appt}`)).body.intake;
  assert.equal(status.version, 2);
  assert.equal(status.is_current, true);
  assert.equal((await partner.post(`${SPA()}/appointments/${appt}/check-in`)).status, 204);
});

test('intake forms expire after the unit\'s validity period', async () => {
  const setting = (v) => partner.put(`/api/org/business-units/${seed.units.SPA}/settings/spa.intake_valid_months`, { value: v });
  assert.equal((await setting(0)).status, 200);
  assert.equal((await partner.get(`${SPA()}/appointments/${appt}`)).body.intake.is_current, false);
  await setting(12);
  assert.equal((await partner.get(`${SPA()}/appointments/${appt}`)).body.intake.is_current, true);
});

test('who may read the health record: sensitive access, or the therapist treating the client', async () => {
  const forPartner = await partner.get(intakeUrl());
  assert.equal(forPartner.status, 200);
  assert.equal(forPartner.body.allergies, 'Nut oils');
  assert.equal(forPartner.body.version, 2);
  assert.equal(forPartner.body.recorded_by_name, 'Spa Partner');
  assert.equal((await partner.get(`${intakeUrl()}?version=1`)).body.consent_given, false);
  assert.equal((await owner.get(intakeUrl())).status, 200, 'the Owner reads it');
  assert.equal((await ada.api.get(intakeUrl())).status, 200, 'Ada is treating her today');
  assert.equal((await bisi.api.get(intakeUrl())).status, 403, 'Bisi is not');
  const detail = (await bisi.api.get(`${SPA()}/appointments/${appt}`));
  assert.equal(detail.status, 404, 'nor does Bisi see the booking');
});

test('reading a health record is audited; its contents never reach the audit log', async () => {
  const log = (await owner.get(`/api/audit?businessUnitId=${seed.units.SPA}&limit=200`)).body;
  const views = log.filter((e) => e.action === 'sensitive_view' && e.entity === 'client_intake');
  const who = new Set(views.map((e) => e.user_name));
  assert.ok(who.has('Owner') && who.has('Spa Partner') && who.has('ada'), [...who].join(','));
  assert.ok(!JSON.stringify(log).includes('Nut oils'), 'no health details in the audit log');
  assert.ok(log.some((e) => e.entity === 'client_intake' && e.action === 'insert' && e.after_data.version === 2));
});

test('the tables themselves are closed: only the audited functions read them', async () => {
  await assert.rejects(asUser(seed.users.partner, seed.tenantId, 'SELECT * FROM client_intake'), /permission denied/);
  await assert.rejects(asUser(seed.users.owner, seed.tenantId, 'SELECT * FROM treatment_note'), /permission denied/);
});

test('treatment notes: the therapist on the appointment writes them once the client has arrived', async () => {
  const early = await ada.api.post(`${SPA()}/appointments/${later}/notes`, { body: 'Too early' });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /arrived/);
  const n = await ada.api.post(`${SPA()}/appointments/${appt}/notes`, {
    body: 'Focus on shoulders and lower back.', productsUsed: 'Grapeseed oil (nut-free)', reaction: 'None',
  });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  assert.equal((await bisi.api.post(`${SPA()}/appointments/${appt}/notes`, { body: 'Not mine' })).status, 404);
  assert.equal((await owner.post(`${SPA()}/appointments/${appt}/notes`, { body: 'Owner note' })).status, 403);
  const notes = (await owner.get(`${SPA()}/clients/${guest.id}/notes`)).body;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].written_by_name, 'ada');
  assert.equal(notes[0].products_used, 'Grapeseed oil (nut-free)');
  assert.equal((await bisi.api.get(`${SPA()}/clients/${guest.id}/notes`)).status, 403);
  const log = (await partner.get(`/api/audit?businessUnitId=${seed.units.SPA}&entity=treatment_note`)).body;
  assert.ok(log.some((e) => e.action === 'sensitive_view' && e.user_name === 'Owner'));
});

test('services that do not need an intake check in as before', async () => {
  const other = (await partner.post('/api/customers', { fullName: 'Walk In', phone: '08037770001' })).body;
  const q2 = (await partner.post(`${SPA()}/appointments`, { serviceId: express.id, customerId: other.id, startsAt: at(day(3), '12:00') })).body.id;
  await startedAgo(q2, 120);
  assert.equal((await partner.post(`${SPA()}/appointments/${q2}/check-in`)).status, 204);
  assert.equal((await partner.get(`${SPA()}/setup`)).body.services.find((s) => s.code === 'DEEP').requires_intake, true);
});

test('every change is in the audit chain', async () => {
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
