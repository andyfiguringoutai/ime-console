import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.DB_PATH = '/tmp/ime-ui.db';
process.env.DOC_STORE = '/tmp/ime-ui-docs';
process.env.NODE_ENV = 'test';
for (const p of [process.env.DB_PATH, process.env.DOC_STORE]) fs.rmSync(p, { recursive: true, force: true });
const { seed } = await import('../db/seed.mjs');
seed({ fresh: true });
const app = (await import('../src/server.mjs')).default;
const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}`;

const html = fs.readFileSync('public/index.html', 'utf8').replace('/app.js', base + '/app.js');
const errs = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, resources: 'usable', url: base + '/',
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    // jsdom has no fetch, and Node's global fetch does not resolve relative URLs
    // against the document base. The app legitimately uses "/api/...".
    w.fetch = (u, o = {}) => fetch(new URL(u, base), { ...o, headers: { ...(o.headers||{}), 'x-actor': 'UI Test' } });
    w.FormData = FormData; w.Blob = Blob; w.Headers = Headers;
    w.addEventListener('error', (e) => errs.push(String(e.error?.message || e.message)));
    w.console.error = (...a) => errs.push(String(a[0]).slice(0, 160));
  },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = () => { const c = dom.window.document.body.cloneNode(true); c.querySelectorAll('script').forEach((s) => s.remove()); return c.textContent; };
let pass = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok  ' + n); }
  catch (e) { console.log('  FAIL ' + n + ' -> ' + e.message); process.exitCode = 1; } };

await wait(4000);
const d = dom.window.document, W = dom.window;

console.log('\nUI RENDER (against the live API)');
await t('app boots and loads the network from the server', () => {
  assert.ok(!d.querySelector('#boot'), 'boot placeholder should be gone');
  assert.match(vis(), /Coverage console/);
  assert.match(vis(), /39\/104/, 'coverage should come from the API');
});
await t('providers tab renders master/detail', async () => {
  [...d.querySelectorAll('nav button')].find((b) => b.textContent.trim().startsWith('Providers')).dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await wait(900);
  const search = [...d.querySelectorAll('input')].find((i) => /Search \d+ providers/.test(i.placeholder || ''));
  assert.ok(search, 'list rail search present');
  assert.match(search.placeholder, /Search 78 providers/, 'count should be derived from the data');
  assert.match(vis(), /Coverage claim/, 'trust strip present');
});
await t('the trust strip states what can be claimed', () => {
  const t2 = vis();
  assert.ok(/inferred from the source export, never verified|confirmed directly with the provider|invisible to the map/.test(t2),
    'expected a provenance sentence');
});
await t('record shows locations, contacts, correspondence, documents and fees', () => {
  const t2 = vis();
  for (const h of ['Where they sit', 'Who to call', 'Correspondence', 'On file', 'What they charge'])
    assert.match(t2, new RegExp(h), `missing section: ${h}`);
});
await t('contacts render as people with roles and clickable methods', () => {
  const tels = [...d.querySelectorAll('a[href^="tel:"]')];
  const mails = [...d.querySelectorAll('a[href^="mailto:"]')];
  assert.ok(tels.length + mails.length > 0, 'expected click-to-call / click-to-email links');
  assert.ok(tels.every((a) => /^tel:\+1\d{10}$/.test(a.getAttribute('href'))), 'tel: links must use the normalized number');
});
await t('selecting Busfield shows both emails and both people', async () => {
  const btn = [...d.querySelectorAll('button')].find((b) => b.textContent.includes('Benjamin Busfield'));
  btn.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await wait(800);
  const t2 = vis();
  assert.match(t2, /expert@diabloortho\.com/);
  assert.match(t2, /busfieldmd@gmail\.com/);
  assert.match(t2, /Grave Busfield/);
});
await t('empty states say something useful rather than nothing', () => {
  const t2 = vis();
  assert.match(t2, /No rates on file|Nothing on file/);
});
await t('map dots and provider names open the record', async () => {
  [...d.querySelectorAll('nav button')].find((b) => b.textContent.trim() === 'Map').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await wait(1000);
  // check the dots while the map is still on screen — clicking a name navigates away
  const dots = [...d.querySelectorAll('svg circle')].filter((c) => c.style.cursor === 'pointer' && c.querySelector('title')?.textContent.includes('click to open'));
  assert.ok(dots.length > 0, 'provider dots should be clickable');
  const names = [...d.querySelectorAll('button')].filter((b) => /^Open /.test(b.title || ''));
  assert.ok(names.length > 0, 'who-reaches-this-pin names must be clickable');
  const who = names[0].title.replace('Open ', '');
  names[0].dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await wait(1000);
  assert.match(vis(), /Coverage claim/, 'clicking a provider on the map lands on their record');
  assert.ok(vis().includes(who.split(' ')[0]), 'the record shown is the provider clicked');
});
await t('record shows organization, colleagues and travel policy', () => {
  const t2 = vis();
  assert.match(t2, /Will they travel\?/);
  assert.match(t2, /Their offices only|Anywhere in California/);
  assert.ok(/INDEPENDENT|PRACTICE|IME VENDOR|GROUP|HOSPITAL/.test(t2), 'org line missing');
});
await t('no runtime errors', () => {
  const real = errs.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
  assert.deepEqual(real, [], real.join(' | '));
});

srv.close();
console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
process.exit(process.exitCode || 0);
