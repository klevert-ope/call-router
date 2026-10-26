import WebSocket from 'ws';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { channelSchema, failureDetails, HttpProviders } from './providers.js';
import type { Switchboard } from './switchboard.js';

const eventSchema = z.object({ type: z.string(), channel: channelSchema.optional(), cause: z.number().optional() });
const applicationSchema = z.object({ channel_ids: z.array(z.string()) });
function hangupStatus(cause: number | undefined): string {
  if (cause === 17) return 'busy';
  if (cause === 18 || cause === 19) return 'no-answer';
  return cause === undefined || cause === 16 || cause === 31 ? 'completed' : 'failed';
}

// ARI is private and authenticated. Events contain no trusted session IDs:
// session ownership comes from persisted primary/attempt channel IDs.
export class AsteriskEvents {
  private socket?: WebSocket;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private alive = true;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly config: Config, private readonly providers: HttpProviders,
    private readonly board: Switchboard, private readonly log: Logger) {}
  start(): void {
    if (this.stopped) return;
    const url = new URL(`${this.config.ASTERISK_URL}/events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('app', this.config.ASTERISK_APP);
    const socket = new WebSocket(url, { headers: { Authorization: `Basic ${Buffer.from(`${this.config.ASTERISK_USERNAME}:${this.config.ASTERISK_PASSWORD}`).toString('base64')}` }, maxPayload: 128 * 1024, handshakeTimeout: 8000 });
    this.socket = socket;
    socket.on('open', () => {
      this.alive = true;
      this.heartbeat = setInterval(() => { if (!this.alive) socket.terminate(); else { this.alive = false; socket.ping(); } }, 15_000);
      this.enqueue(() => this.initialize());
    });
    socket.on('pong', () => { this.alive = true; });
    socket.on('message', data => {
      this.enqueue(async () => {
        const event = eventSchema.parse(JSON.parse(data.toString()));
        if (event.channel && ['StasisStart', 'ChannelStateChange', 'ChannelDestroyed', 'StasisEnd'].includes(event.type)) {
          const terminalStatus = event.type === 'ChannelDestroyed' ? hangupStatus(event.cause) : undefined;
          await this.handle(event.channel, event.type === 'StasisStart', terminalStatus);
        }
      });
    });
    socket.on('error', () => { this.log.warn({ event: 'ari_socket_error' }, 'Asterisk connection failed'); });
    socket.on('close', () => {
      this.providers.setConnected(false);
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.stopped) this.enqueue(() => this.board.suspendControls());
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 3000);
    });
  }
  private enqueue(action: () => Promise<void>): void {
    this.queue = this.queue.then(action).catch(error => {
      this.log.warn({ event: 'ari_event_failed', ...failureDetails(error) }, 'Asterisk event will reconcile');
      // Retry a complete authoritative scan after an event failed, including
      // inbound calls whose session had not yet been persisted.
      if (!this.stopped && this.socket?.readyState === WebSocket.OPEN) {
        if (this.retry) clearTimeout(this.retry);
        this.retry = setTimeout(() => this.enqueue(() => this.initialize()), 3000);
      }
    });
  }
  private async initialize(): Promise<void> {
    if (!this.providers.available()) await this.board.suspendControls();
    await this.synchronize();
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.providers.setConnected(true);
    await this.board.reconcile();
  }
  async synchronize(): Promise<void> {
    const app = applicationSchema.parse(await this.providers.ari(`applications/${encodeURIComponent(this.config.ASTERISK_APP)}`));
    for (const id of app.channel_ids) {
      const c = await this.providers.missing(() => this.providers.channel(id));
      if (c) await this.handle(c, true);
    }
  }
  private async handle(channel: z.infer<typeof channelSchema>, entering: boolean, terminalStatus?: string): Promise<void> {
    const id = channel.id;
    let session = await this.board.store.get(id);
    if (session) {
      if (session.phase === 'ended') { await this.providers.end(id, id, true); return; }
      if ((await this.providers.call(id)).status === 'completed') { await this.board.primaryEnded(id); return; }
      if (entering) { await this.providers.prepare(session); await this.board.joined(id, session.conferenceName); }
      return;
    }
    const observed = (await this.providers.call(id)).status;
    const status = observed === 'completed' ? terminalStatus ?? observed : observed;
    for (const s of await this.board.store.live()) {
      if (s.operator && id === `${s.operator.participantLabel}-snoop`) return;
      if (s.destination?.participantLabel === id) {
        // StasisEnd can precede ChannelDestroyed. Wait for its cause when possible;
        // polling still resolves a missing terminal event after a disconnect.
        if (status === 'completed' && !terminalStatus && !entering) return;
        await this.board.leg(s.primaryCallId, s.destination.attempt, 'destination', id, status); return;
      }
      if (s.operator?.participantLabel === id) {
        // The caller may have disappeared while its destroy event was missed.
        // Clean up before coaching; recreating a snoop on a missing caller fails
        // and would otherwise prevent the full recovery pass from running.
        if ((await this.providers.call(s.primaryCallId)).status === 'completed') {
          await this.board.primaryEnded(s.primaryCallId); return;
        }
        if ((await this.providers.call(id)).status === 'in-progress') await this.providers.coach(s.conferenceName, id, s.primaryCallId);
        await this.board.leg(s.primaryCallId, s.operator.generation, 'operator', id, status); return;
      }
    }
    if (/^(?:destination|operator)-[a-f0-9-]{36}(?:-snoop)?$/.test(id)) { await this.providers.end(id, 'unowned'); return; }
    if (!entering || channel.dialplan?.context !== 'from-telnyx') return;
    const normalize = (value: string) => /^\d+$/.test(value) ? `+${value}` : value;
    if (normalize(channel.dialplan.exten) !== this.config.TELNYX_FROM_NUMBER) {
      await this.providers.end(id, id, true); return;
    }
    session = this.board.newSession(id);
    if (!this.board.store.admit(session)) { await this.providers.end(id, id, true); return; }
    await this.providers.prepare(session);
    await this.board.joined(id, session.conferenceName);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.providers.setConnected(false);
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.terminate();
    await this.queue;
  }
}
