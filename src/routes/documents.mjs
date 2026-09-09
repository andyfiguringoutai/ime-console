import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, audit } from '../db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE = process.env.DOC_STORE || path.join(ROOT, 'data', 'documents');
fs.mkdirSync(STORE, { recursive: true });

// Disk storage keyed by physician. Swap for S3 later by replacing this block and
// the two fs calls below; `storage_path` is the only thing the schema knows about.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _f, cb) => {
      const d = path.join(STORE, String(req.params.id));
      fs.mkdirSync(d, { recursive: true });
      cb(null, d);
    },
    filename: (_q, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const r = Router();

r.get('/physicians/:id/documents', (req, res) => {
  const { doc_type, current_only } = req.query;
  let rows = db.prepare('SELECT * FROM document WHERE physician_id=? ORDER BY doc_type, version DESC').all(req.params.id);
  if (doc_type) rows = rows.filter(d => d.doc_type === doc_type);
  if (current_only === 'true') rows = rows.filter(d => d.is_current);
  res.json(rows);
});

/** multipart/form-data: file=<binary>, doc_type, title?, expires_on?, effective_on? */
r.post('/physicians/:id/documents', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required (multipart field name: file)' });
  const b = req.body;
  const TYPES = ['cv','licensure','contract','scheduling','fee_schedule','w9','insurance','report_sample','other'];
  if (!TYPES.includes(b.doc_type)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: `doc_type must be one of ${TYPES.join(', ')}` });
  }
  const hash = sha256(req.file.path);

  // Same bytes already filed under the SAME doc_type? Don't store it twice.
  // Scoped by doc_type on purpose: one PDF can legitimately be both a CV and a
  // licensure packet, and deduping across types silently loses the second filing.
  const dupe = db.prepare('SELECT * FROM document WHERE physician_id=? AND doc_type=? AND sha256=? AND is_current=1')
    .get(req.params.id, b.doc_type, hash);
  if (dupe) { fs.unlinkSync(req.file.path); return res.status(200).json({ ...dupe, deduped: true }); }

  // A new CV supersedes the old one rather than sitting beside it.
  const prev = db.prepare('SELECT * FROM document WHERE physician_id=? AND doc_type=? AND is_current=1 ORDER BY version DESC')
    .get(req.params.id, b.doc_type);
  const tx = db.transaction(() => {
    if (prev) db.prepare('UPDATE document SET is_current=0 WHERE id=?').run(prev.id);
    const info = db.prepare(`INSERT INTO document
      (physician_id,doc_type,title,filename,mime_type,byte_size,storage_path,sha256,version,supersedes_id,is_current,effective_on,expires_on,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
      .run(req.params.id, b.doc_type, b.title || req.file.originalname, req.file.originalname,
           req.file.mimetype, req.file.size, path.relative(ROOT, req.file.path), hash,
           prev ? prev.version + 1 : 1, prev ? prev.id : null,
           b.effective_on || null, b.expires_on || null, req.actor);
    return Number(info.lastInsertRowid);
  });
  const id = tx();
  const after = db.prepare('SELECT * FROM document WHERE id=?').get(id);
  audit('document', id, 'create', req.actor, null, after);
  res.status(201).json(after);
});

r.get('/documents/:id/file', (req, res) => {
  const d = db.prepare('SELECT * FROM document WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const abs = path.join(ROOT, d.storage_path);
  if (!fs.existsSync(abs)) return res.status(410).json({ error: 'file missing from store' });
  res.setHeader('Content-Type', d.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${d.filename}"`);
  fs.createReadStream(abs).pipe(res);
});

r.patch('/documents/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM document WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const f = ['title', 'doc_type', 'effective_on', 'expires_on', 'is_current'];
  const set = f.filter(k => k in req.body);
  if (set.length) db.prepare(`UPDATE document SET ${set.map(k => `${k}=@${k}`).join(',')} WHERE id=@id`)
    .run({ ...req.body, id: req.params.id });
  const after = db.prepare('SELECT * FROM document WHERE id=?').get(req.params.id);
  audit('document', +req.params.id, 'update', req.actor, before, after);
  res.json(after);
});

r.delete('/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM document WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const abs = path.join(ROOT, d.storage_path || '');
  db.prepare('DELETE FROM document WHERE id=?').run(req.params.id);
  // only unlink when no other row references the same bytes
  const stillUsed = db.prepare('SELECT COUNT(*) c FROM document WHERE sha256=?').get(d.sha256)?.c;
  if (!stillUsed && d.storage_path && fs.existsSync(abs)) fs.unlinkSync(abs);
  audit('document', +req.params.id, 'delete', req.actor, d, null);
  res.json({ deleted: true });
});

/** Credentials lapsed or lapsing. This is an action queue, not a report. */
r.get('/documents/expiring', (req, res) => {
  const days = +(req.query.days ?? 90);
  res.json(db.prepare('SELECT * FROM v_expiring_documents WHERE days_remaining <= ? ORDER BY days_remaining').all(days));
});
export default r;
