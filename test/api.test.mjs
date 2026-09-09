import assert from 'node:assert/strict';
import fs from 'node:fs';

// MUST precede any import that reads DB_PATH — static imports hoist above this line,
// so everything below is loaded dynamically on purpose.
process.env.DB_PATH = '/tmp/ime-test.db';
process.env.NODE_ENV = 'test';
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);

const { seed } = await import('../db/seed.mjs');
seed({ fresh: true });

const { db } = await import('../src/db.mjs');
const { computeCoverage } = await import('../src/coverage.mjs');
const app = (await import('../src/server.mjs')).default;

const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}`;
const api = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-actor': 'test-suite' },
    body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); process.exitCode = 1; } };

console.log('\nCOVERAGE ENGINE');
await t('reproduces the static build exactly (39/104, 26 metro, 39 corridor)', () => {
  const { summary } = computeCoverage(db);
  assert.equal(summary.cells_total, 104);
  assert.equal(summary.cells_covered, 39);
  assert.equal(summary.metro_gaps, 26);
  assert.equal(summary.corridor_gaps, 39);
  assert.equal(summary.no_backup, 25);
});
await t('Kern / Bakersfield is empty in all four core specialties', () => {
  const { cells } = computeCoverage(db);
  const kern = cells.filter(c => c.region === 'Kern / Bakersfield');
  assert.equal(kern.length, 4);
  assert.ok(kern.every(c => c.count === 0), 'expected zero coverage');
});
await t('LA Basin has no neurologist within 60 min', () => {
  const { cells } = computeCoverage(db);
  assert.equal(cells.find(c => c.region === 'LA Basin' && c.specialty === 'NEURO').count, 0);
});
await t('specialty filter changes the denominator', () => {
  const { summary } = computeCoverage(db, { specialties: ['PSYCH', 'ORTHO', 'NEURO'] });
  assert.equal(summary.cells_total, 78);
});

console.log('\nSTANDARD & RADIUS');
await t('no-limit standard covers every cell', async () => {
  await api('PUT', '/api/settings/standard_minutes', { value: 9999 });
  const { body } = await api('GET', '/api/coverage');
  assert.equal(body.summary.cells_covered, 104);
  assert.equal(body.summary.metro_gaps, 0);
  await api('PUT', '/api/settings/standard_minutes', { value: 60 });
});
await t('per-region override beats the global standard', async () => {
  const regions = (await api('GET', '/api/regions')).body;
  const la = regions.find(r => r.name === 'LA Basin');
  await api('PUT', `/api/regions/${la.id}/radius`, { minutes: 95 });
  const { body } = await api('GET', '/api/coverage');
  const cell = body.cells.find(c => c.region === 'LA Basin' && c.specialty === 'NEURO');
  assert.equal(cell.limit_minutes, 95);
  assert.equal(cell.count, 1, 'Label in Thousand Oaks (~89 min) should now count');
  await api('PUT', `/api/regions/${la.id}/radius`, { minutes: null });
  const back = (await api('GET', '/api/coverage')).body.cells.find(c => c.region === 'LA Basin' && c.specialty === 'NEURO');
  assert.equal(back.count, 0, 'clearing the override restores the gap');
});
await t('depth 2 puts cells below target without inventing gaps', async () => {
  await api('PUT', '/api/targets', { all: 2 });
  const { summary } = (await api('GET', '/api/coverage')).body;
  assert.equal(summary.metro_gaps, 26, 'gaps are about zero coverage, not depth');
  assert.ok(summary.below_target > 65, 'more cells fall short at depth 2');
  await api('PUT', '/api/targets', { all: 1 });
});

console.log('\nPROVIDER MANAGEMENT');
let newId;
await t('create physician', async () => {
  const { status, body } = await api('POST', '/api/physicians',
    { full_name: 'Test Cardiologist', primary_specialty_id: 4, preference: 'Preferred', phone: '555' });
  assert.equal(status, 201); assert.ok(body.id); newId = body.id;
});
await t('adding a Bakersfield location geocodes and closes the Kern cardio gap', async () => {
  const before = computeCoverage(db).cells.find(c => c.region === 'Kern / Bakersfield' && c.specialty === 'CARDIO');
  assert.equal(before.count, 0);
  const { status, body } = await api('POST', `/api/physicians/${newId}/locations`,
    { city: 'Bakersfield', site_type: 'office', confirmation_status: 'confirmed' });
  assert.equal(status, 201);
  assert.ok(body.lat && body.lng, 'should geocode from the city gazetteer');
  assert.equal(body.geocode_source, 'city_centroid');
  const after = computeCoverage(db).cells.find(c => c.region === 'Kern / Bakersfield' && c.specialty === 'CARDIO');
  assert.equal(after.count, 1, 'gap should close');
  assert.equal(after.nearest_minutes, 0);
});
await t('ZIP works as a location too', async () => {
  const { body } = await api('POST', `/api/physicians/${newId}/locations`, { city: '92101', site_type: 'flyin' });
  assert.equal(body.geocode_source, 'zip_centroid');
  const sd = computeCoverage(db).cells.find(c => c.region === 'San Diego' && c.specialty === 'CARDIO');
  assert.equal(sd.count, 1);
  assert.ok(sd.all_flyin, 'fly-in only should be flagged');
});
await t('confirming a location stamps who and when', async () => {
  const locs = (await api('GET', `/api/physicians/${newId}`)).body.locations;
  // pick by state, not by position — ordering is a presentation decision
  const target = locs.find((l) => l.confirmation_status !== 'confirmed');
  assert.ok(target, 'expected an unconfirmed location to confirm');
  const { body } = await api('PATCH', `/api/locations/${target.id}`, { confirmation_status: 'confirmed' });
  assert.equal(body.confirmed_by, 'test-suite');
  assert.ok(body.confirmed_at);
});
await t('soft delete keeps history and removes coverage', async () => {
  await api('DELETE', `/api/physicians/${newId}`);
  const after = computeCoverage(db).cells.find(c => c.region === 'Kern / Bakersfield' && c.specialty === 'CARDIO');
  assert.equal(after.count, 0, 'deactivated physician stops counting');
  assert.ok(db.prepare('SELECT * FROM physician WHERE id=?').get(newId), 'row still exists');
});
await t('every mutation is audited with actor and before/after', async () => {
  const rows = db.prepare("SELECT * FROM audit_log WHERE actor='test-suite' ORDER BY id").all();
  assert.ok(rows.length >= 4, `expected audit trail, got ${rows.length}`);
  const del = rows.find(r => r.action === 'delete');
  assert.ok(del && JSON.parse(del.before_json).full_name === 'Test Cardiologist');
});

console.log('\nWORKFLOW');
await t('call sheet is seeded from unconfirmable records', async () => {
  const { body } = await api('GET', '/api/outreach?status=open');
  assert.equal(body.length, 15);
  assert.ok(body[0].prompt, 'each item says what to ask');
});
await t('resolving an outreach item stamps resolved_at', async () => {
  const open = (await api('GET', '/api/outreach')).body;
  const { body } = await api('PATCH', `/api/outreach/${open[0].id}`, { status: 'resolved', outcome_note: 'confirmed by phone' });
  assert.equal(body.status, 'resolved'); assert.ok(body.resolved_at);
  assert.equal((await api('GET', '/api/outreach?status=open')).body.length, 14);
});

console.log('\nLOOKUP');
await t('93301 resolves to Kern and ranks providers by drive time', async () => {
  const { body } = await api('GET', '/api/lookup?q=93301');
  assert.equal(body.region.name, 'Kern / Bakersfield');
  assert.ok(body.providers.length > 0);
  const m = body.providers.map(p => p.minutes);
  assert.deepEqual(m, [...m].sort((a, b) => a - b), 'sorted by drive time');
});
await t('unknown place 404s rather than guessing', async () => {
  assert.equal((await api('GET', '/api/lookup?q=Narnia')).status, 404);
});

srv.close();
console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
