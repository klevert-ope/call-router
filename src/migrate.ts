import { readFile, readdir } from 'node:fs/promises';
import { Database } from './database.js';
import { pathToFileURL } from 'node:url';

export async function migrate(db: Database): Promise<void> {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
  const statements = await Promise.all(files.map(file => readFile(new URL(file, directory), 'utf8')));
  db.transaction(() => {
    for (const sql of statements) db.exec(sql);
    if (db.query(`SELECT 1 FROM sessions WHERE primary_call_id GLOB 'CA*' AND length(primary_call_id)=34
      AND json_extract(data,'$.phase')<>'ended'`).rowCount) throw new Error('Drain active Twilio sessions before starting the Telnyx service');
    if (db.query(`SELECT 1 FROM sessions WHERE json_extract(data,'$.phase')<>'ended'
      AND COALESCE(json_extract(data,'$.carrier'),'')<>'telnyx'`).rowCount) {
      throw new Error('Drain active DIDWW/Asterisk or legacy sessions before starting the Telnyx SIP service');
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new Database(process.env.DATABASE_PATH);
  try { await migrate(db); } finally { db.close(); }
}
