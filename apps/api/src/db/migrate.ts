import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../config/logger';
import { closePool, pool } from './pool';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(): Promise<string[]> {
  await ensureMigrationsTable();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      // Each migration is atomic: either the whole file lands or none of it.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
      logger.info({ migration: file }, 'Applied migration');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, migration: file }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  if (ran.length === 0) logger.info('Database schema is up to date');
  return ran;
}

if (require.main === module) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration run failed');
      process.exit(1);
    });
}
