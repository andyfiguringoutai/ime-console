import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, audit } from './db.mjs';
import { computeCoverage, providersNear } from './coverage.mjs';
import { nearestRegion, NO_LIMIT } from './geo.mjs';
import contactsRoute from './routes/contacts.mjs';
import correspondenceRoute from './routes/correspondence.mjs';
import documentsRoute from './routes/documents.mjs';
import { withUser, requireUser, createSession, destroySession, checkPassword, hashPassword, cookieHeader, clearCookie, tokenFromReq } from './auth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(withUser);   // attaches req.user + req.actor from the session cookie

// ---- auth routes (open) ----
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = email && db.prepare('SELECT * FROM app_user WHERE lower(email)=lower(?) AND is_active=1').get(email);
  if (!u || !checkPassword(password || '', u.password_hash))
    return res.status(401).json({ error: 'Wrong email or password.' });
  const { token, expires } = createSession(u.id, req.get('user-agent'));
  db.prepare("UPDATE app_user SET last_login_at=datetime('now') WHERE id=?").run(u.id);
  res.setHeader('Set-Cookie', cookieHeader(token, expires));
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, must_reset: !!u.must_reset });
});
app.post('/api/auth/logout', (req, res) => {
  destroySession(tokenFromReq(req));
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => req.user ? res.json(req.user) : res.status(401).json({ error: 'not authenticated' }));
app.post('/api/auth/password', requireUser, (req, res) => {
  const { current, next: np } = req.body || {};
  const u = db.prepare('SELECT * FROM app_user WHERE id=?').get(req.user.id);
  if (!checkPassword(current || '', u.password_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  if (!np || np.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  db.prepare('UPDATE app_user SET password_hash=?, must_reset=0 WHERE id=?').run(hashPassword(np), req.user.id);
  res.json({ ok: true });
});
app.get('/api/users', requireUser, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json(db.prepare('SELECT id,email,name,role,is_active,last_login_at FROM app_user ORDER BY name').all());
});
app.post('/api/users', requireUser, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const { email, name, role } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'email and name required' });
  const temp = Math.random().toString(36).slice(2, 10) + 'A1';
  try {
    const info = db.prepare('INSERT INTO app_user (email,name,password_hash,role,must_reset) VALUES (?,?,?,?,1)')
      .run(email, name, hashPassword(temp), role === 'admin' ? 'admin' : 'member');
    audit('app_user', Number(info.lastInsertRowid), 'create', req.actor, null, { email, name, role });
    res.status(201).json({ id: info.lastInsertRowid, email, name, temporary_password: temp });
  } catch (e) { res.status(400).json({ error: 'that email already exists' }); }
});

// ---- everything else under /api requires a login ----
app.use('/api', requireUser);


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

// ---------------------------------------------------------------- reference
app.get('/api/health', (_q, r) => r.json({ ok: true, schema_version: db.prepare("SELECT value FROM setting WHERE key='schema_version'").get()?.value }));
app.get('/api/specialties', (_q, r) => r.json(db.prepare('SELECT * FROM specialty ORDER BY sort_order').all()));
app.get('/api/settings', (_q, r) => r.json(Object.fromEntries(db.prepare('SELECT key,value FROM setting').all().map(s => [s.key, s.value]))));
app.put('/api/settings/:key', (req, res) => {
  db.prepare(`INSERT INTO setting (key,value,updated_at) VALUES (?,?,datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`)
    .run(req.params.key, String(req.body.value));
  res.json({ key: req.params.key, value: String(req.body.value) });
});

// ---------------------------------------------------------------- regions
app.get('/api/regions', (_q, res) => {
  const rows = db.prepare(`
    SELECT r.*, o.minutes AS radius_override
    FROM region r LEFT JOIN region_radius_override o ON o.region_id = r.id
    ORDER BY r.sort_order`).all();
  res.json(rows);
});
app.patch('/api/regions/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM region WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'region not found' });
  const f = ['pin_label', 'pin_lat', 'pin_lng', 'population_m', 'is_flyin_corridor', 'effective_mph', 'covers'];
  const set = f.filter(k => k in req.body);
  if (set.length) {
    db.prepare(`UPDATE region SET ${set.map(k => `${k}=@${k}`).join(',')} WHERE id=@id`)
      .run({ ...req.body, id: req.params.id });
  }
  const after = db.prepare('SELECT * FROM region WHERE id=?').get(req.params.id);
  audit('region', +req.params.id, 'update', req.actor, before, after);
  res.json(after);
});
app.put('/api/regions/:id/radius', (req, res) => {
  const m = req.body.minutes;
  if (m == null) db.prepare('DELETE FROM region_radius_override WHERE region_id=?').run(req.params.id);
  else db.prepare(`INSERT INTO region_radius_override (region_id,minutes) VALUES (?,?)
                   ON CONFLICT(region_id) DO UPDATE SET minutes=excluded.minutes`).run(req.params.id, m);
  res.json({ region_id: +req.params.id, minutes: m ?? null });
});

// ---------------------------------------------------------------- targets
app.get('/api/targets', (_q, res) => res.json(db.prepare(`
  SELECT ct.*, r.name AS region, s.code AS specialty FROM coverage_target ct
  JOIN region r ON r.id=ct.region_id JOIN specialty s ON s.id=ct.specialty_id`).all()));
app.put('/api/targets', (req, res) => {
  const { region_id, specialty_id, target_count, all } = req.body;
  if (all != null) {
    db.prepare('UPDATE coverage_target SET target_count=?').run(all);
    return res.json({ updated: 'all', target_count: all });
  }
  db.prepare(`INSERT INTO coverage_target (region_id,specialty_id,target_count) VALUES (?,?,?)
              ON CONFLICT(region_id,specialty_id) DO UPDATE SET target_count=excluded.target_count`)
    .run(region_id, specialty_id, target_count);
  res.json({ region_id, specialty_id, target_count });
});

// ---------------------------------------------------------------- physicians
const physFull = (id) => {
  const p = db.prepare(`SELECT p.*, s.code AS specialty_code FROM physician p
                        LEFT JOIN specialty s ON s.id=p.primary_specialty_id WHERE p.id=?`).get(id);
  if (!p) return null;
  p.locations = db.prepare(`SELECT ps.id, ps.site_id, ps.site_type, ps.confirmation_status, ps.confirmed_by,
      ps.confirmed_at, ps.is_active, s.label, s.address_line, s.city, s.state, s.postal_code,
      s.lat, s.lng, s.geocode_source, s.organization_id, o.name AS organization_name,
      (SELECT COUNT(*) FROM physician_site x JOIN physician xp ON xp.id=x.physician_id
        WHERE x.site_id=ps.site_id AND x.is_active=1 AND xp.is_active=1) AS site_physician_count
    FROM physician_site ps JOIN site s ON s.id=ps.site_id
    LEFT JOIN organization o ON o.id=s.organization_id
    WHERE ps.physician_id=? ORDER BY ps.site_type, s.city`).all(id);
  p.travel = db.prepare('SELECT * FROM travel_policy WHERE physician_id=?').get(id) || { physician_id: +id, mode: 'none', radius_miles: null };
  p.organization = p.organization_id ? db.prepare('SELECT * FROM organization WHERE id=?').get(p.organization_id) : null;
  p.colleagues = p.organization_id ? db.prepare(`SELECT id, full_name, credentials,
      (SELECT code FROM specialty WHERE id=primary_specialty_id) AS specialty_code
    FROM physician WHERE organization_id=? AND id<>? AND is_active=1 ORDER BY full_name`).all(p.organization_id, id) : [];
  p.fees = db.prepare('SELECT * FROM fee WHERE physician_id=? ORDER BY service_code').all(id);
  p.documents = db.prepare('SELECT * FROM document WHERE physician_id=? ORDER BY uploaded_at DESC').all(id);
  return p;
};
app.get('/api/physicians', (req, res) => {
  const { q, specialty, region, confirmation } = req.query;
  let rows = db.prepare(`SELECT p.*, s.code AS specialty_code, o.name AS organization_name, t.mode AS travel_mode, t.radius_miles
                         FROM physician p
                         LEFT JOIN specialty s ON s.id=p.primary_specialty_id
                         LEFT JOIN organization o ON o.id=p.organization_id
                         LEFT JOIN travel_policy t ON t.physician_id=p.id
                         WHERE p.is_active=1 ORDER BY p.full_name`).all();
  const locs = db.prepare(`SELECT ps.id, ps.physician_id, ps.site_id, ps.site_type, ps.confirmation_status,
      s.city, s.lat, s.lng, s.label FROM physician_site ps JOIN site s ON s.id=ps.site_id
      WHERE ps.is_active=1 AND s.is_active=1`).all();
  rows.forEach(r => (r.locations = locs.filter(l => l.physician_id === r.id)));
  if (q) { const s = String(q).toLowerCase();
    rows = rows.filter(r => (r.full_name + r.specialty_detail + (r.credentials || '')).toLowerCase().includes(s)); }
  if (specialty) rows = rows.filter(r => r.specialty_code === specialty);
  if (confirmation) rows = rows.filter(r => r.locations.some(l => l.confirmation_status === confirmation));
  res.json(rows);
});
app.get('/api/physicians/:id', (req, res) => {
  const p = physFull(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'not found' });
});
app.post('/api/physicians', (req, res) => {
  const b = req.body;
  if (!b.full_name) return res.status(400).json({ error: 'full_name required' });
  const info = db.prepare(`INSERT INTO physician
    (source_id,full_name,credentials,primary_specialty_id,specialty_detail,preference,point_of_contact,email,phone,website,is_qme,performs_ime,notes)
    VALUES (@source_id,@full_name,@credentials,@primary_specialty_id,@specialty_detail,@preference,@point_of_contact,@email,@phone,@website,@is_qme,@performs_ime,@notes)`)
    .run({ source_id: null, credentials: null, primary_specialty_id: null, specialty_detail: null,
           preference: null, point_of_contact: null, email: null, phone: null, website: null,
           is_qme: 0, performs_ime: 1, notes: null, ...b });
  const after = physFull(info.lastInsertRowid);
  audit('physician', Number(info.lastInsertRowid), 'create', req.actor, null, after);
  res.status(201).json(after);
});
app.patch('/api/physicians/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM physician WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const f = ['full_name','credentials','primary_specialty_id','specialty_detail','preference','point_of_contact',
             'email','phone','website','is_qme','performs_ime','is_active','notes'];
  const set = f.filter(k => k in req.body);
  if (set.length) db.prepare(`UPDATE physician SET ${set.map(k => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
    .run({ ...req.body, id: req.params.id });
  const after = physFull(req.params.id);
  audit('physician', +req.params.id, 'update', req.actor, before, after);
  res.json(after);
});
app.delete('/api/physicians/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM physician WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE physician SET is_active=0, updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('physician', +req.params.id, 'delete', req.actor, before, null);
  res.json({ id: +req.params.id, is_active: 0 });   // soft delete: never lose history
});

// ---------------------------------------------------------------- locations
app.post('/api/physicians/:id/locations', (req, res) => {
  const b = req.body;
  if (!b.city) return res.status(400).json({ error: 'city required' });
  let { lat, lng, geocode_source } = b;
  if (lat == null) {
    const isZip = /^\d{5}$/.test(b.city);
    const hit = isZip ? ZIP[b.city] : CITY[String(b.city).toLowerCase()];
    if (hit) { lat = hit.lat; lng = hit.lng; geocode_source = isZip ? 'zip_centroid' : 'city_centroid'; }
  }
  const city = /^\d{5}$/.test(b.city) ? (ZIP[b.city]?.city || b.city) : b.city;

  // Reuse an existing place when the address matches. Never merge on city alone:
  // city centroids would fuse unrelated practices into one fictional office.
  let siteId = b.site_id ?? null;
  if (!siteId && b.address_line) {
    siteId = db.prepare('SELECT id FROM site WHERE LOWER(TRIM(address_line))=LOWER(TRIM(?)) AND is_active=1').get(b.address_line)?.id ?? null;
  }
  if (!siteId) {
    const info = db.prepare(`INSERT INTO site (organization_id,label,address_line,city,state,postal_code,lat,lng,geocode_source)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(b.organization_id ?? null, b.label ?? city, b.address_line ?? null, city,
        b.state ?? 'CA', b.postal_code ?? null, lat ?? null, lng ?? null,
        geocode_source ?? (lat == null ? 'unknown' : 'manual'));
    siteId = Number(info.lastInsertRowid);
    audit('site', siteId, 'create', req.actor, null, db.prepare('SELECT * FROM site WHERE id=?').get(siteId));
  }
  const link = db.prepare(`INSERT INTO physician_site (physician_id,site_id,site_type,confirmation_status,notes)
    VALUES (?,?,?,?,?) ON CONFLICT (physician_id,site_id) DO UPDATE SET is_active=1, site_type=excluded.site_type`)
    .run(req.params.id, siteId, b.site_type ?? 'office', b.confirmation_status ?? 'needs_confirm', b.notes ?? null);
  const row = db.prepare(`SELECT ps.*, s.city, s.lat, s.lng, s.geocode_source FROM physician_site ps
    JOIN site s ON s.id=ps.site_id WHERE ps.physician_id=? AND ps.site_id=?`).get(req.params.id, siteId);
  audit('physician_site', row.id, 'create', req.actor, null, row);
  res.status(201).json(row);
});

app.patch('/api/locations/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM physician_site WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = { ...req.body };
  if (body.confirmation_status === 'confirmed' && before.confirmation_status !== 'confirmed') {
    body.confirmed_by = req.actor; body.confirmed_at = new Date().toISOString();
  }
  const f = ['site_type','confirmation_status','confirmed_by','confirmed_at','is_active','notes'];
  const set = f.filter(k => k in body);
  if (set.length) db.prepare(`UPDATE physician_site SET ${set.map(k => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
    .run({ ...body, id: req.params.id });
  // address edits belong to the place, and reach every physician who sits there
  const sf = ['label','address_line','city','postal_code','lat','lng','geocode_source','organization_id'];
  const sset = sf.filter(k => k in body);
  if (sset.length) db.prepare(`UPDATE site SET ${sset.map(k => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@sid`)
    .run({ ...body, sid: before.site_id });
  const after = db.prepare('SELECT * FROM physician_site WHERE id=?').get(req.params.id);
  audit('physician_site', +req.params.id, 'update', req.actor, before, after);
  res.json(after);
});
app.delete('/api/locations/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM physician_site WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM physician_site WHERE id=?').run(req.params.id);
  // the place survives — someone else may sit there
  audit('physician_site', +req.params.id, 'delete', req.actor, before, null);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------- orgs / travel
app.get('/api/organizations', (_q, res) => res.json(db.prepare(`
  SELECT o.*, COUNT(DISTINCT p.id) AS physician_count, COUNT(DISTINCT s.id) AS site_count
  FROM organization o
  LEFT JOIN physician p ON p.organization_id=o.id AND p.is_active=1
  LEFT JOIN site s ON s.organization_id=o.id AND s.is_active=1
  GROUP BY o.id ORDER BY physician_count DESC, o.name`).all()));
app.get('/api/organizations/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM organization WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  o.physicians = db.prepare(`SELECT p.id,p.full_name,p.credentials,s.code AS specialty_code FROM physician p
    LEFT JOIN specialty s ON s.id=p.primary_specialty_id WHERE p.organization_id=? AND p.is_active=1`).all(req.params.id);
  o.sites = db.prepare('SELECT * FROM site WHERE organization_id=? AND is_active=1').all(req.params.id);
  res.json(o);
});
app.post('/api/organizations', (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO organization (name,kind,website,notes) VALUES (?,?,?,?)')
    .run(b.name, b.kind ?? 'practice', b.website ?? null, b.notes ?? null);
  res.status(201).json(db.prepare('SELECT * FROM organization WHERE id=?').get(info.lastInsertRowid));
});

app.get('/api/sites', (req, res) => res.json(db.prepare(`
  SELECT s.*, o.name AS organization_name,
    (SELECT COUNT(*) FROM physician_site ps JOIN physician p ON p.id=ps.physician_id
      WHERE ps.site_id=s.id AND ps.is_active=1 AND p.is_active=1) AS physician_count
  FROM site s LEFT JOIN organization o ON o.id=s.organization_id
  WHERE s.is_active=1 ORDER BY physician_count DESC`).all()));
app.get('/api/sites/:id', (req, res) => {
  const s2 = db.prepare('SELECT * FROM site WHERE id=?').get(req.params.id);
  if (!s2) return res.status(404).json({ error: 'not found' });
  s2.physicians = db.prepare(`SELECT p.id,p.full_name,p.credentials,ps.site_type,ps.confirmation_status,
      sp.code AS specialty_code FROM physician_site ps JOIN physician p ON p.id=ps.physician_id
    LEFT JOIN specialty sp ON sp.id=p.primary_specialty_id
    WHERE ps.site_id=? AND ps.is_active=1 AND p.is_active=1`).all(req.params.id);
  res.json(s2);
});

app.put('/api/physicians/:id/travel', (req, res) => {
  const b = req.body;
  const MODES = ['none','listed','radius','anywhere'];
  if (!MODES.includes(b.mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
  if (b.mode === 'radius' && !(b.radius_miles > 0)) return res.status(400).json({ error: 'radius mode needs radius_miles' });
  const before = db.prepare('SELECT * FROM travel_policy WHERE physician_id=?').get(req.params.id);
  db.prepare(`INSERT INTO travel_policy (physician_id,mode,radius_miles,notes,confirmed_by,confirmed_at,updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT (physician_id) DO UPDATE SET mode=excluded.mode, radius_miles=excluded.radius_miles,
      notes=excluded.notes, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at, updated_at=datetime('now')`)
    .run(req.params.id, b.mode, b.mode === 'radius' ? b.radius_miles : null, b.notes ?? null,
         b.confirmed ? req.actor : null, b.confirmed ? new Date().toISOString() : null);
  const after = db.prepare('SELECT * FROM travel_policy WHERE physician_id=?').get(req.params.id);
  audit('travel_policy', +req.params.id, before ? 'update' : 'create', req.actor, before, after);
  res.json(after);
});

// ---------------------------------------------------------------- fees & docs
app.get('/api/physicians/:id/fees', (req, res) => res.json(db.prepare('SELECT * FROM fee WHERE physician_id=?').all(req.params.id)));
app.post('/api/physicians/:id/fees', (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO fee (physician_id,service_code,description,amount_cents,unit,effective_from)
    VALUES (?,?,?,?,?,?)`).run(req.params.id, b.service_code, b.description ?? null,
      b.amount_cents ?? Math.round((b.amount ?? 0) * 100), b.unit ?? 'flat', b.effective_from ?? null);
  const after = db.prepare('SELECT * FROM fee WHERE id=?').get(info.lastInsertRowid);
  audit('fee', Number(info.lastInsertRowid), 'create', req.actor, null, after);
  res.status(201).json(after);
});
// ---------------------------------------------------------------- coverage
app.get('/api/coverage', (req, res) => {
  const specialties = req.query.specialties ? String(req.query.specialties).split(',') : null;
  res.json(computeCoverage(db, { specialties }));
});
app.get('/api/gaps', (req, res) => {
  const specialties = req.query.specialties ? String(req.query.specialties).split(',') : null;
  const { cells } = computeCoverage(db, { specialties });
  const gaps = cells.filter(c => c.count === 0)
    .sort((a, b) => (b.population_m || 0) - (a.population_m || 0))
    .map(({ providers, ...c }) => c);
  res.json({ count: gaps.length, metro: gaps.filter(g => !g.is_flyin_corridor), corridor: gaps.filter(g => g.is_flyin_corridor) });
});
app.get('/api/lookup', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required (city or 5-digit ZIP)' });
  let hit = null;
  if (/^\d{5}$/.test(q)) { const z = ZIP[q]; if (z) hit = { lat: z.la ?? z.lat, lng: z.lo ?? z.lng, label: `${z.city} ${q}`, kind: 'ZIP' }; }
  else { const c = CITY[q.toLowerCase()]; if (c) hit = { lat: c.lat, lng: c.lng, label: c.name, kind: 'City' }; }
  if (!hit) return res.status(404).json({ error: `no California city or ZIP matching "${q}"` });
  const regions = db.prepare('SELECT * FROM region').all();
  const region = nearestRegion(hit.lat, hit.lng, regions);
  const specialties = req.query.specialties ? String(req.query.specialties).split(',') : null;
  const limit = req.query.limit ? +req.query.limit : null;
  res.json({ ...hit, region: { id: region.id, name: region.name, pin: region.pin_label },
             providers: providersNear(db, hit.lat, hit.lng, region, { specialties, limit }) });
});

// ---------------------------------------------------------------- outreach
app.get('/api/outreach', (req, res) => {
  const status = req.query.status || 'open';
  res.json(db.prepare(`SELECT o.*, p.full_name, p.phone, p.email, p.is_qme, s.code AS specialty
    FROM outreach o LEFT JOIN physician p ON p.id=o.physician_id
    LEFT JOIN specialty s ON s.id=COALESCE(o.specialty_id,p.primary_specialty_id)
    WHERE (@status='all' OR o.status=@status) ORDER BY o.priority, o.id`).all({ status }));
});
app.post('/api/outreach', (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO outreach (physician_id,region_id,specialty_id,purpose,priority,assigned_to,due_on,prompt)
    VALUES (?,?,?,?,?,?,?,?)`).run(b.physician_id ?? null, b.region_id ?? null, b.specialty_id ?? null,
      b.purpose ?? 'other', b.priority ?? 3, b.assigned_to ?? null, b.due_on ?? null, b.prompt ?? null);
  res.status(201).json(db.prepare('SELECT * FROM outreach WHERE id=?').get(info.lastInsertRowid));
});
app.patch('/api/outreach/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM outreach WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = { ...req.body };
  if (['resolved', 'declined'].includes(body.status)) body.resolved_at = new Date().toISOString();
  const f = ['status','priority','assigned_to','due_on','prompt','outcome_note','resolved_at'];
  const set = f.filter(k => k in body);
  if (set.length) db.prepare(`UPDATE outreach SET ${set.map(k => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
    .run({ ...body, id: req.params.id });
  const after = db.prepare('SELECT * FROM outreach WHERE id=?').get(req.params.id);
  audit('outreach', +req.params.id, 'update', req.actor, before, after);
  res.json(after);
});

// ---------------------------------------------------------------- audit / geo
app.get('/api/audit', (req, res) => res.json(db.prepare(`SELECT * FROM audit_log
  WHERE (@entity IS NULL OR entity=@entity) ORDER BY id DESC LIMIT @limit`)
  .all({ entity: req.query.entity ?? null, limit: +(req.query.limit ?? 100) })));
app.get('/api/geo/outline', (_q, res) => res.sendFile(path.join(ROOT, 'data', 'ca-outline.json')));
app.get('/api/geo/cities', (_q, res) => res.json(Object.values(CITY).sort((a, b) => b.pop - a.pop)));

app.use('/api', contactsRoute);
app.use('/api', correspondenceRoute);
app.use('/api', documentsRoute);

app.get('/', (req, res, next) => {
  if (req.user) return next();                       // authed browser -> the app
  res.sendFile(path.join(ROOT, 'public', 'login.html'));   // anonymous -> login
});
app.use(express.static(path.join(ROOT, 'public')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') app.listen(PORT, () => console.log(`IME network API -> http://localhost:${PORT}`));
export default app;
