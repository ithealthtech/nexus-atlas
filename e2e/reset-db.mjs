import pg from 'pg';
import { rmSync } from 'node:fs';

const url = new URL(process.env.DATABASE_URL);
const name = url.pathname.slice(1);
if (!/^atlas_e2e\w*$/.test(name)) throw new Error(`Refusing to reset ${name}: e2e databases must be named atlas_e2e*.`);
url.pathname = '/postgres';
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
await client.query(`drop database if exists ${name} with (force)`);
await client.query(`create database ${name}`);
await client.end();
rmSync(process.env.ATLAS_DATA_DIR ?? 'test-results/e2e-data', { recursive: true, force: true });
