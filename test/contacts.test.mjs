import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DB_PATH = '/tmp/ime-contacts.db';
process.env.DOC_STORE = '/tmp/ime-docs';
process.env.NODE_ENV = 'test';
for (const p of [process.env.DB_PATH, '/tmp/ime-docs']) fs.rmSync(p, { recursive: true, force: true });

const { seed } = await import('../db/seed.mjs');
seed({ fresh: true });
const { db } = await import('../src/db.mjs');
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

const pid = db.prepare("SELECT id FROM physician WHERE full_name LIKE '%Busfield%'").get().id;

console.log('\nCONTACT STRUCTURE (from the messy export)');
await t("Busfield's two-emails-in-one-field became two rows", async () => {
  const { body } = await api('GET', `/api/physicians/${pid}/contacts`);
  const emails = body.methods.filter(m => m.kind === 'email');
  assert.equal(emails.length, 2);
  assert.ok(emails.some(e => e.value === 'expert@diabloortho.com'));
  assert.ok(emails.some(e => e.value === 'busfieldmd@gmail.com'));
  assert.equal(emails.filter(e => e.is_primary).length, 1);
});
await t('"Benjamin/Grave Busfield" became two people', async () => {
  const { body } = await api('GET', `/api/physicians/${pid}/contacts`);
  assert.deepEqual(body.people.map(p => p.name).sort(), ['Benjamin Busfield', 'Grave Busfield']);
});
await t('"Lou Lor - Case Manager" keeps the role and drops the honorific', () => {
  const rows = db.prepare("SELECT * FROM contact_person WHERE name='Lou Lor'").all();
  assert.equal(rows.length, 2, 'one row per practice, same canonical name');
  assert.ok(rows.some(r => r.role === 'Case Manager'));
});
await t('every phone in the network normalizes to E.164', () => {
  const r = db.prepare("SELECT COUNT(*) c, SUM(CASE WHEN value_normalized LIKE '+1%' THEN 1 ELSE 0 END) ok FROM contact_method WHERE kind IN ('phone','fax')").get();
  assert.equal(r.c, r.ok, `${r.c - r.ok} phones failed to normalize`);
});
await t("Angelos's hidden second number was found", () => {
  const rows = db.prepare(`SELECT cm.* FROM contact_method cm JOIN physician p ON p.id=cm.physician_id
    WHERE p.full_name LIKE '%Angelos%' AND cm.kind='phone'`).all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.value_normalized).sort(), ['+18052526286', '+18059626222']);
});
await t('adding a pasted multi-number field splits it on the way in', async () => {
  const { status, body } = await api('POST', `/api/physicians/${pid}/contacts/methods`,
    { kind: 'phone', value: '(office) 925.555.1111 (cell) 925.555.2222', purpose: 'scheduling' });
  assert.equal(status, 201);
  assert.ok(Array.isArray(body) && body.length === 2, 'should return two rows');
  assert.equal(body[0].value_normalized, '+19255551111');
});
await t('a phone extension survives without corrupting the number', async () => {
  const { body } = await api('POST', `/api/physicians/${pid}/contacts/methods`, { kind: 'phone', value: '818-806-8830 x 1' });
  assert.equal(body.value_normalized, '+18188068830');
  assert.match(body.value, /x1/);
});
await t('garbage is rejected rather than stored', async () => {
  const { status } = await api('POST', `/api/physicians/${pid}/contacts/methods`, { kind: 'phone', value: 'call the office' });
  assert.equal(status, 400);
});
await t('search finds everyone sharing a number, however it was typed', async () => {
  const { body } = await api('GET', '/api/contacts/search?q=(415) 310-7634');
  assert.ok(body.length >= 1);
  assert.ok(body.some(m => m.full_name.includes('Busfield')));
});
await t('verifying a method stamps who and when', async () => {
  const { body: c } = await api('GET', `/api/physicians/${pid}/contacts`);
  const { body } = await api('PATCH', `/api/contacts/methods/${c.methods[0].id}`, { verified: true });
  assert.equal(body.verified_by, 'test');
  assert.ok(body.verified_at);
});

console.log('\nCORRESPONDENCE');
let corrId;
await t('logging a call links to the outreach item it served', async () => {
  const oid = db.prepare('SELECT id FROM outreach LIMIT 1').get().id;
  const opid = db.prepare('SELECT physician_id FROM outreach WHERE id=?').get(oid).physician_id;
  const { status, body } = await api('POST', `/api/physicians/${opid}/correspondence`, {
    direction: 'outbound', channel: 'phone', subject: 'Coverage confirmation',
    body: 'Confirmed Fresno + Clovis, both her own offices. Will not travel.', outreach_id: oid,
  });
  assert.equal(status, 201); assert.equal(body.logged_by, 'test'); assert.equal(body.outreach_id, oid);
  corrId = body.id;
});
await t('the thread reads back with person and outreach context', async () => {
  const opid = db.prepare('SELECT physician_id FROM correspondence WHERE id=?').get(corrId).physician_id;
  const { body } = await api('GET', `/api/physicians/${opid}/correspondence`);
  assert.equal(body.length, 1);
  assert.equal(body[0].outreach_purpose, 'confirm_coverage');
  assert.deepEqual(body[0].attachments, []);
});
await t('the network-wide activity feed works', async () => {
  const { body } = await api('GET', '/api/correspondence?limit=10');
  assert.ok(body.length >= 1); assert.ok(body[0].full_name);
});

console.log('\nDOCUMENT STORAGE');
let docId;
const put = async (p, name, type, fields = {}) => {
  const fd = new FormData();
  fd.set('file', new Blob([fs.readFileSync(p)], { type: 'application/pdf' }), name);
  fd.set('doc_type', type);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const r = await fetch(`${base}/api/physicians/${pid}/documents`, { method: 'POST', headers: { 'x-actor': 'test' }, body: fd });
  return { status: r.status, body: await r.json() };
};
fs.writeFileSync('/tmp/cv-v1.pdf', '%PDF-1.4 fake cv version one');
fs.writeFileSync('/tmp/cv-v2.pdf', '%PDF-1.4 fake cv version two, updated');
fs.writeFileSync('/tmp/fees.pdf', '%PDF-1.4 IME $3500, record review $450/hr');

await t('upload a CV — bytes land on disk with a checksum', async () => {
  const { status, body } = await put('/tmp/cv-v1.pdf', 'sanchez-cv.pdf', 'cv', { title: 'CV 2026' });
  assert.equal(status, 201);
  assert.equal(body.version, 1); assert.equal(body.is_current, 1);
  assert.ok(body.sha256 && body.sha256.length === 64);
  assert.ok(fs.existsSync(path.join(process.cwd(), body.storage_path)), 'file must exist on disk');
  docId = body.id;
});
await t('download returns the same bytes', async () => {
  const r = await fetch(`${base}/api/documents/${docId}/file`, { headers: { 'x-actor': 'test' } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '%PDF-1.4 fake cv version one');
});
await t('re-uploading identical bytes dedupes instead of duplicating', async () => {
  const { status, body } = await put('/tmp/cv-v1.pdf', 'sanchez-cv.pdf', 'cv');
  assert.equal(status, 200); assert.equal(body.deduped, true); assert.equal(body.id, docId);
});
await t('the same bytes filed under a different doc_type is NOT a dupe', async () => {
  const { status, body } = await put('/tmp/cv-v1.pdf', 'combined.pdf', 'report_sample');
  assert.equal(status, 201, 'dedupe must be scoped by doc_type');
  assert.ok(!body.deduped);
});
await t('a new CV supersedes the old one and bumps the version', async () => {
  const { body } = await put('/tmp/cv-v2.pdf', 'sanchez-cv-2026.pdf', 'cv');
  assert.equal(body.version, 2);
  assert.equal(body.supersedes_id, docId);
  assert.equal(db.prepare('SELECT is_current FROM document WHERE id=?').get(docId).is_current, 0, 'v1 is no longer current');
  const { body: cur } = await api('GET', `/api/physicians/${pid}/documents?doc_type=cv&current_only=true`);
  assert.equal(cur.length, 1); assert.equal(cur[0].version, 2);
});
await t('a fee schedule is just another document type', async () => {
  const { body } = await put('/tmp/fees.pdf', 'fee-schedule.pdf', 'fee_schedule', { effective_on: '2026-01-01' });
  assert.equal(body.doc_type, 'fee_schedule');
  // and a fee rate can point back at the PDF it came from
  const { body: fee } = await api('POST', `/api/physicians/${pid}/fees`, { service_code: 'IME', amount_cents: 350000, unit: 'flat' });
  db.prepare('UPDATE fee SET document_id=? WHERE id=?').run(body.id, fee.id);
  const joined = db.prepare('SELECT f.amount_cents, d.filename FROM fee f JOIN document d ON d.id=f.document_id WHERE f.id=?').get(fee.id);
  assert.equal(joined.filename, 'fee-schedule.pdf');
  assert.equal(joined.amount_cents, 350000);
});
await t('an unknown doc_type is refused and the temp file cleaned up', async () => {
  const before = fs.readdirSync(path.join('/tmp/ime-docs', String(pid))).length;
  const { status } = await put('/tmp/cv-v1.pdf', 'x.pdf', 'not_a_type');
  assert.equal(status, 400);
  assert.equal(fs.readdirSync(path.join('/tmp/ime-docs', String(pid))).length, before, 'no orphan file left behind');
});
await t('expiring credentials surface as a queue', async () => {
  const soon = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync('/tmp/license.pdf', '%PDF-1.4 CA psychology license PSY12345');
  await put('/tmp/license.pdf', 'license.pdf', 'licensure', { expires_on: soon });
  const { body } = await api('GET', '/api/documents/expiring?days=90');
  assert.ok(body.some(d => d.doc_type === 'licensure' && d.days_remaining <= 21));
});
await t('deleting a document removes the row and the bytes', async () => {
  const { body: docs } = await api('GET', `/api/physicians/${pid}/documents?doc_type=fee_schedule`);
  const abs = path.join(process.cwd(), docs[0].storage_path);
  assert.ok(fs.existsSync(abs));
  await api('DELETE', `/api/documents/${docs[0].id}`);
  assert.ok(!fs.existsSync(abs), 'bytes should be gone');
});

srv.close();
console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
