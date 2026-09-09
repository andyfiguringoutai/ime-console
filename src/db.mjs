import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'ime-network.db');  // set DB_PATH before importing this module
export const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

/** Append-only provenance. Every mutation goes through this. */
export function audit(entity, entity_id, action, actor, before, after) {
  db.prepare(`INSERT INTO audit_log (entity,entity_id,action,actor,before_json,after_json)
              VALUES (?,?,?,?,?,?)`)
    .run(entity, entity_id, action, actor || 'unknown',
         before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
export const actorOf = (req) => req.get('x-actor') || req.body?.actor || 'unknown';
