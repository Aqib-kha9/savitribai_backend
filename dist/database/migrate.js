import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
/**
 * Migration runner.
 * - Applies every `NNN_*.sql` file from src/database/migrations in filename order.
 * - Each file runs inside its own transaction; the tracking row is written in
 *   the same transaction so a failed migration never leaves partial state.
 * - Applied files are checksummed; editing an already-applied migration is an error.
 */
const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));
async function main() {
    const pool = new Pool({
        connectionString: env.databaseUrl,
        max: 1,
        ssl: env.databaseUrl.includes('localhost') ? false : {
            rejectUnauthorized: true,
            ca: fs.readFileSync(path.resolve(process.cwd(), 'ca.pem')).toString()
        }
    });
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
        const files = readdirSync(migrationsDir)
            .filter((file) => file.endsWith('.sql'))
            .sort();
        if (files.length === 0) {
            logger.warn('no migration files found');
            return;
        }
        const { rows } = await pool.query('SELECT name, checksum FROM _migrations');
        const applied = new Map(rows.map((row) => [row.name, row.checksum]));
        for (const file of files) {
            const sql = readFileSync(join(migrationsDir, file), 'utf8');
            const checksum = createHash('sha256').update(sql).digest('hex');
            const existingChecksum = applied.get(file);
            if (existingChecksum !== undefined) {
                if (existingChecksum !== checksum) {
                    throw new Error(`migration ${file} was modified after being applied; create a new migration instead`);
                }
                logger.info({ migration: file }, 'already applied');
                continue;
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
                await client.query('COMMIT');
                logger.info({ migration: file }, 'applied');
            }
            catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
            finally {
                client.release();
            }
        }
        logger.info('migrations complete');
    }
    finally {
        await pool.end();
    }
}
main().catch((error) => {
    logger.error({ error }, 'migration failed');
    process.exitCode = 1;
});
