import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { e164, envelopeSchema, labelSchema, replies } from './domain.js';
import { Locked } from './store.js';
import type { Switchboard } from './switchboard.js';

export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function bearer(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!equalSecret(req.get('authorization') ?? '', `Bearer ${secret}`)) { res.sendStatus(401); return; }
    next();
  };
}
export function createApp(config: Config, board: Switchboard, log: Logger) {
  const app = express();
  app.disable('x-powered-by'); app.use(helmet());
  app.get('/health/live', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/health/ready', async (_req, res) => {
    try { if (!board.providers.available()) throw new Error('Telephony disconnected'); await board.store.db.query('SELECT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/admin', bearer(config.ADMIN_TOKEN), express.json({ limit: '16kb' }));
  app.get('/admin/contacts', async (_req, res) => { res.json({ contacts: await board.store.contacts() }); });
  app.put('/admin/contacts/:label', async (req, res) => {
    const label = labelSchema.parse(req.params.label);
    const body = z.object({ number: e164 }).strict().parse(req.body);
    await board.store.putContact(label, body.number); res.json({ label, number: body.number });
  });
  app.delete('/admin/contacts/:label', async (req, res) => {
    await board.store.deleteContact(labelSchema.parse(req.params.label)); res.sendStatus(204);
  });
  app.post('/webhook/vapi-switchboard', bearer(config.VAPI_WEBHOOK_SECRET), express.json({ limit: '128kb' }), async (req, res) => {
    const { message } = envelopeSchema.parse(req.body);
    let session = await board.store.byVapi(message.call.id);
    if (!session) session = await board.bind(await board.providers.vapiCall(message.call.id));
    if (!session) { res.sendStatus(403); return; }
    if (message.type === 'tool-calls') {
      if (!message.toolCallList?.length) { res.status(400).json({ error: 'Missing tool calls' }); return; }
      const results = [];
      for (const tool of message.toolCallList) {
        const reply = await board.tool(session.primaryCallId, message.call.id, tool.id, tool.function.name, tool.function.arguments);
        results.push({ toolCallId: tool.id, ...reply });
      }
      res.json({ results }); return;
    }
    // Only timestamped final caller transcripts and assistant speech events update state.
    // Other event types receive HTTP 200 without a state change.
    if (message.type === 'transcript' && message.role === 'user' && message.transcriptType === 'final' && message.transcript && message.timestamp) {
      await board.transcript(session.primaryCallId, message.call.id, message.transcript, message.timestamp);
    }
    if (message.type === 'speech-update' && message.role === 'assistant' && message.status && message.timestamp) {
      await board.speech(session.primaryCallId, message.call.id, message.status, message.timestamp);
    }
    res.sendStatus(200);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid request' }); return; }
    const parseError = z.object({ status: z.union([z.literal(400), z.literal(413)]) }).safeParse(error);
    if (parseError.success) { res.status(parseError.data.status).json({ error: 'Invalid request body' }); return; }
    if (error instanceof Locked) { res.status(503).json({ error: 'Session busy; retry' }); return; }
    log.error({ event: 'request_failed' }, 'Request failed');
    res.status(503).json({ error: replies.unavailable });
  });
  return app;
}
