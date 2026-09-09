import { Router } from 'express';
import { db, audit } from '../db.mjs';

const r = Router();

/** The thread for one provider: every call, email and note, newest first. */
r.get('/physicians/:id/correspondence', (req, res) => {
  const rows = db.prepare(`SELECT c.*, cp.name AS person_name, cp.role AS person_role,
      o.purpose AS outreach_purpose, o.status AS outreach_status
    FROM correspondence c
    LEFT JOIN contact_person cp ON cp.id = c.contact_person_id
    LEFT JOIN outreach o ON o.id = c.outreach_id
    WHERE c.physician_id = ? ORDER BY c.occurred_at DESC, c.id DESC`).all(req.params.id);
  const atts = db.prepare(`SELECT ca.correspondence_id, d.id, d.title, d.filename, d.doc_type, d.byte_size
    FROM correspondence_attachment ca JOIN document d ON d.id = ca.document_id
    WHERE ca.correspondence_id IN (SELECT id FROM correspondence WHERE physician_id = ?)`).all(req.params.id);
  rows.forEach(c => (c.attachments = atts.filter(a => a.correspondence_id === c.id)));
  res.json(rows);
});

r.post('/physicians/:id/correspondence', (req, res) => {
  const b = req.body;
  if (!b.direction || !b.channel) return res.status(400).json({ error: 'direction and channel required' });
  const info = db.prepare(`INSERT INTO correspondence
    (physician_id,contact_person_id,outreach_id,direction,channel,subject,body,occurred_at,logged_by)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.params.id, b.contact_person_id ?? null, b.outreach_id ?? null, b.direction, b.channel,
         b.subject ?? null, b.body ?? null, b.occurred_at ?? new Date().toISOString(), req.actor);
  const id = Number(info.lastInsertRowid);
  if (Array.isArray(b.document_ids))
    for (const d of b.document_ids)
      db.prepare('INSERT OR IGNORE INTO correspondence_attachment (correspondence_id,document_id) VALUES (?,?)').run(id, d);
  const after = db.prepare('SELECT * FROM correspondence WHERE id=?').get(id);
  audit('correspondence', id, 'create', req.actor, null, after);
  res.status(201).json(after);
});

r.delete('/correspondence/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM correspondence WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM correspondence WHERE id=?').run(req.params.id);
  audit('correspondence', +req.params.id, 'delete', req.actor, before, null);
  res.json({ deleted: true });
});

/** Recent activity across the whole network — the "what's happening" feed. */
r.get('/correspondence', (req, res) => {
  res.json(db.prepare(`SELECT c.*, p.full_name FROM correspondence c JOIN physician p ON p.id=c.physician_id
    ORDER BY c.occurred_at DESC LIMIT ?`).all(+(req.query.limit ?? 50)));
});
export default r;
