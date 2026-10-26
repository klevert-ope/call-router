import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../src/config.js';
import { config } from './helpers.js';

test('Boss number is the canonical caller identity, with legacy configuration supported', () => {
  const number = '+971501234567';
  const parsed = configSchema.parse({ ...config, BOSS_PERSONAL_NUMBER: number, AUTHORIZED_CALLER: undefined });
  assert.equal(parsed.BOSS_PERSONAL_NUMBER, number);
  assert.equal(parsed.AUTHORIZED_CALLER, number);
  const legacy = configSchema.parse({ ...config, BOSS_PERSONAL_NUMBER: undefined });
  assert.equal(legacy.BOSS_PERSONAL_NUMBER, config.AUTHORIZED_CALLER);
});

test('missing, malformed and conflicting Boss identities are rejected', () => {
  for (const overrides of [
    { BOSS_PERSONAL_NUMBER: undefined, AUTHORIZED_CALLER: undefined },
    { BOSS_PERSONAL_NUMBER: '+97150XXXXXXX', AUTHORIZED_CALLER: undefined },
    { BOSS_PERSONAL_NUMBER: '+971509876543', AUTHORIZED_CALLER: config.AUTHORIZED_CALLER },
  ]) assert.equal(configSchema.safeParse({ ...config, ...overrides }).success, false);
});

test('operator PIN requires exactly four digits and preserves leading zeros', () => {
  for (const pin of ['0000', '0427', '9876']) {
    assert.equal(configSchema.parse({ ...config, OPERATOR_PIN: pin }).OPERATOR_PIN, pin);
  }
  for (const pin of ['', '123', '12345', '123456', '12a4', ' 1234', '1234 ', 1234]) {
    assert.equal(configSchema.safeParse({ ...config, OPERATOR_PIN: pin }).success, false);
  }
});

test('Telnyx SIP and ARI configuration requires the new carrier settings', () => {
  for (const overrides of [
    { ASTERISK_URL: undefined }, { ASTERISK_PASSWORD: 'short' },
    { ASTERISK_URL: 'https://user:pass@host/ari' }, { ASTERISK_URL: 'https://host/ari?key=secret' },
    { TELNYX_FROM_NUMBER: undefined }, { TELNYX_FROM_NUMBER: '+97150XXXXXXX' }, { TELNYX_ENDPOINT: '../bad' },
  ]) assert.equal(configSchema.safeParse({ ...config, ...overrides }).success, false);
  assert.equal(configSchema.safeParse({ ...config, TELNYX_FROM_NUMBER: undefined, DIDWW_NUMBER: config.TELNYX_FROM_NUMBER }).success, false);
  assert.equal(configSchema.parse(config).TELNYX_ENDPOINT, 'telnyx-out');
  assert.equal(configSchema.parse(config).NODE_ENV, 'production');
  assert.equal(configSchema.parse({ ...config, OUTBOUND_CALLER_ID: '+15551234567' }).OUTBOUND_CALLER_ID, '+15551234567');
  assert.equal(configSchema.safeParse({ ...config, OUTBOUND_CALLER_ID: 'invalid' }).success, false);
  assert.equal(configSchema.parse({ ...config, VAPI_SIP_URI: 'sip:operator@sip.eu.vapi.ai' }).VAPI_SIP_URI, 'sip:operator@sip.eu.vapi.ai');
});


test('SQLite configuration defaults to a local file and rejects server URLs', () => {
  assert.equal(configSchema.parse({ ...config, DATABASE_PATH: undefined }).DATABASE_PATH, './data/switchboard.sqlite');
  for (const path of ['', '  ', 'postgres://localhost/db', 'sqlite://host/db']) {
    assert.equal(configSchema.safeParse({ ...config, DATABASE_PATH: path }).success, false);
  }
  assert.equal(configSchema.parse({ ...config, DATABASE_PATH: 'C:\\data\\switchboard.sqlite' }).DATABASE_PATH, 'C:\\data\\switchboard.sqlite');
});
