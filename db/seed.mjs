import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from './migrate.mjs';
import { normalizeValue, splitMulti, parsePhones, parseContactPeople, personKey, parseOrganization } from '../src/normalize.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');
// resolved lazily: a static const would freeze the path at import time,
// before a caller has a chance to set DB_PATH.
const dbPath = () => process.env.DB_PATH || path.join(ROOT, 'data', 'ime-network.db');

const SPECIALTIES = [
  { code: 'PSYCH',  name: 'Psychology / Psychiatry / Neuropsychology', is_core: 1, sort_order: 1 },
  { code: 'ORTHO',  name: 'Orthopedics / Spine',                       is_core: 1, sort_order: 2 },
  { code: 'NEURO',  name: 'Neurology',                                 is_core: 1, sort_order: 3 },
  { code: 'CARDIO', name: 'Cardiology',                                is_core: 1, sort_order: 4 },
  { code: 'OTHER',  name: 'Other / ancillary',                         is_core: 0, sort_order: 5 },
];
const CONF_MAP = { documented: 'confirmed', assumed: 'assumed', needs_confirm: 'needs_confirm', out_of_state: 'out_of_state' };

export function seed({ fresh = false } = {}) {
  const DB_PATH = dbPath();
  if (fresh && fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  migrate(db);   // schema comes from db/migrations, never from a create-only script

  const regions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'regions.json'), 'utf8'));
  const phys = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed-physicians.json'), 'utf8'));

  const insSpec = db.prepare('INSERT INTO specialty (code,name,is_core,sort_order) VALUES (@code,@name,@is_core,@sort_order)');
  const insReg = db.prepare(`INSERT INTO region (name,pin_label,pin_lat,pin_lng,population_m,is_flyin_corridor,effective_mph,covers,sort_order)
    VALUES (@name,@pin,@lat,@lng,@pop,@fly,@effective_mph,@covers,@sort_order)`);
  const insPhys = db.prepare(`INSERT INTO physician
    (source_id,full_name,credentials,primary_specialty_id,specialty_detail,preference,email,phone,is_qme,is_active,source_address_raw,notes)
    VALUES (@source_id,@full_name,@credentials,@spec_id,@detail,@preference,@email,@phone,@qme,1,@raw,@notes)`);
  const insOrg = db.prepare('INSERT INTO organization (name,kind,website) VALUES (?,?,?)');
  const insSite = db.prepare('INSERT INTO site (organization_id,label,address_line,city,state,lat,lng,geocode_source) VALUES (?,?,?,?,?,?,?,?)');
  const insLink = db.prepare(`INSERT INTO physician_site (physician_id,site_id,site_type,confirmation_status)
    VALUES (?,?,?,?) ON CONFLICT (physician_id,site_id) DO NOTHING`);
  const insTravel = db.prepare(`INSERT INTO travel_policy (physician_id,mode) VALUES (?,?)
    ON CONFLICT (physician_id) DO UPDATE SET mode=excluded.mode`);
  const orgs = new Map();   // canonical name -> id
  const sites = new Map();  // city|lat|lng -> id  (a place is entered once)
  const insTarget = db.prepare('INSERT INTO coverage_target (region_id,specialty_id,target_count) VALUES (?,?,1)');
  const insSetting = db.prepare('INSERT INTO setting (key,value) VALUES (?,?)');
  const insOutreach = db.prepare(`INSERT INTO outreach (physician_id,purpose,status,priority,prompt)
    VALUES (@pid,'confirm_coverage','open',@priority,@prompt)`);

  const insPerson = db.prepare('INSERT INTO contact_person (physician_id,name,role,is_primary) VALUES (?,?,?,?)');
  const insMethod = db.prepare(`INSERT INTO contact_method (physician_id,contact_person_id,kind,purpose,value,value_normalized,is_primary)
    VALUES (?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    for (const s of SPECIALTIES) insSpec.run(s);
    regions.forEach((r, i) => insReg.run({
      name: r.name, pin: r.pin, lat: r.lat, lng: r.lng, pop: r.pop,
      fly: r.fly ? 1 : 0, effective_mph: r.effective_mph, covers: r.covers, sort_order: i,
    }));

    const specId = Object.fromEntries(db.prepare('SELECT id,code FROM specialty').all().map(r => [r.code, r.id]));
    const regIds = db.prepare('SELECT id FROM region').all().map(r => r.id);

    for (const p of phys) {
      // 'Donald C. Pompan, M.D. - ExamWorks' -> physician + organization
      const org = parseOrganization(p.name);
      let orgId = null;
      if (org.organization) {
        const key = org.organization.toLowerCase();
        if (!orgs.has(key)) orgs.set(key, insOrg.run(org.organization, org.kind, null).lastInsertRowid);
        orgId = orgs.get(key);
      }
      const parts = org.person.split(',');
      const info = insPhys.run({
        source_id: String(p.id),
        full_name: parts[0].trim(),
        credentials: parts.slice(1).join(',').trim() || null,
        spec_id: specId[({ Psych: 'PSYCH', Ortho: 'ORTHO', Neuro: 'NEURO', Cardio: 'CARDIO' })[p.core] || 'OTHER'],
        detail: p.specialty || null,
        preference: ['Preferred','Secondary','Do Not Use'].includes(p.preference) ? p.preference : null,
        email: p.email || null,
        phone: p.phone || null,
        qme: p.qme ? 1 : 0,
        raw: p.rawAddress || null,
        notes: p.flag || null,
      });
      const pid = info.lastInsertRowid;
      if (orgId) db.prepare('UPDATE physician SET organization_id=? WHERE id=?').run(orgId, pid);
      // A place is entered once and shared. Matching is on ADDRESS — matching on
      // city+coordinates would merge every Fresno practice into one fictional
      // office, because they all geocode to the same city centroid.
      p.sites.forEach((s, idx) => {
        const addr = idx === 0 && p.rawAddress && !/^multiple|^nan$/i.test(p.rawAddress) ? p.rawAddress.trim() : null;
        const key = addr
          ? `addr:${addr.toLowerCase()}`
          : `own:${pid}:${s.city.toLowerCase()}:${s.type}`;   // no address -> distinct place
        if (!sites.has(key))
          sites.set(key, insSite.run(orgId, s.city, addr, s.city, 'CA', s.lat ?? null, s.lng ?? null,
            s.lat == null ? 'unknown' : 'city_centroid').lastInsertRowid);
        insLink.run(pid, sites.get(key), s.type === 'travel' ? 'flyin' : 'office', CONF_MAP[p.conf] || 'needs_confirm');
      });
      // Nothing in the export says a physician will travel beyond their listed
      // sites, so the conservative default stands until someone asks.
      insTravel.run(pid, p.sites.some((s) => s.type === 'travel') ? 'listed' : 'none');
      // ---- structured contacts, parsed out of the flat export ----
      // "Lou Lor - Case Manager" and "Ms. Lou Lor" are the same human; collapse them.
      const people = new Map();
      for (const person of parseContactPeople(p.poc)) {
        const k = personKey(person.name);
        if (!people.has(k)) people.set(k, { ...person, id: null });
        else if (person.role && !people.get(k).role) people.get(k).role = person.role;
      }
      let first = true;
      for (const person of people.values()) {
        person.id = insPerson.run(pid, person.name, person.role || null, first ? 1 : 0).lastInsertRowid;
        first = false;
      }
      const soleId = people.size === 1 ? [...people.values()][0].id : null;

      // "expert@diabloortho.com / busfieldmd@gmail.com" -> two rows
      splitMulti(p.email).forEach((v, i) =>
        insMethod.run(pid, soleId, 'email', 'general', v, normalizeValue('email', v), i === 0 ? 1 : 0));
      // '(office) 805.962.6222 (cell) 805. 252.6286' -> two rows; 'x 1' extensions survive
      parsePhones(p.phone).forEach((ph, i) =>
        insMethod.run(pid, soleId, ph.kind, ph.purpose, ph.value, ph.normalized, i === 0 ? 1 : 0));
      if (p.website) insMethod.run(pid, null, 'website', 'general', p.website, normalizeValue('website', p.website), 1);

      // anything we cannot stand behind becomes a real queue item, not a vibe
      if (p.conf === 'needs_confirm' || p.sites.length === 0) {
        insOutreach.run({
          pid, priority: p.qme ? 1 : 2,
          prompt: p.flag || 'No location on file. Ask: which cities, and is it their office or would we rent space?',
        });
      }
    }

    for (const rid of regIds) for (const code of ['PSYCH', 'ORTHO', 'NEURO', 'CARDIO']) insTarget.run(rid, specId[code]);
    insSetting.run('standard_minutes', '60');
    insSetting.run('data_source', 'FFD_Provider_Directory_Export.xlsx');
    insSetting.run('data_as_of', '2026-07-10');
    insSetting.run('schema_version', '1');
  });
  tx();

  const counts = {
    specialty: db.prepare('SELECT COUNT(*) c FROM specialty').get().c,
    region: db.prepare('SELECT COUNT(*) c FROM region').get().c,
    physician: db.prepare('SELECT COUNT(*) c FROM physician').get().c,
    contact_person: db.prepare('SELECT COUNT(*) c FROM contact_person').get().c,
    contact_method: db.prepare('SELECT COUNT(*) c FROM contact_method').get().c,
    organization: db.prepare('SELECT COUNT(*) c FROM organization').get().c,
    site: db.prepare('SELECT COUNT(*) c FROM site').get().c,
    physician_site: db.prepare('SELECT COUNT(*) c FROM physician_site').get().c,
    coverage_target: db.prepare('SELECT COUNT(*) c FROM coverage_target').get().c,
    outreach: db.prepare('SELECT COUNT(*) c FROM outreach').get().c,
  };
  db.close();
  return { path: DB_PATH, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = seed({ fresh: process.argv.includes('--fresh') });
  console.log('seeded ->', r.path);
  console.table(r.counts);
}
