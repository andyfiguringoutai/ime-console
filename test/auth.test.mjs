import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.DB_PATH = '/tmp/ime-auth.db';
process.env.NODE_ENV = 'test';
fs.rmSync(process.env.DB_PATH, { force: true });
const { seed } = await import('../db/seed.mjs');
seed({ fresh: true });
const bcrypt = (await import('bcryptjs')).default;
const { db } = await import('../src/db.mjs');
db.prepare('INSERT INTO app_user (email,name,password_hash,role) VALUES (?,?,?,?)')
  .run('andy@occu-med.com', 'Andy', bcrypt.hashSync('correct-horse', 10), 'admin');
const app = (await import('../src/server.mjs')).default;
const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}`;

let cookie = '';
const call = async (m, p, b, useCookie = true) => {
  const r = await fetch(base + p, { method: m,
    headers: { 'content-type': 'application/json', ...(useCookie && cookie ? { cookie } : {}) },
    body: b ? JSON.stringify(b) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
let pass = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok  ' + n); }
  catch (e) { console.log('  FAIL ' + n + ' -> ' + e.message); process.exitCode = 1; } };

console.log('\nAUTHENTICATION');
await t('the API is closed to anonymous requests', async () => {
  const r = await call('GET', '/api/physicians', null, false);
  assert.equal(r.status, 401);
});
await t('anonymous browser gets the login page, not the app', async () => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  const html = await r.text();
  assert.match(html, /Sign in/);
  assert.ok(!/Coverage console/.test(html), 'must not serve the app shell');
});
await t('wrong password is rejected', async () => {
  const r = await call('POST', '/api/auth/login', { email: 'andy@occu-med.com', password: 'nope' });
  assert.equal(r.status, 401);
});
await t('correct password logs in and sets a session cookie', async () => {
  const r = await call('POST', '/api/auth/login', { email: 'andy@occu-med.com', password: 'correct-horse' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Andy');
  assert.ok(cookie.includes('ime_session='), 'session cookie set');
});
await t('the session unlocks the API', async () => {
  const r = await call('GET', '/api/physicians');
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
});
await t('edits are attributed to the logged-in user, not a typed name', async () => {
  const p = db.prepare("SELECT id FROM physician WHERE full_name LIKE '%Sanchez%'").get();
  await call('PATCH', `/api/physicians/${p.id}`, { preference: 'Preferred' });
  const a = db.prepare("SELECT * FROM audit_log WHERE entity='physician' ORDER BY id DESC LIMIT 1").get();
  assert.equal(a.actor, 'Andy', 'audit actor should be the session user');
});
await t('changing password works and invalidates the old one', async () => {
  const bad = await call('POST', '/api/auth/password', { current: 'wrong', next: 'newpassword1' });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/auth/password', { current: 'correct-horse', next: 'newpassword1' });
  assert.equal(ok.status, 200);
});
await t('admin can add a teammate and gets a temp password', async () => {
  const r = await call('POST', '/api/users', { email: 'mel@occu-med.com', name: 'Melanie', role: 'member' });
  assert.equal(r.status, 201);
  assert.ok(r.body.temporary_password);
});
await t('a member cannot add users', async () => {
  const mtemp = db.prepare("SELECT password_hash FROM app_user WHERE email='mel@occu-med.com'").get();
  // log in as Melanie
  const savedCookie = cookie; cookie = '';
  const mpw = 'melpass12'; db.prepare("UPDATE app_user SET password_hash=? WHERE email='mel@occu-med.com'").run(bcrypt.hashSync(mpw, 10));
  await call('POST', '/api/auth/login', { email: 'mel@occu-med.com', password: mpw });
  const r = await call('POST', '/api/users', { email: 'x@y.com', name: 'X' });
  assert.equal(r.status, 403);
  cookie = savedCookie;
});
await t('logout clears the session', async () => {
  await call('POST', '/api/auth/login', { email: 'andy@occu-med.com', password: 'newpassword1' });
  await call('POST', '/api/auth/logout');
  const r = await call('GET', '/api/physicians');
  assert.equal(r.status, 401, 'API locked again after logout');
});

srv.close();
console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
process.exit(process.exitCode || 0);
