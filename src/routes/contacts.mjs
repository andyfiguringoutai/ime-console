import { Router } from 'express';
import { db, audit } from '../db.mjs';
import { normalizeValue, parsePhones } from '../normalize.mjs';

const r = Router();

// ------------------------------------------------------------------ people
r.get('/physicians/:id/contacts', (req, res) => {
  const people = db.prepare('SELECT * FROM contact_person WHERE physician_id=? AND is_active=1 ORDER BY is_primary DESC, name').all(req.params.id);
  const methods = db.prepare('SELECT * FROM contact_method WHERE physician_id=? AND is_active=1 ORDER BY kind, is_primary DESC').all(req.params.id);
  people.forEach(p => (p.methods = methods.filter(m => m.contact_person_id === p.id)));
  res.json({ people, methods, unattached: methods.filter(m => !m.contact_person_id) });
});
r.post('/physicians/:id/contacts/people', (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO contact_person (physician_id,name,role,is_primary,notes) VALUES (?,?,?,?,?)')
    .run(req.params.id, b.name, b.role ?? null, b.is_primary ? 1 : 0, b.notes ?? null);
  const after = db.prepare('SELECT * FROM contact_person WHERE id=?').get(info.lastInsertRowid);
  audit('contact_person', Number(info.lastInsertRowid), 'create', req.actor, null, after);
  res.status(201).json(after);
});
r.patch('/contacts/people/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM contact_person WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const f = ['name', 'role', 'is_primary', 'is_active', 'notes'];
  const set = f.filter(k => k in req.body);
  if (set.length) db.prepare(`UPDATE contact_person SET ${set.map(k => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
    .run({ ...req.body, id: req.params.id });
  const after = db.prepare('SELECT * FROM contact_person WHERE id=?').get(req.params.id);
  audit('contact_person', +req.params.id, 'update', req.actor, before, after);
  res.json(after);
});

// ----------------------------------------------------------------- methods
r.post('/physicians/:id/contacts/methods', (req, res) => {
  const b = req.body;
  if (!b.kind || !b.value) return res.status(400).json({ error: 'kind and value required' });
  const rows = (b.kind === 'phone' || b.kind === 'fax')
    ? parsePhones(b.value).map(p => ({ kind: p.kind, purpose: b.purpose ?? p.purpose, value: p.value, normalized: p.normalized }))
    : [{ kind: b.kind, purpose: b.purpose ?? 'general', value: b.value, normalized: normalizeValue(b.kind, b.value) }];
  if (!rows.length) return res.status(400).json({ error: `could not parse a usable ${b.kind} from "${b.value}"` });

  const out = rows.map((row, i) => {
    const info = db.prepare(`INSERT INTO contact_method
      (physician_id,contact_person_id,site_id,kind,purpose,value,value_normalized,is_primary,notes)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(req.params.id, b.contact_person_id ?? null, b.site_id ?? null, row.kind, row.purpose,
           row.value, row.normalized, (b.is_primary && i === 0) ? 1 : 0, b.notes ?? null);
    const rec = db.prepare('SELECT * FROM contact_method WHERE id=?').get(info.lastInsertRowid);
    audit('contact_method', Number(info.lastInsertRowid), 'create', req.actor, null, rec);
    return rec;
  });
  res.status(201).json(out.length === 1 ? out[0] : out);
});
r.patch('/contacts/methods/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM contact_method WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = { ...req.body };
  if (body.value) body.value_normalized = normalizeValue(body.kind || before.kind, body.value);
  if (body.verified === true) { body.verified_at = new Date().toISOString(); body.verified_by = req.actor; delete body.verified; }
  const f = ['contact_person_id','site_id','kind','purpose','value','value_normalized','is_primary','is_active','verified_at','verified_by','notes'];
  const set = f.filter(k => k in body);
  if (set.length) db.prepare(`UPDATE contact_method SET ${set.map(k => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@id`)
    .run({ ...body, id: req.params.id });
  const after = db.prepare('SELECT * FROM contact_method WHERE id=?').get(req.params.id);
  audit('contact_method', +req.params.id, 'update', req.actor, before, after);
  res.json(after);
});
r.delete('/contacts/methods/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM contact_method WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE contact_method SET is_active=0, updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('contact_method', +req.params.id, 'delete', req.actor, before, null);
  res.json({ id: +req.params.id, is_active: 0 });
});

/** Who else shares this email/phone? Catches shared front desks and duplicate records. */
r.get('/contacts/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const norm = normalizeValue(/@/.test(q) ? 'email' : 'phone', q) || q.toLowerCase();
  res.json(db.prepare(`SELECT cm.*, p.full_name FROM contact_method cm JOIN physician p ON p.id=cm.physician_id
    WHERE cm.is_active=1 AND (cm.value_normalized = ? OR cm.value LIKE ?)`).all(norm, `%${q}%`));
});
export default r;
