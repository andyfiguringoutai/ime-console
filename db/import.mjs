/**
 * Import an FFD_Provider_Directory_Export.xlsx into an existing database.
 *
 *   node db/import.mjs <file.xlsx> [--dry-run] [--actor "Name"]
 *
 * Matches on physician.source_id, so re-running is safe: existing records are
 * updated in place, new ones inserted, and nothing is duplicated. Never deletes
 * — a provider absent from a fresh export is reported, not removed, because an
 * export can be filtered and a deletion is not recoverable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import { migrate } from './migrate.mjs';
import { normalizeValue, splitMulti, parsePhones, parseContactPeople, personKey, parseOrganization } from '../src/normalize.mjs';

/**
 * The export carries ONE ROW PER PHYSICIAN-LOCATION: Chhaya Makhija appears
 * twice (Fresno, Lafayette) under two IDs. This database carries one physician
 * with many sites. So when a source_id is unknown, fall back to a full-name
 * match before inserting — otherwise every multi-office provider is duplicated
 * on every import. Matching is on the whole name, so 'Catherine J. Ward' and
 * 'Nicole K. Ward' stay distinct.
 */
const nameKey = (n) => String(n).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = () => process.env.DB_PATH || path.join(ROOT, 'data', 'ime-network.db');

// ---------------------------------------------------------------- gazetteer
const CITY = (() => {
  const m = {};
  fs.readFileSync(path.join(ROOT, 'data', 'ca-cities.txt'), 'utf8').split(';').forEach(s => {
    const [n, la, lo, p] = s.split('|');
    const k = n.toLowerCase();
    if (!m[k] || +p > m[k].pop) m[k] = { name: n, lat: +la, lng: +lo, pop: +p };
  });
  return m;
})();
const ZIP = (() => {
  const names = fs.readFileSync(path.join(ROOT, 'data', 'ca-zip-names.txt'), 'utf8').split(';');
  const m = {};
  fs.readFileSync(path.join(ROOT, 'data', 'ca-zips.txt'), 'utf8').split(';').forEach(s => {
    const [z, la, lo, i] = s.split('|');
    m[z] = { lat: +la, lng: +lo, city: names[+i] };
  });
  return m;
})();

/** ZIP first — it is unambiguous. City name second. Neither is fatal. */
export function geocodeAddress(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^nan$/i.test(s)) return null;
  const zip = s.match(/\b(9\d{4})\b/);
  if (zip && ZIP[zip[1]]) {
    const z = ZIP[zip[1]];
    return { city: z.city, postal_code: zip[1], lat: z.lat, lng: z.lng, source: 'zip_centroid' };
  }
  // longest city name that appears in the string wins ("San Diego" over "Diego")
  const hit = Object.keys(CITY).sort((a, b) => b.length - a.length).find(c => s.toLowerCase().includes(c));
  if (hit) {
    const c = CITY[hit];
    return { city: c.name, postal_code: null, lat: c.lat, lng: c.lng, source: 'city_centroid' };
  }
  return null;
}

const CORE_OF = (sp) => {
  const s = String(sp ?? '');
  if (/psychiatry|psychology|neuropsych/i.test(s)) return 'PSYCH';
  if (/orthopedic|neurosurgery/i.test(s)) return 'ORTHO';
  if (/^neurology$/i.test(s.trim())) return 'NEURO';
  if (/cardiology/i.test(s)) return 'CARDIO';
  return 'OTHER';
};
const OUT_OF_STATE = /\b(NV|AZ|TX|CO|PA|IA|IL|MA|FL|OR|WA|NY|NJ|OH|GA|NC)\b|nevada|arizona|texas|colorado|florida|massachusetts|pennsylvania/i;

export function importXlsx(file, { dryRun = false, actor = 'import' } = {}) {
  const db = new Database(dbPath());
  db.pragma('foreign_keys = ON');
  migrate(db);

  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['IME Physician Directory'], { defval: null });
  const specId = Object.fromEntries(db.prepare('SELECT id, code FROM specialty').all().map(r => [r.code, r.id]));

  const report = { inserted: [], updated: [], unchanged: 0, extraLocations: [], missingFromExport: [], noGeocode: [], sitesCreated: 0, sitesReused: 0 };

  const run = db.transaction(() => {
    const seen = new Set();
    const seenNames = new Set();

    for (const row of rows) {
      const sourceId = String(row.ID);
      seen.add(sourceId);
      const org = parseOrganization(row['Physician Name'] ?? '');
      const parts = org.person.split(',');
      const fullName = parts[0].trim();
      const credentials = parts.slice(1).join(',').trim() || null;
      seenNames.add(nameKey(fullName));
      let existing = db.prepare('SELECT * FROM physician WHERE source_id=?').get(sourceId);
      let aliasOf = null;
      if (!existing) {
        const byName = db.prepare('SELECT * FROM physician WHERE is_active=1').all()
          .find(p => nameKey(p.full_name) === nameKey(fullName));
        if (byName) { existing = byName; aliasOf = byName.source_id; }   // same person, another office
      }

      // ---- organization
      let orgId = null;
      if (org.organization && !org.isOrgRecord) {
        const found = db.prepare('SELECT id FROM organization WHERE LOWER(name)=LOWER(?)').get(org.organization);
        orgId = found ? found.id
          : db.prepare('INSERT INTO organization (name,kind) VALUES (?,?)').run(org.organization, org.kind).lastInsertRowid;
      }

      const fields = {
        full_name: fullName,
        credentials,
        primary_specialty_id: specId[CORE_OF(row.Specialty)],
        specialty_detail: row.Specialty ?? null,
        preference: ['Preferred', 'Secondary', 'Do Not Use'].includes(row['Provider Preference']) ? row['Provider Preference'] : null,
        point_of_contact: row['Point of Contact'] ?? null,
        email: splitMulti(row.Email)[0] ?? null,
        phone: (parsePhones(row['Phone / Vendor Contact'])[0] || {}).value ?? null,
        website: row.Website ?? null,
        is_qme: /\bQ\.?M\.?E\b/i.test(row['Physician Name'] ?? '') ? 1 : 0,
        is_active: String(row.Active ?? 'Yes').toLowerCase() === 'no' ? 0 : 1,
        notes: row.Notes ?? null,
        source_address_raw: row.Address ?? null,
        organization_id: orgId,
      };

      let physId;
      if (existing) {
        const diff = Object.entries(fields).filter(([k, v]) => String(existing[k] ?? '') !== String(v ?? ''));
        physId = existing.id;
        if (aliasOf) {
          // an additional office for someone already on file — add the site, not a person
          report.extraLocations.push({ source_id: sourceId, name: fullName, primary_source_id: aliasOf });
        } else if (diff.length) {
          db.prepare(`UPDATE physician SET ${Object.keys(fields).map(k => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
            .run({ ...fields, id: physId });
          report.updated.push({ source_id: sourceId, name: fullName, changed: diff.map(([k]) => k) });
        } else report.unchanged++;
      } else {
        physId = Number(db.prepare(`INSERT INTO physician
          (source_id,full_name,credentials,primary_specialty_id,specialty_detail,preference,point_of_contact,email,phone,website,is_qme,is_active,notes,source_address_raw,organization_id)
          VALUES (@source_id,@full_name,@credentials,@primary_specialty_id,@specialty_detail,@preference,@point_of_contact,@email,@phone,@website,@is_qme,@is_active,@notes,@source_address_raw,@organization_id)`)
          .run({ ...fields, source_id: sourceId }).lastInsertRowid);
        db.prepare("INSERT INTO travel_policy (physician_id,mode) VALUES (?,'none') ON CONFLICT DO NOTHING").run(physId);
        report.inserted.push({ source_id: sourceId, name: fullName, specialty: CORE_OF(row.Specialty) });
      }

      // ---- location: a place, matched on address
      const geo = geocodeAddress(row.Address);
      const addr = row.Address && !/^nan$|^multiple/i.test(String(row.Address)) ? String(row.Address).trim() : null;
      if (geo) {
        let siteId = addr
          ? db.prepare('SELECT id FROM site WHERE LOWER(TRIM(address_line))=LOWER(TRIM(?))').get(addr)?.id ?? null
          : null;
        if (siteId) report.sitesReused++;
        else {
          siteId = Number(db.prepare(`INSERT INTO site (organization_id,label,address_line,city,state,postal_code,lat,lng,geocode_source)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(orgId, geo.city, addr, geo.city, 'CA', geo.postal_code, geo.lat, geo.lng, geo.source).lastInsertRowid);
          report.sitesCreated++;
        }
        db.prepare(`INSERT INTO physician_site (physician_id,site_id,site_type,confirmation_status)
          VALUES (?,?,'office','assumed') ON CONFLICT (physician_id,site_id) DO NOTHING`).run(physId, siteId);
      } else if (!existing) {
        report.noGeocode.push({ source_id: sourceId, name: fullName, address: row.Address, outOfState: OUT_OF_STATE.test(String(row.Address ?? '')) });
        // an unplaceable provider is a phone call, not a silent hole
        db.prepare(`INSERT INTO outreach (physician_id,purpose,status,priority,prompt) VALUES (?,'confirm_coverage','open',?,?)`)
          .run(physId, 2, row.Address ? `Address "${row.Address}" could not be placed. Confirm the city.` : 'No address on file. Ask: which cities, and is it their office or would we rent space?');
      }

      // ---- contacts (only for genuinely new records; existing ones keep curated data)
      if (!existing) {
        const people = new Map();
        for (const person of parseContactPeople(row['Point of Contact'])) {
          const k = personKey(person.name);
          if (!people.has(k)) people.set(k, person);
          else if (person.role && !people.get(k).role) people.get(k).role = person.role;
        }
        let first = true, soleId = null;
        for (const person of people.values()) {
          const id = db.prepare('INSERT INTO contact_person (physician_id,name,role,is_primary) VALUES (?,?,?,?)')
            .run(physId, person.name, person.role ?? null, first ? 1 : 0).lastInsertRowid;
          if (people.size === 1) soleId = id;
          first = false;
        }
        const addMethod = db.prepare(`INSERT INTO contact_method (physician_id,contact_person_id,kind,purpose,value,value_normalized,is_primary)
          VALUES (?,?,?,?,?,?,?)`);
        splitMulti(row.Email).forEach((v, i) => addMethod.run(physId, soleId, 'email', 'general', v, normalizeValue('email', v), i === 0 ? 1 : 0));
        parsePhones(row['Phone / Vendor Contact']).forEach((p, i) => addMethod.run(physId, soleId, p.kind, p.purpose, p.value, p.normalized, i === 0 ? 1 : 0));
        if (row.Website) addMethod.run(physId, null, 'website', 'general', row.Website, normalizeValue('website', row.Website), 1);
      }

      if (!dryRun) {
        db.prepare(`INSERT INTO audit_log (entity,entity_id,action,actor,after_json) VALUES ('physician',?,?,?,?)`)
          .run(physId, existing ? 'update' : 'create', actor, JSON.stringify({ source_id: sourceId, full_name: fullName }));
      }
    }

    // present in the database, absent from this export — reported, never deleted
    for (const p of db.prepare('SELECT source_id, full_name FROM physician WHERE source_id IS NOT NULL AND is_active=1').all())
      if (!seen.has(String(p.source_id)) && !seenNames.has(nameKey(p.full_name))) report.missingFromExport.push(p);

    db.prepare(`INSERT INTO setting (key,value,updated_at) VALUES ('data_as_of',?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`).run(new Date().toISOString().slice(0, 10));

    if (dryRun) throw { rollback: true };
  });

  try { run(); } catch (e) { if (!e?.rollback) { db.close(); throw e; } }
  db.close();
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node db/import.mjs <file.xlsx> [--dry-run]'); process.exit(1); }
  const dry = process.argv.includes('--dry-run');
  const ai = process.argv.indexOf('--actor');
  const r = importXlsx(file, { dryRun: dry, actor: ai > -1 ? process.argv[ai + 1] : 'import' });
  console.log(dry ? '\n=== DRY RUN — nothing written ===\n' : '\n=== IMPORT COMPLETE ===\n');
  console.log(`inserted ${r.inserted.length} · updated ${r.updated.length} · unchanged ${r.unchanged}`);
  console.log(`sites created ${r.sitesCreated} · reused ${r.sitesReused}`);
  if (r.inserted.length) { console.log('\nNEW:'); r.inserted.forEach(x => console.log(`  + ${x.name} (${x.specialty})`)); }
  if (r.extraLocations.length) { console.log('\nADDITIONAL OFFICE for someone already on file (no duplicate person created):'); r.extraLocations.forEach(x => console.log(`  = ${x.name} (export row ${x.source_id} -> existing ${x.primary_source_id})`)); }
  if (r.updated.length) { console.log('\nUPDATED:'); r.updated.forEach(x => console.log(`  ~ ${x.name} — ${x.changed.join(', ')}`)); }
  if (r.noGeocode.length) { console.log('\nCOULD NOT PLACE (added to the call sheet):'); r.noGeocode.forEach(x => console.log(`  ? ${x.name} — ${x.address ?? 'no address'}${x.outOfState ? ' [out of state]' : ''}`)); }
  if (r.missingFromExport.length) { console.log('\nIN DATABASE BUT NOT IN THIS EXPORT (not deleted):'); r.missingFromExport.forEach(x => console.log(`  ! ${x.full_name}`)); }
}
