import { Client } from 'pg';
import fs from 'fs';
import path from 'path';

const connectionString = process.env.NEXT_DB_CONNECTION_STRING;
const sslKeyPath = path.join(process.cwd(), '.temp', 'InitialKey.pem');

export async function runSelectQuery(query: string): Promise<any> {
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    throw new Error('Only SELECT queries are allowed.');
  }

  if (!connectionString) {
    throw new Error('Database connection string is missing.');
  }

  let sslConfig = undefined;
  if (fs.existsSync(sslKeyPath)) {
    sslConfig = {
      rejectUnauthorized: false,
      key: fs.readFileSync(sslKeyPath)
    };
  }

  const client = new Client({
    connectionString,
    ssl: sslConfig
  });

  try {
    await client.connect();
    const res = await client.query(query);
    await client.end();
    return res.rows;
  } catch (err) {
    await client.end();
    throw err;
  }
}
