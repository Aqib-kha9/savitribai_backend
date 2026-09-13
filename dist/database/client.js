import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
/**
 * PostgreSQL client (database layer).
 * PostgreSQL is the system of record (docs/architecture.md).
 * All queries are parameterized — no string interpolation of user input (spec §28.8).
 */
export const pool = new Pool({
    connectionString: env.databaseUrl,
    max: env.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: env.databaseUrl.includes('localhost') ? false : {
        rejectUnauthorized: true,
        ca: fs.readFileSync(path.resolve(process.cwd(), 'ca.pem')).toString()
    },
});
pool.on('error', (error) => {
    logger.error({ error }, 'unexpected postgres pool error');
});
export async function query(text, params) {
    return pool.query(text, params);
}
export async function one(text, params) {
    const result = await query(text, params);
    return result.rows[0] ?? null;
}
/**
 * Runs `work` inside a single database transaction.
 * Balance and reconciliation mutations MUST run through this helper so that
 * row-level locking and atomicity are guaranteed (spec §28.6).
 */
export async function transaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    }
    catch (error) {
        try {
            await client.query('ROLLBACK');
        }
        catch {
            // connection already broken — nothing to roll back
        }
        throw error;
    }
    finally {
        client.release();
    }
}
