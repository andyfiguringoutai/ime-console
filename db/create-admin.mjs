// One-time: create the first admin. node db/create-admin.mjs <email> <name> [password]
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { migrate } from './migrate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || path.join(ROOT, 'data', 'ime-network.db');
const [email, name, pw] = process.argv.slice(2);
if (!email || !name) { console.error('usage: node db/create-admin.mjs <email> <name> [password]'); process.exit(1); }

const db = new Database(dbPath);
migrate(db);
const password = pw || (Math.random().toString(36).slice(2, 12) + 'A1');
const mustReset = pw ? 0 : 1;
try {
  db.prepare('INSERT INTO app_user (email,name,password_hash,role,must_reset) VALUES (?,?,?,?,?)')
    .run(email, name, bcrypt.hashSync(password, 10), 'admin', mustReset);
  console.log(`\nAdmin created:\n  email:    ${email}\n  password: ${password}${pw ? '' : '   (temporary — change it after first login)'}\n`);
} catch (e) {
  if (String(e).includes('UNIQUE')) console.error(`A user with email ${email} already exists.`);
  else throw e;
}
db.close();
