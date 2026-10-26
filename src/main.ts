import { Database } from './database.js';
import pino from 'pino';
import { loadConfig } from './config.js';
import { migrate } from './migrate.js';
import { Store } from './store.js';
import { failureDetails, HttpProviders } from './providers.js';
import { Switchboard } from './switchboard.js';
import { AsteriskEvents } from './asterisk.js';
import { createApp } from './app.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, redact: ['authorization', 'number', 'pin', 'controlUrl', 'identity'] });
const db = new Database(config.DATABASE_PATH);
await migrate(db);
const providers = new HttpProviders(config);
const board = new Switchboard(new Store(db, config.SESSION_RETENTION_DAYS), providers, log, config.OPERATOR_PIN);
const asterisk = new AsteriskEvents(config, providers, board, log);
asterisk.start();
let running: Promise<void> | undefined;
function recover(): void {
  if (running || !providers.available()) return;
  running = asterisk.synchronize().then(() => board.reconcile()).catch(error => { log.error({ event: 'worker_failed', ...failureDetails(error) }, 'Recovery will retry'); })
    .finally(() => { running = undefined; });
}
recover();
const timer = setInterval(recover, 15_000);
let expiring: Promise<void> | undefined;
const deadlines = setInterval(() => {
  if (expiring || stopping || !providers.available()) return;
  expiring = board.expireWindows().catch(() => { /* recover() logs failures on its 15-second reconciliation pass. */ })
    .finally(() => { expiring = undefined; });
}, 1000);
const server = createApp(config, board, log).listen(config.PORT, '127.0.0.1', () => log.info({ port: config.PORT }, 'Switchboard listening'));
server.requestTimeout = 60_000;
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true; clearInterval(timer); clearInterval(deadlines);
  // Backend shutdown never ends provider calls. Next startup reconciles them.
  const deadline = setTimeout(() => process.exit(1), 55_000); deadline.unref();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await asterisk.stop(); await running; await expiring; await db.close(); clearTimeout(deadline);
}
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
