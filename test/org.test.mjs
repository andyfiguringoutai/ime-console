import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.DB_PATH = '/tmp/ime-org.db';
process.env.NODE_ENV = 'test';
fs.rmSync(process.env.DB_PATH, { force: true });
const { seed } = await import('../db/seed.mjs');
seed({ fresh: true });
const { db } = await import('../src/db.mjs');
const { computeCoverage } = await import('../src/coverage.mjs');
const app = (await import('../src/server.mjs')).default;
const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}`;
const api = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-actor': 'test' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let pass = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok  ' + n); }
  catch (e) { console.log('  FAIL ' + n + ' -> ' + e.message); process.exitCode = 1; } };

console.log('\nORGANIZATIONS');
await t('the company hiding in the name field became an organization', () => {
  const p = db.prepare("SELECT p.full_name, o.name org, o.kind FROM physician p JOIN organization o ON o.id=p.organization_id WHERE p.full_name LIKE '%Pompan%'").get();
  assert.equal(p.org, 'ExamWorks');
  assert.equal(p.kind, 'ime_vendor');
  assert.equal(p.full_name, 'Donald C. Pompan', 'the org must be stripped from the name');
});
await t('org kinds are classified, not guessed uniformly', () => {
  const k = Object.fromEntries(db.prepare('SELECT name, kind FROM organization').all().map(r => [r.name, r.kind]));
  assert.equal(k['Healdsburg District Hospital'], 'hospital');
  assert.equal(k['Sierra Neurosurgery Group'], 'group');
  assert.equal(k['Pacific Evaluations'], 'ime_vendor');
});
await t('independents have no organization', () => {
  const p = db.prepare("SELECT organization_id FROM physician WHERE full_name LIKE '%Aimee V. Sanchez%'").get();
  assert.equal(p.organization_id, null);
});

console.log('\nSHARED SITES');
await t('a place is stored once and shared — only on a real address match', () => {
  const shared = db.prepare('SELECT * FROM v_shared_site').all();
  assert.equal(shared.length, 1, 'exactly one genuinely shared address in the export');
  assert.equal(shared[0].physician_count, 2);
});
await t('city centroids do NOT fuse unrelated practices', () => {
  const fresno = db.prepare("SELECT COUNT(*) c FROM site WHERE city='Fresno'").get().c;
  assert.ok(fresno > 5, `expected many distinct Fresno places, got ${fresno} — a coordinate match would have collapsed them to 1`);
});
await t('two physicians at one address share one site row', async () => {
  const a = (await api('POST', '/api/physicians', { full_name: 'Site Test A', primary_specialty_id: 4 })).body;
  const b = (await api('POST', '/api/physicians', { full_name: 'Site Test B', primary_specialty_id: 3 })).body;
  const addr = '1 Shared Plaza, Bakersfield';
  const la = (await api('POST', `/api/physicians/${a.id}/locations`, { city: 'Bakersfield', address_line: addr })).body;
  const lb = (await api('POST', `/api/physicians/${b.id}/locations`, { city: 'Bakersfield', address_line: addr })).body;
  assert.equal(la.site_id, lb.site_id, 'same address must resolve to the same site');
  const site = (await api('GET', `/api/sites/${la.site_id}`)).body;
  assert.equal(site.physicians.length, 2);
});
await t('fixing the address once fixes it for everyone there', async () => {
  const site = db.prepare("SELECT id FROM site WHERE address_line LIKE '%Shared Plaza%'").get();
  const link = db.prepare('SELECT id FROM physician_site WHERE site_id=?').get(site.id);
  await api('PATCH', `/api/locations/${link.id}`, { address_line: '1 Shared Plaza, Suite 400, Bakersfield' });
  const both = db.prepare('SELECT DISTINCT address_line FROM site WHERE id=?').all(site.id);
  assert.equal(both.length, 1);
  assert.match(both[0].address_line, /Suite 400/);
  // Remove the fixtures now: leaving a Bakersfield neurologist behind would
  // silently satisfy the Kern gap the travel tests below rely on.
  db.prepare("DELETE FROM physician WHERE full_name LIKE 'Site Test%'").run();
  db.prepare("DELETE FROM site WHERE address_line LIKE '%Shared Plaza%'").run();
});

console.log('\nTRAVEL POLICY');
const kernCardio = () => computeCoverage(db).cells.find(c => c.region === 'Kern / Bakersfield' && c.specialty === 'CARDIO');
await t('default is conservative: only their own offices count', () => {
  const modes = db.prepare('SELECT mode, COUNT(*) c FROM travel_policy GROUP BY mode').all();
  const none = modes.find(m => m.mode === 'none');
  assert.ok(none && none.c > 50, 'most providers should default to none');
});
await t('"travels anywhere" makes a distant physician reach every pin', async () => {
  const eureka = db.prepare("SELECT p.id FROM physician p JOIN specialty s ON s.id=p.primary_specialty_id WHERE s.code='PSYCH' AND p.full_name LIKE '%Morgan%'").get();
  const before = computeCoverage(db).cells.find(c => c.region === 'San Diego' && c.specialty === 'PSYCH');
  assert.equal(before.count, 0, 'Arcata is nowhere near San Diego');
  await api('PUT', `/api/physicians/${eureka.id}/travel`, { mode: 'anywhere', confirmed: true });
  const after = computeCoverage(db).cells.find(c => c.region === 'San Diego' && c.specialty === 'PSYCH');
  assert.equal(after.count, 1, 'travels-anywhere should reach San Diego');
  assert.equal(after.providers[0].reach, 'travels_anywhere');
  assert.ok(after.all_flyin, 'reached only by travel, so it is not a standing office');
  await api('PUT', `/api/physicians/${eureka.id}/travel`, { mode: 'none' });
  assert.equal(computeCoverage(db).cells.find(c => c.region === 'San Diego' && c.specialty === 'PSYCH').count, 0, 'reverting restores the gap');
});
await t('a travel radius reaches pins beyond the drive-time limit but not past the radius', async () => {
  const fresno = db.prepare("SELECT p.id FROM physician p JOIN specialty s ON s.id=p.primary_specialty_id WHERE s.code='NEURO' AND p.full_name LIKE '%Edmonds%'").get();
  const kernNeuro = () => computeCoverage(db).cells.find(c => c.region === 'Kern / Bakersfield' && c.specialty === 'NEURO');
  assert.equal(kernNeuro().count, 0, 'Fresno is ~2h44 from Bakersfield');
  await api('PUT', `/api/physicians/${fresno.id}/travel`, { mode: 'radius', radius_miles: 50 });
  assert.equal(kernNeuro().count, 0, '50 mi is not far enough (~132 mi away)');
  await api('PUT', `/api/physicians/${fresno.id}/travel`, { mode: 'radius', radius_miles: 150 });
  const c = kernNeuro();
  assert.equal(c.count, 1, '150 mi covers it');
  assert.equal(c.providers[0].reach, 'within_travel_radius');
  await api('PUT', `/api/physicians/${fresno.id}/travel`, { mode: 'none' });
});
await t('radius mode without a radius is rejected', async () => {
  const { status } = await api('PUT', '/api/physicians/1/travel', { mode: 'radius' });
  assert.equal(status, 400);
});
await t('travel changes are audited', () => {
  const rows = db.prepare("SELECT * FROM audit_log WHERE entity='travel_policy'").all();
  assert.ok(rows.length >= 3);
});

console.log('\nREGRESSION');
await t('coverage is unchanged by the whole refactor (39/104)', () => {
  const { summary } = computeCoverage(db);
  assert.equal(summary.cells_covered, 39);
  assert.equal(summary.metro_gaps, 26);
  assert.equal(summary.corridor_gaps, 39);
});
await t('the record carries org, colleagues and travel', async () => {
  const p = db.prepare("SELECT id FROM physician WHERE full_name LIKE '%Pompan%'").get();
  const { body } = await api('GET', `/api/physicians/${p.id}`);
  assert.equal(body.organization.name, 'ExamWorks');
  assert.ok(Array.isArray(body.colleagues));
  assert.ok(body.travel && body.travel.mode);
  assert.ok(body.locations[0].site_id);
});
srv.close();
console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
process.exit(process.exitCode || 0);
