import { randomUUID } from 'node:crypto';
import { Database } from '../src/database.js';
import pino from 'pino';
import { Store } from '../src/store.js';
import { migrate } from '../src/migrate.js';
import { Switchboard } from '../src/switchboard.js';
import { configSchema } from '../src/config.js';
import { ProviderError, type Providers, type RemoteCall, type VapiCall } from '../src/providers.js';
import type { Session } from '../src/domain.js';

export const primary = 'v3:primary_control-id+123';
export const operator = '22222222-2222-4222-8222-222222222222';
export const destination = '33333333-3333-4333-8333-333333333333';
export const conference = '44444444-4444-4444-8444-444444444444';
export const config = configSchema.parse({
  DATABASE_PATH: ':memory:', PUBLIC_BASE_URL: 'https://switchboard.example.com',
  TELNYX_FROM_NUMBER: '+15551234567', ASTERISK_URL: 'http://127.0.0.1:8088/ari', ASTERISK_USERNAME: 'switchboard', ASTERISK_PASSWORD: 's'.repeat(32),
  BOSS_PERSONAL_NUMBER: '+971501234567', OPERATOR_PIN: '0427',
  ADMIN_TOKEN: 'b'.repeat(32), VAPI_WEBHOOK_SECRET: 'c'.repeat(32), VAPI_API_KEY: 'private-key',
  VAPI_PUBLIC_KEY: 'public-key', VAPI_ASSISTANT_ID: 'assistant-id', VAPI_SIP_URI: 'sip:switchboard@sip.vapi.ai', LOG_LEVEL: 'silent',
});
export const log = pino({ level: 'silent' });
export class FakeProviders implements Providers {
  online = true;
  available(): boolean { return this.online; }
  calls = new Map<string, string>([[primary, 'in-progress'], [operator, 'in-progress']]);
  participants = new Map<string, { callId: string; status: string; held: boolean }>([[primary, { callId: primary, status: 'connected', held: false }]]);
  ended: string[] = []; holds: { id: string; held: boolean }[] = []; spoken: string[] = [];
  contexts: string[] = []; creates = 0; operatorCreates = 0; closed = false; ambiguous = false; holdFails = false;
  muted = false; muteFails = false; muteCalls: boolean[] = [];
  ringing = false; ringbacks: boolean[] = [];
  async ringback(_conference: string, _primary: string, enabled: boolean): Promise<void> {
    this.ringing = enabled; this.ringbacks.push(enabled);
  }
  async conference(): Promise<string> { return conference; }
  async call(id: string): Promise<RemoteCall> { return { sid: id, status: this.calls.get(id) ?? 'completed' }; }
  async participant(_conference: string, label: string) { return this.participants.get(label); }
  async dialDestination(_s: Session, d: NonNullable<Session['destination']>): Promise<string> {
    this.creates++; this.calls.set(destination, 'ringing');
    this.participants.set(d.participantLabel, { callId: destination, status: 'ringing', held: false });
    if (this.ambiguous) throw new ProviderError('asterisk', 0, true);
    return destination;
  }
  async dialOperator(_s: Session, o: NonNullable<Session['operator']>): Promise<string> {
    this.operatorCreates++; this.calls.set(operator, 'in-progress');
    this.participants.set(o.participantLabel, { callId: operator, status: 'connected', held: false });
    return operator;
  }
  async hold(_conference: string, id: string, held: boolean): Promise<void> {
    if (this.holdFails) throw new ProviderError('asterisk', 500, true);
    this.holds.push({ id, held });
  }
  async coach(): Promise<void> {}
  async end(id: string, protectedPrimary: string, allowPrimary = false): Promise<void> {
    if (id === protectedPrimary && !allowPrimary) throw new Error('Primary protected');
    this.ended.push(id); this.calls.set(id, 'completed');
  }
  async endConference(): Promise<void> { this.closed = true; this.ringing = false; }
  async vapiCall(id: string): Promise<VapiCall> {
    return { id, assistantId: config.VAPI_ASSISTANT_ID, customer: { number: this.identity }, monitor: { controlUrl: 'https://live.vapi.ai/id/control' } };
  }
  identity = 'a'.repeat(64);
  async say(_url: string, content: string): Promise<void> {
    if (this.muted) throw new Error('Assistant speech is muted');
    this.spoken.push(content);
  }
  async context(_url: string, content: string): Promise<void> { this.contexts.push(content); }
  async mute(_url: string, muted: boolean): Promise<void> {
    if (this.muteFails) throw new ProviderError('vapi-control', 503, true);
    this.muted = muted; this.muteCalls.push(muted);
  }
}
export async function fixture() {
  const db = new Database(':memory:');
  await migrate(db);
  const store = new Store(db), providers = new FakeProviders();
  const board = new Switchboard(store, providers, log, config.OPERATOR_PIN);
  const s = board.newSession(primary);
  s.authentication = { state: 'verified' }; s.commandDeadline = null; s.conferenceId = conference; s.commandMode = 'open'; s.commandOpenedAt = Date.now() - 1000;
  s.operator = {
    generation: randomUUID(), identity: providers.identity, participantLabel: 'operator-test', carrierCallId: operator,
    vapiCallId: 'vapi-id', controlUrl: 'https://live.vapi.ai/id/control', state: 'connected', createdAt: Date.now(),
  };
  await store.create(s); await store.putContact('office', '+15550001111'); await store.putContact('number 1', '+15550002222');
  async function utterance(text: string) {
    const current = await store.get(primary);
    await board.transcript(primary, 'vapi-id', text, Math.max(Date.now(), (current?.consumedTurnAt ?? 0) + 1, (current?.lastCommand?.at ?? 0) + 1));
  }
  async function confirm(id = 'confirm') {
    await acknowledge(); await utterance('Yes please');
    return board.tool(primary, 'vapi-id', id, 'manage_outbound_call', { action: 'confirm', utterance: 'Yes please' });
  }
  async function acknowledge() {
    await board.speech(primary, 'vapi-id', 'started', Date.now() + 1);
    await board.speech(primary, 'vapi-id', 'stopped', Date.now() + 2);
  }
  async function dispose() { db.close(); }
  return { board, store, db, providers, utterance, acknowledge, confirm, dispose };
}
