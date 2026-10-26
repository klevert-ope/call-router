import { randomUUID } from 'node:crypto';
import { Database } from './database.js';
import { z } from 'zod';
import { sessionSchema, type Session, type Reply } from './domain.js';

const resultRow = z.object({ fingerprint: z.string(), reply: z.union([
  z.object({ result: z.string() }), z.object({ error: z.string() }), z.null(),
]) });
export class Locked extends Error {}

export class Store {
  private nextPruneAt = 0;
  constructor(readonly db: Database, private readonly retentionDays = 30) {}
  async create(s: Session): Promise<void> {
    await this.db.query('INSERT INTO sessions(primary_call_id,data) VALUES($1,$2) ON CONFLICT DO NOTHING', [s.primaryCallId, s]);
  }
  // Shared budgets do not trust caller ID. Fixed windows survive process restart.
  private budget(key: string, limit: number, consume: boolean, now: number): boolean {
    const row = this.db.query('SELECT attempts,expires_at FROM pin_attempts WHERE call_id=$1', [key]).rows[0];
    const attempts = row && Number(row.expires_at) > now ? Number(row.attempts) : 0;
    if (attempts >= limit) return false;
    if (consume) this.db.query(`INSERT INTO pin_attempts(call_id,attempts,expires_at) VALUES($1,1,$2)
      ON CONFLICT(call_id) DO UPDATE SET attempts=$3,expires_at=$4`,
    [key, now + 900_000, attempts + 1, attempts ? Number(row!.expires_at) : now + 900_000]);
    return true;
  }
  pinAllowed(now = Date.now()): boolean {
    const row = this.db.query('SELECT expires_at FROM pin_attempts WHERE call_id=$1', ['global:pin-pacing']).rows[0];
    return !row || Number(row.expires_at) <= now;
  }
  claimPinAttempt(now = Date.now()): boolean {
    return this.db.transaction(() => {
      if (!this.pinAllowed(now)) return false;
      const failures = this.db.query('SELECT attempts,expires_at FROM pin_attempts WHERE call_id=$1', ['global:pin-failures']).rows[0];
      if (failures && Number(failures.expires_at) > now && Number(failures.attempts) >= 6) this.pacePin(now);
      return true;
    });
  }
  private pacePin(now: number): void {
    this.db.query(`INSERT INTO pin_attempts(call_id,attempts,expires_at) VALUES($1,0,$2)
      ON CONFLICT(call_id) DO UPDATE SET expires_at=$2`, ['global:pin-pacing', now + 30_000]);
  }
  recordPinFailure(now = Date.now()): boolean {
    return this.db.transaction(() => {
      this.budget('global:pin-failures', Number.MAX_SAFE_INTEGER, true, now);
      const row = this.db.query('SELECT attempts FROM pin_attempts WHERE call_id=$1', ['global:pin-failures']).rows[0];
      if (Number(row?.attempts) >= 6) this.pacePin(now);
      return true;
    });
  }
  recordPinSuccess(): void {
    this.db.query('DELETE FROM pin_attempts WHERE call_id IN ($1,$2)', ['global:pin-failures', 'global:pin-pacing']);
  }
  admit(s: Session, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const pending = this.db.query(`SELECT count(*) AS n FROM sessions WHERE json_extract(data,'$.phase')<>'ended'
        AND json_extract(data,'$.authentication.state')='pending'`).rows[0];
      if (Number(pending?.n) >= 2 || !this.budget('global:admissions', 20, true, now)) return false;
      this.db.query('INSERT INTO sessions(primary_call_id,data) VALUES($1,$2)', [s.primaryCallId, s]);
      return true;
    });
  }
  async get(id: string): Promise<Session | undefined> {
    const r = await this.db.query('SELECT data FROM sessions WHERE primary_call_id=$1', [id]);
    return r.rows[0] ? sessionSchema.parse(r.rows[0].data) : undefined;
  }
  async byIdentity(identity: string): Promise<Session | undefined> {
    const r = await this.db.query("SELECT data FROM sessions WHERE json_extract(data,'$.operator.identity')=$1 AND json_extract(data,'$.phase')<>'ended'", [identity]);
    return r.rows[0] ? sessionSchema.parse(r.rows[0].data) : undefined;
  }
  async byVapi(id: string): Promise<Session | undefined> {
    const r = await this.db.query("SELECT data FROM sessions WHERE json_extract(data,'$.operator.vapiCallId')=$1 AND json_extract(data,'$.phase')<>'ended'", [id]);
    return r.rows[0] ? sessionSchema.parse(r.rows[0].data) : undefined;
  }
  async live(): Promise<Session[]> {
    const r = await this.db.query("SELECT data FROM sessions WHERE json_extract(data,'$.phase')<>'ended' ORDER BY updated_at");
    return r.rows.map(row => sessionSchema.parse(row.data));
  }
  async due(): Promise<Session[]> {
    const r = await this.db.query(`SELECT data FROM sessions WHERE json_extract(data,'$.phase')<>'ended'
      AND (json_extract(data,'$.commandDeadline') <= $1 OR json_extract(data,'$.replyDeadline') <= $1
      OR json_extract(data,'$.announcement.retryAt') <= $1 OR private_request_id IS NOT NULL)`, [Date.now()]);
    return r.rows.map(row => sessionSchema.parse(row.data));
  }
  async requestPrivate(id: string): Promise<void> {
    await this.db.query(`UPDATE sessions SET private_request_id=$2
      WHERE primary_call_id=$1 AND json_extract(data,'$.phase')='active' AND private_request_id IS NULL`, [id, randomUUID()]);
  }
  async privateRequest(id: string): Promise<string | null> {
    const r = await this.db.query('SELECT private_request_id FROM sessions WHERE primary_call_id=$1', [id]);
    return z.string().uuid().nullable().parse(r.rows[0]?.private_request_id ?? null);
  }
  async clearPrivateRequest(id: string, request: string): Promise<void> {
    await this.db.query('UPDATE sessions SET private_request_id=NULL WHERE primary_call_id=$1 AND private_request_id=$2', [id, request]);
  }
  async prune(): Promise<void> {
    if (Date.now() < this.nextPruneAt) return;
    this.db.transaction(() => {
      // Keep deduplication records until their entire session has expired.
      this.db.query(`CREATE TEMP TABLE expired_sessions AS
        SELECT primary_call_id FROM sessions WHERE json_extract(data,'$.phase')='ended'
        AND updated_at < (unixepoch('subsec')*1000) - $1 * 86400000`, [this.retentionDays]);
      this.db.query(`DELETE FROM tool_results WHERE vapi_call_id IN
        (SELECT json_extract(data,'$.vapiCallId') FROM call_attempts WHERE role='operator'
        AND primary_call_id IN (SELECT primary_call_id FROM expired_sessions))`);
      this.db.query('DELETE FROM call_attempts WHERE primary_call_id IN (SELECT primary_call_id FROM expired_sessions)');
      this.db.query('DELETE FROM sessions WHERE primary_call_id IN (SELECT primary_call_id FROM expired_sessions)');
      this.db.query("DELETE FROM pin_attempts WHERE expires_at<(unixepoch('subsec')*1000)");
      this.db.exec('DROP TABLE expired_sessions');
    });
    this.nextPruneAt = Date.now() + 3_600_000;
  }
  // Short DB leases serialize webhooks and recovery without holding transactions
  // across provider I/O. Every save checks ownership; heartbeat extends the lease.
  async locked<T>(id: string, fn: (s: Session, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const acquire = () => this.db.query(`UPDATE sessions SET lease_owner=$2,lease_until=(unixepoch('subsec')*1000)+60000
      WHERE primary_call_id=$1 AND (lease_until IS NULL OR lease_until<(unixepoch('subsec')*1000)) RETURNING data`, [id, owner]);
    let r = await acquire();
    const deadline = Date.now() + 2500;
    while (!r.rows[0] && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); r = await acquire();
    }
    if (!r.rows[0]) throw new Locked('Session unavailable');
    const s = sessionSchema.parse(r.rows[0].data);
    let snapshot = JSON.stringify(s);
    let destinationSnapshot = JSON.stringify(s.destination);
    let operatorSnapshot = JSON.stringify(s.operator);
    const save = async () => {
      const next = JSON.stringify(s);
      if (next === snapshot) return;
      this.db.transaction(() => {
        const saved = this.db.query(`UPDATE sessions SET data=$3,updated_at=(unixepoch('subsec')*1000),lease_until=(unixepoch('subsec')*1000)+60000
          WHERE primary_call_id=$1 AND lease_owner=$2 AND lease_until>(unixepoch('subsec')*1000)`, [id, owner, s]);
        if (saved.rowCount !== 1) throw new Locked('Lease lost');
        for (const attempt of [s.destination && JSON.stringify(s.destination) !== destinationSnapshot ? { id: s.destination.attempt, role: 'destination', data: s.destination } : null,
          s.operator && JSON.stringify(s.operator) !== operatorSnapshot ? { id: s.operator.generation, role: 'operator', data: s.operator } : null]) {
          if (attempt) this.db.query(`INSERT INTO call_attempts(attempt_id,primary_call_id,role,data) VALUES($1,$2,$3,$4)
            ON CONFLICT(attempt_id) DO UPDATE SET data=$4,updated_at=(unixepoch('subsec')*1000)`, [attempt.id, id, attempt.role, attempt.data]);
        }
      });
      snapshot = next; destinationSnapshot = JSON.stringify(s.destination); operatorSnapshot = JSON.stringify(s.operator);
    };
    let leaseLost = false;
    const timer = setInterval(() => {
      try {
        const r = this.db.query("UPDATE sessions SET lease_until=(unixepoch('subsec')*1000)+60000 WHERE primary_call_id=$1 AND lease_owner=$2 AND lease_until>(unixepoch('subsec')*1000)", [id, owner]);
        if (r.rowCount !== 1) leaseLost = true;
      } catch { leaseLost = true; }
    }, 10_000);
    timer.unref();
    try {
      const result = await fn(s, async () => { if (leaseLost) throw new Locked('Lease lost'); await save(); });
      await save();
      return result;
    } finally {
      clearInterval(timer);
      await this.db.query('UPDATE sessions SET lease_owner=NULL,lease_until=NULL WHERE primary_call_id=$1 AND lease_owner=$2', [id, owner]);
    }
  }
  async contact(label: string): Promise<string | undefined> {
    const r = await this.db.query('SELECT number FROM contacts WHERE label=$1', [label]);
    return r.rows[0] ? z.string().parse(r.rows[0].number) : undefined;
  }
  async contacts(): Promise<{ label: string; number: string }[]> {
    const r = await this.db.query('SELECT label,number FROM contacts ORDER BY label');
    return z.array(z.object({ label: z.string(), number: z.string() })).parse(r.rows);
  }
  async putContact(label: string, number: string): Promise<void> {
    await this.db.query(`INSERT INTO contacts(label,number) VALUES($1,$2) ON CONFLICT(label) DO UPDATE SET number=$2,updated_at=(unixepoch('subsec')*1000)`, [label, number]);
  }
  async deleteContact(label: string): Promise<void> { await this.db.query('DELETE FROM contacts WHERE label=$1', [label]); }
  async result(call: string, tool: string): Promise<z.infer<typeof resultRow> | undefined> {
    const r = await this.db.query('SELECT fingerprint,reply FROM tool_results WHERE vapi_call_id=$1 AND tool_call_id=$2', [call, tool]);
    return r.rows[0] ? resultRow.parse(r.rows[0]) : undefined;
  }
  async beginResult(call: string, tool: string, fingerprint: string): Promise<void> {
    await this.db.query('INSERT INTO tool_results(vapi_call_id,tool_call_id,fingerprint) VALUES($1,$2,$3)', [call, tool, fingerprint]);
  }
  async finishResult(call: string, tool: string, reply: Reply): Promise<void> {
    await this.db.query('UPDATE tool_results SET reply=$3 WHERE vapi_call_id=$1 AND tool_call_id=$2', [call, tool, reply]);
  }
}
