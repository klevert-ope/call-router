import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// Queries and transactions run synchronously. No transaction spans provider I/O
// or an await, so concurrent callbacks cannot join another callback's writes.
export class Database {
  private readonly connection: DatabaseSync;
  constructor(path = './data/switchboard.sqlite') {
    if (!path.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error('DATABASE_PATH must be a local SQLite file path');
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  }
  exec(sql: string): void { this.connection.exec(sql); }
  query(sql: string, values: readonly unknown[] = []): { rows: Record<string, unknown>[]; rowCount: number } {
    const parameters: SQLInputValue[] = [];
    const statement = this.connection.prepare(sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = values[Number(index) - 1];
      if (value === undefined) throw new Error(`Missing SQL parameter ${index}`);
      parameters.push(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
        ? value : JSON.stringify(value));
      return '?';
    }));
    if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)) {
      const rows = statement.all(...parameters).map(row => {
        const result: Record<string, unknown> = { ...row };
        for (const key of ['data', 'reply']) if (typeof result[key] === 'string') result[key] = JSON.parse(result[key]);
        return result;
      });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: Number(statement.run(...parameters).changes) };
  }
  transaction<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    this.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.exec('COMMIT'); return result; }
    catch (error) { this.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.connection.close(); }
}
