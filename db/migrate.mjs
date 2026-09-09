import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const dbPath = () => process.env.DB_PATH || path.join(__dir, '..', 'data', 'ime-network.db');

/** Applies every unapplied migration in db/migrations, in filename order. */
export function migrate(db = null) {
  const own = !db;
  db = db || new Database(dbPath());
  db.pragma('foreign_keys = OFF');   // table rebuilds need this off
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const done = new Set(db.prepare('SELECT filename FROM schema_migrations').all().map(r => r.filename));
  const files = fs.readdirSync(path.join(__dir, 'migrations')).filter(f => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(__dir, 'migrations', f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(f);
    })();
    applied.push(f);
  }
  db.pragma('foreign_keys = ON');
  if (own) db.close();
  return { applied, already: [...done] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = migrate();
  console.log(r.applied.length ? 'applied:\n  ' + r.applied.join('\n  ') : 'nothing to apply');
}
