// Apply db/schema.sql, then every db/migrations/*.sql in filename order.
// All statements are idempotent (CREATE ... IF NOT EXISTS), so re-running is safe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadEnv({ requireKey: false });
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL });

const schemaPath = path.join(HERE, '..', 'db', 'schema.sql');
await pool.query(fs.readFileSync(schemaPath, 'utf8'));
console.error('schema applied');

const migDir = path.join(HERE, '..', 'db', 'migrations');
if (fs.existsSync(migDir)) {
  for (const f of fs.readdirSync(migDir).filter((n) => n.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
    console.error('migration applied:', f);
  }
}

await pool.end();
console.error('migrate done');
