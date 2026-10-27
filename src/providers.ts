import { z } from 'zod';
import type { Config } from './config.js';
import { callSid, operatorIdentity, type Session } from './domain.js';

export class ProviderError extends Error {
  constructor(readonly provider: string, readonly status: number, readonly ambiguous: boolean) {
    super(`${provider} request failed`);
  }
}
// Exclude upstream messages, URLs, payloads, speech, and credentials from logs.
export function failureDetails(error: unknown): Record<string, unknown> {
  return error instanceof ProviderError
    ? { provider: error.provider, status: error.status, ambiguous: error.ambiguous }
    : { errorType: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof Error && error.message === 'Speech limit exceeded' ? { reason: 'speech_limit_exceeded' } : {}) };
}
export const remoteCallSchema = z.object({ sid: callSid, status: z.string() });
export const channelSchema = z.object({ id: callSid, state: z.string(), caller: z.object({ number: z.string() }).optional(), dialplan: z.object({ context: z.string(), exten: z.string() }).optional() });
const bridgeSchema = z.object({ id: z.string(), channels: z.array(z.string()) });
const playbackSchema = z.object({ id: z.string(), state: z.string() });
const vapiCallSchema = z.object({
  id: z.string(), assistantId: z.string(), status: z.string().optional(),
  customer: z.object({ number: z.string().optional(), sipUri: z.string().optional() }),
  monitor: z.object({ controlUrl: z.string().optional() }).optional(),
});
export type RemoteCall = z.infer<typeof remoteCallSchema>;
export type VapiCall = z.infer<typeof vapiCallSchema>;
type Destination = NonNullable<Session['destination']>;
type Operator = NonNullable<Session['operator']>;

async function attemptAll(actions: (() => Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Telephony cleanup incomplete');
}

export interface Providers {
  available(): boolean;
  conference(name: string): Promise<string | undefined>;
  call(id: string): Promise<RemoteCall>;
  participant(conference: string, label: string): Promise<{ callId: string; status: string; held: boolean } | undefined>;
  dialDestination(s: Session, d: Destination): Promise<string>;
  dialOperator(s: Session, o: Operator): Promise<string>;
  hold(conference: string, id: string, held: boolean, primary: string): Promise<void>;
  coach(conference: string, operator: string, primary: string): Promise<void>;
  ringback(conference: string, primary: string, enabled: boolean): Promise<void>;
  end(id: string, primary: string, allowPrimary?: boolean): Promise<void>;
  endConference(id: string): Promise<void>;
  vapiCall(id: string): Promise<VapiCall>;
  say(url: string, content: string): Promise<void>;
  context(url: string, content: string): Promise<void>;
  mute(url: string, muted: boolean): Promise<void>;
}

export class HttpProviders implements Providers {
  constructor(private readonly config: Config, private readonly request: typeof fetch = fetch) {}
  private async json(url: string, init: RequestInit, provider: string, expectJson = true): Promise<unknown> {
    let response: Response;
    try { response = await this.request(url, { ...init, signal: AbortSignal.timeout(8_000), redirect: 'error' }); }
    catch { throw new ProviderError(provider, 0, true); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(provider, response.status, response.status >= 500 || response.status === 408);
    }
    if (response.status === 204 || !expectJson) {
      await response.body?.cancel().catch(() => {});
      return {};
    }
    try { return await response.json(); }
    catch { throw new ProviderError(provider, response.status, true); }
  }
  private connected = false;
  available(): boolean { return this.connected; }
  setConnected(value: boolean): void { this.connected = value; }
  async ari(path: string, method = 'GET', fields: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const url = new URL(`${this.config.ASTERISK_URL}/${path}`);
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    return this.json(url.href, {
      method, headers: { Authorization: `Basic ${Buffer.from(`${this.config.ASTERISK_USERNAME}:${this.config.ASTERISK_PASSWORD}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, 'asterisk');
  }
  async missing<T>(action: () => Promise<T>): Promise<T | undefined> {
    try { return await action(); }
    catch (e) { if (e instanceof ProviderError && e.status === 404) return undefined; throw e; }
  }
  async channel(id: string) {
    const channel = channelSchema.parse(await this.ari(`channels/${encodeURIComponent(callSid.parse(id))}`));
    if (channel.id !== id) throw new Error('Carrier call identity mismatch');
    return channel;
  }
  async call(id: string): Promise<RemoteCall> {
    const c = await this.missing(() => this.channel(id));
    return { sid: id, status: !c ? 'completed' : c.state === 'Up' ? 'in-progress' : ['Ring', 'Ringing'].includes(c.state) ? 'ringing' : 'queued' };
  }
  async conference(name: string): Promise<string | undefined> {
    const bridge = await this.missing(async () => bridgeSchema.parse(await this.ari(`bridges/${encodeURIComponent(name)}`)));
    return bridge?.id;
  }
  async bridge(id: string, type = 'mixing,proxy_media'): Promise<void> {
    try { await this.ari(`bridges/${encodeURIComponent(id)}`, 'POST', { type }); }
    catch (e) { if (!(e instanceof ProviderError && e.status === 409)) throw e; }
  }
  async add(bridge: string, channel: string): Promise<void> {
    await this.ari(`bridges/${encodeURIComponent(bridge)}/addChannel`, 'POST', { channel });
    if (!await this.inBridge(bridge, channel)) throw new Error('Bridge membership unverified');
  }
  async inBridge(bridge: string, channel: string): Promise<boolean> {
    const b = await this.missing(async () => bridgeSchema.parse(await this.ari(`bridges/${encodeURIComponent(bridge)}`)));
    return b?.channels.includes(channel) ?? false;
  }
  async prepare(s: Session): Promise<void> {
    await this.bridge(s.conferenceName);
    await this.ari(`channels/${encodeURIComponent(s.primaryCallId)}/answer`, 'POST');
    await this.add(s.conferenceName, s.primaryCallId);
    await this.callerAudio(s.conferenceName, s.primaryCallId);
  }
  private async callerAudio(conference: string, primary: string): Promise<void> {
    const bridge = bridgeSchema.parse(await this.ari(`bridges/${encodeURIComponent(conference)}`));
    // A generator supplies whisper timing only while the caller is alone.
    // Asterisk discards other channel writes while this generator is active,
    // so stop it whenever the destination supplies the caller's audio stream.
    await this.ari(`channels/${encodeURIComponent(primary)}/silence`,
      bridge.channels.some(id => id !== primary) ? 'DELETE' : 'POST');
  }
  async participant(conference: string, label: string) {
    const c = await this.missing(() => this.channel(label));
    if (!c) return undefined;
    if (!/^(?:destination|operator)-/.test(label) && !await this.inBridge(conference, label)) return undefined;
    return { callId: c.id, status: (await this.call(c.id)).status, held: await this.inBridge(`${conference}-hold`, c.id) };
  }
  private async originate(id: string, endpoint: string, args: string, callerId: string): Promise<string> {
    // The deterministic ID is persisted by the switchboard before this request.
    // A timeout is reconciled by ID and never retried with a fresh ID.
    // Angle brackets make ARI parse alphanumeric SIP identities as numbers,
    // setting both caller and connected-line identity before SIP negotiation.
    const c = channelSchema.parse(await this.ari('channels', 'POST', {
      channelId: id, endpoint, app: this.config.ASTERISK_APP, appArgs: args, callerId: `<${callerId}>`, timeout: '30',
    }));
    if (c.id !== id) throw new Error('Originated channel identity mismatch');
    return c.id;
  }
  dialDestination(s: Session, d: Destination): Promise<string> {
    return this.originate(d.participantLabel, `PJSIP/${d.number}@${this.config.TELNYX_ENDPOINT}`,
      `destination,${s.primaryCallId},${d.attempt}`, this.config.OUTBOUND_CALLER_ID ?? this.config.BOSS_PERSONAL_NUMBER);
  }
  async dialOperator(s: Session, o: Operator): Promise<string> {
    // Asterisk rejects the operator ID if its longer snoop ID already exists.
    // Allocate the operator first; Stasis events finish bridging once it answers.
    const id = await this.originate(o.participantLabel, `PJSIP/${this.config.VAPI_ENDPOINT}/${this.config.VAPI_SIP_URI}`,
      `operator,${s.primaryCallId},${o.generation}`, o.identity);
    await this.coach(s.conferenceName, o.participantLabel, s.primaryCallId);
    return id;
  }
  async hold(conference: string, id: string, held: boolean, primary: string): Promise<void> {
    const target = held ? `${conference}-hold` : conference;
    const other = held ? conference : `${conference}-hold`;
    await this.bridge(target, held ? 'holding' : 'mixing,proxy_media');
    if (await this.inBridge(other, id)) await this.ari(`bridges/${encodeURIComponent(other)}/removeChannel`, 'POST', { channel: id });
    await this.add(target, id);
    if (await this.inBridge(other, id)) throw new Error('Destination isolation unverified');
    await this.callerAudio(conference, primary);
  }
  async coach(conference: string, operator: string, primary: string): Promise<void> {
    const bridge = `${operator}-audio`, snoop = `${operator}-snoop`;
    await this.bridge(bridge);
    if (!await this.missing(() => this.channel(snoop))) {
      await this.ari(`channels/${encodeURIComponent(primary)}/snoop/${encodeURIComponent(snoop)}`, 'POST', {
        spy: 'in', whisper: 'out', app: this.config.ASTERISK_APP, appArgs: `snoop,${primary}`,
      });
    }
    await this.add(bridge, snoop);
    if ((await this.call(operator)).status === 'in-progress') await this.add(bridge, operator);
    await this.callerAudio(conference, primary);
  }
  async ringback(conference: string, primary: string, enabled: boolean): Promise<void> {
    const id = `${conference}-ringback`;
    if (!enabled) {
      const removed = await this.missing(() => this.ari(`playbacks/${encodeURIComponent(id)}`, 'DELETE'));
      if (removed) await this.callerAudio(conference, primary);
      return;
    }
    const playback = await this.missing(async () => playbackSchema.parse(await this.ari(`playbacks/${encodeURIComponent(id)}`)));
    if (playback && ['queued', 'playing'].includes(playback.state)) return;
    const bridge = bridgeSchema.parse(await this.ari(`bridges/${encodeURIComponent(conference)}`));
    if (bridge.channels.length !== 1 || bridge.channels[0] !== primary) throw new Error('Ringback bridge is not caller-only');
    // Bridge playback supplies audio timing. Leaving the caller's silence
    // generator active would suppress ringback just as it suppresses a peer.
    await this.ari(`channels/${encodeURIComponent(primary)}/silence`, 'DELETE');
    await this.ari(`bridges/${encodeURIComponent(conference)}/play/${encodeURIComponent(id)}`, 'POST', { media: 'tone:ring;tonezone=us' });
  }
  async end(id: string, primary: string, allowPrimary = false): Promise<void> {
    if (id === primary && !allowPrimary) throw new Error('Primary leg protected');
    const actions = [() => this.missing(() => this.ari(`channels/${encodeURIComponent(callSid.parse(id))}`, 'DELETE'))];
    if (/^operator-[a-f0-9-]{36}$/.test(id)) {
      actions.push(() => this.missing(() => this.ari(`channels/${encodeURIComponent(`${id}-snoop`)}`, 'DELETE')),
        () => this.missing(() => this.ari(`bridges/${encodeURIComponent(`${id}-audio`)}`, 'DELETE')));
    }
    await attemptAll(actions);
  }
  async endConference(id: string): Promise<void> {
    await attemptAll([() => this.missing(() => this.ari(`playbacks/${encodeURIComponent(`${id}-ringback`)}`, 'DELETE')),
      ...[id, `${id}-hold`].map(bridge => async () => {
        const b = await this.missing(async () => bridgeSchema.parse(await this.ari(`bridges/${encodeURIComponent(bridge)}`)));
        // Bridge deletion does not terminate channels; the switchboard also
        // hangs up every owned leg independently.
        if (b) await this.ari(`bridges/${encodeURIComponent(bridge)}`, 'DELETE');
      })]);
  }
  async vapiCall(id: string): Promise<VapiCall> {
    const c = vapiCallSchema.parse(await this.json(`https://api.vapi.ai/call/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.config.VAPI_API_KEY}` },
    }, 'vapi'));
    if (c.id !== id || c.assistantId !== this.config.VAPI_ASSISTANT_ID || !(operatorIdentity(c.customer.number ?? '') ?? operatorIdentity(c.customer.sipUri ?? ''))) {
      throw new Error('Operator identity mismatch');
    }
    return c;
  }
  private controlUrl(value: string): string {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.vapi.ai') || u.username || u.password || u.port || !u.pathname.endsWith('/control')) {
      throw new Error('Invalid Vapi control URL');
    }
    return u.href;
  }
  private async control(url: string, payload: unknown): Promise<void> {
    await this.json(this.controlUrl(url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.VAPI_PUBLIC_KEY}` },
      body: JSON.stringify(payload),
    }, 'vapi-control', false);
  }
  say(url: string, content: string): Promise<void> {
    if (content.trim().split(/\s+/).length > 7) throw new Error('Speech limit exceeded');
    return this.control(url, { type: 'say', content, endCallAfterSpoken: false });
  }
  context(url: string, content: string): Promise<void> {
    return this.control(url, { type: 'add-message', message: { role: 'system', content }, triggerResponseEnabled: false });
  }
  mute(url: string, muted: boolean): Promise<void> {
    return this.control(url, { type: 'control', control: muted ? 'mute-assistant' : 'unmute-assistant' });
  }
}
