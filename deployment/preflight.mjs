// Run after building: node --env-file=.env deployment/preflight.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { configSchema } from '../dist/config.js';

const result = configSchema.safeParse(process.env);
const errors = [];
if (!result.success) {
  // Never print Zod input values: they can include credentials.
  errors.push(...result.error.issues.map(issue => `Invalid configuration: ${issue.path.join('.')}`));
} else {
  const config = result.data;
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && /replace[-_]|example\.com|your-switchboard/i.test(value)) {
      errors.push(`Replace placeholder: ${key}`);
    }
  }
  const secrets = [config.ADMIN_TOKEN, config.VAPI_WEBHOOK_SECRET, config.ASTERISK_PASSWORD];
  if (new Set(secrets).size !== secrets.length) errors.push('Use separate admin, webhook, and ARI secrets');
  if (config.NODE_ENV !== 'production') errors.push('NODE_ENV must be production');
  if (config.PORT !== 3000) errors.push('Production proxy requires PORT=3000');
  if (config.ASTERISK_URL !== 'http://127.0.0.1:8088/ari') errors.push('Production ARI must use localhost:8088/ari');
  if (config.OPERATOR_PIN === '1234') errors.push('Replace the example operator PIN');
  try {
    const directory = new URL('./asterisk/', import.meta.url);
    const files = readdirSync(directory).filter(name => name.endsWith('.conf'));
    for (const name of ['ari.conf', 'http.conf', 'pjsip.conf', 'extensions.conf', 'rtp.conf', 'modules.conf', 'asterisk.conf', 'logger.conf']) {
      if (!files.includes(name)) errors.push(`Missing Asterisk file: ${name}`);
    }
    for (const name of files) {
      if (/REPLACE_/i.test(readFileSync(new URL(name, directory), 'utf8'))) errors.push(`Replace placeholders in Asterisk ${name}`);
    }
    const ari = readFileSync(new URL('ari.conf', directory), 'utf8');
    if (!ari.split(/\r?\n/).some(line => line.trim() === `password=${config.ASTERISK_PASSWORD}`)) {
      errors.push('ARI password does not match .env');
    }
  } catch {
    errors.push('Create a complete deployment/asterisk configuration from asterisk.example');
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log('Configuration preflight passed. DNS, firewall, provider setup, and live audio still require VPS verification.');
}
