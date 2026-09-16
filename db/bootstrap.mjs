/**
 * First-boot bootstrap. Runs on every start; does work only when needed.
 *
 * This exists because Railway's web console/WebSocket wasn't reachable, so the
 * usual seed-in-a-shell step wasn't available. Instead the app populates itself:
 *   - empty database  -> migrate, seed, import the bundled export
 *   - no admin yet     -> create one from env vars (ADMIN_EMAIL / ADMIN_NAME)
 *
 * Every step is idempotent and guarded, so restarts and redeploys are safe:
 * once data and an admin exist, this does nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { migrate } from './migrate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'storage', 'ime-network.db');
const EXPORT = path.join(ROOT, 'data', 'FFD_Provider_Directory_Export__1_.xlsx');

export async function bootstrap() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  migrate();   // always safe; applies only unapplied migrations

  const db = new Database(DB_PATH);
  const physicians = db.prepare('SELECT COUNT(*) c FROM physician').get().c;

  // 1. Empty database -> seed + import the bundled export
  if (physicians === 0) {
    console.log('[bootstrap] empty database — seeding…');
    db.close();
    const { seed } = await import('./seed.mjs');
    seed({ fresh: false });                       // migrations already applied
    if (fs.existsSync(EXPORT)) {
      const { importXlsx } = await import('./import.mjs');
      const r = importXlsx(EXPORT, { actor: 'bootstrap' });
      console.log(`[bootstrap] imported: +${r.inserted.length} new, ${r.updated.length} updated`);
    }
  } else {
    db.close();
    console.log(`[bootstrap] database already has ${physicians} physicians — skipping seed`);
  }

  // 2. No admin yet -> create one from env vars
  const db2 = new Database(DB_PATH);
  const admins = db2.prepare("SELECT COUNT(*) c FROM app_user WHERE is_active=1").get().c;
  if (admins === 0) {
    const email = process.env.ADMIN_EMAIL;
    const name = process.env.ADMIN_NAME || 'Admin';
    const pw = process.env.ADMIN_PASSWORD;
    if (email && pw) {
      db2.prepare('INSERT INTO app_user (email,name,password_hash,role,must_reset) VALUES (?,?,?,?,1)')
        .run(email, name, bcrypt.hashSync(pw, 10), 'admin');
      console.log(`[bootstrap] created admin ${email} (change the password after first login)`);
    } else {
      console.log('[bootstrap] no admin and no ADMIN_EMAIL/ADMIN_PASSWORD set — set them in Railway Variables, then redeploy');
    }
  }
  db2.close();
}
