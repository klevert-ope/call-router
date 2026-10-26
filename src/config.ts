import { z } from 'zod';
import { e164 } from './domain.js';

const secret = z.string().min(32);
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  DATABASE_PATH: z.string().trim().min(1).refine(value => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), 'Use a local SQLite file path').default('./data/switchboard.sqlite'),
  PUBLIC_BASE_URL: z.url().refine(s => {
    const u = new URL(s);
    return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password;
  }, 'Public URL must be an HTTPS origin without credentials, query, or path')
    .transform(s => s.replace(/\/$/, '')),
  TELNYX_FROM_NUMBER: e164,
  OUTBOUND_CALLER_ID: e164.optional(),
  ASTERISK_URL: z.url().refine(value => {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/ari';
  }, 'Asterisk URL must end in /ari without credentials or query'),
  ASTERISK_USERNAME: z.string().regex(/^[A-Za-z0-9_-]+$/),
  ASTERISK_PASSWORD: secret,
  ASTERISK_APP: z.string().regex(/^[A-Za-z0-9_-]+$/).default('switchboard'),
  TELNYX_ENDPOINT: z.string().regex(/^[A-Za-z0-9_-]+$/).default('telnyx-out'),
  VAPI_ENDPOINT: z.string().regex(/^[A-Za-z0-9_-]+$/).default('vapi'),
  BOSS_PERSONAL_NUMBER: e164.optional(), AUTHORIZED_CALLER: e164.optional(),
  OPERATOR_PIN: z.string().regex(/^\d{4}$/, 'Operator PIN must contain exactly four digits'),
  ADMIN_TOKEN: secret, VAPI_WEBHOOK_SECRET: secret,
  VAPI_API_KEY: z.string().min(1), VAPI_PUBLIC_KEY: z.string().min(1),
  VAPI_ASSISTANT_ID: z.string().min(1), VAPI_SIP_URI: z.string().regex(/^sip:[^?\s]+@sip(?:\.eu)?\.vapi\.ai$/),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
}).superRefine((config, ctx) => {
  if (!config.BOSS_PERSONAL_NUMBER && !config.AUTHORIZED_CALLER) {
    ctx.addIssue({ code: 'custom', path: ['BOSS_PERSONAL_NUMBER'], message: 'Boss personal number is required' });
  }
  if (config.BOSS_PERSONAL_NUMBER && config.AUTHORIZED_CALLER && config.BOSS_PERSONAL_NUMBER !== config.AUTHORIZED_CALLER) {
    ctx.addIssue({ code: 'custom', path: ['AUTHORIZED_CALLER'], message: 'AUTHORIZED_CALLER must match BOSS_PERSONAL_NUMBER when both are set' });
  }
}).transform(config => {
  const boss = e164.parse(config.BOSS_PERSONAL_NUMBER ?? config.AUTHORIZED_CALLER);
  return { ...config, BOSS_PERSONAL_NUMBER: boss, AUTHORIZED_CALLER: boss };
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(): Config { return configSchema.parse(process.env); }
