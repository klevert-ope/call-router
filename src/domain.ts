import { z } from 'zod';

const digitWords: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
function numberedLabel(text: string): string {
  return text.replace(/\bnumber (zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (_match, word: string) => `number ${digitWords[word]}`);
}
export function normalizeUtterance(text: string): string {
  return numberedLabel(text.toLowerCase().replace(/[,:.!?]/g, ' ').trim().replace(/\s+/g, ' '));
}

// Accept bounded provider IDs without interpreting their contents; URL builders encode them.
export const callSid = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.:+-]+$/);
export const conferenceSid = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const e164 = z.string().regex(/^\+[1-9]\d{1,14}$/);
export const labelSchema = z.string().transform(s => numberedLabel(s.trim().replace(/\s+/g, ' ').toLowerCase()))
  .pipe(z.string().min(1).max(80));
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dial'), label: labelSchema, utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('switch'), label: labelSchema, utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('hangup'), utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('status'), utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('contacts'), utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('resume'), utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('cancel'), utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('confirm'), utterance: z.string().max(500) }).strict(),
  z.object({ action: z.literal('clarify'), question: z.string().trim().min(1).max(240), utterance: z.string().max(500) }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
// Do not let an obvious question/greeting become a destructive tool action.
// Open-ended intent interpretation belongs to the assistant, not a phrase list.
export function informationalUtterance(utterance: string): boolean {
  const text = normalizeUtterance(utterance).replace(/^operator[\s-]+/, '');
  return /^(?:status|hello|hi|hey|thanks|thank you|goodbye|bye)$/.test(text)
    || /^(?:who (?:am i|are we) (?:connected|talking|speaking)|what(?:'s| is) (?:the (?:call )?status|happening)|is (?:the |my )?call (?:connected|ringing))\b/.test(text);
}
// Confirmation is a separate fresh turn, never an LLM-supplied boolean.
export function affirmative(utterance: string): boolean {
  const text = normalizeUtterance(utterance).replace(/^operator[\s-]+/, '');
  return /^(?:(?:yes|yeah|yep|sure|okay|ok|absolutely|certainly)(?: please| go ahead| do it| let's do it)?|please (?:do|do that|go ahead)|go ahead|do it|that's right|that is right|yes that's right|sounds good|that works|sure thing|of course)$/.test(text);
}
export type Reply = { result: string } | { error: string };
export const replies = {
  dialing: 'Dialing now.', connected: 'Connected.', idle: 'No active call.',
  hungup: "Their call ended. You're still connected.", busy: 'The line is busy.', noanswer: 'No answer.',
  missing: 'Contact not found. Who should I call?', switching: 'Switching now.',
  pending: 'Call status is uncertain. Please wait.', unavailable: 'Service unavailable. Please try again.',
  private: 'Say Operator for private commands.', invalid: 'Please repeat what you would like.',
  goodbye: 'Goodbye.',
} satisfies Record<string, string>;

export function terminal(status: string): boolean {
  return ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status);
}
export function failureReply(status: string): string {
  return status === 'busy' ? replies.busy : status === 'no-answer' ? replies.noanswer : status === 'failed' ? 'Call could not connect.' : 'Call ended.';
}

// A randomly generated SIP From username binds an operator leg to its session.
// It is never supplied by the LLM and never included in its prompt.
export function operatorIdentity(value: string): string | undefined {
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  return /^(?:[^<>]*<)?sip:([a-f0-9]{64})@[^<>\s]+>?$/.exec(value)?.[1];
}

export const sessionSchema = z.object({
  carrier: z.enum(['asterisk', 'telnyx']).optional(),
  authentication: z.discriminatedUnion('state', [
    z.object({ state: z.literal('pending'), attempts: z.number().int(), deadline: z.number(), lastTranscriptAt: z.number(), promptedGeneration: z.string().nullable() }),
    z.object({ state: z.literal('verified') }),
  ]).default({ state: 'pending', attempts: 0, deadline: 0, lastTranscriptAt: 0, promptedGeneration: null }),
  lastWakeAt: z.number().default(0),
  primaryCallId: callSid, conferenceName: z.string(), conferenceId: conferenceSid.nullable(),
  phase: z.enum(['active', 'ending', 'ended']),
  endPrimaryOnCleanup: z.boolean().default(false),
  commandMode: z.enum(['open', 'arming', 'closed']), commandDeadline: z.number().nullable(),
  replyDeadline: z.number().nullable().default(null),
  announcement: z.object({ kind: z.enum(['pin', 'pin-retry', 'ready']), generation: z.string(), retryAt: z.number(), expiresAt: z.number() }).nullable().default(null),
  commandOpenedAt: z.number(), lastCommand: z.object({ text: z.string(), at: z.number() }).nullable(),
  consumedTurnAt: z.number().default(0),
  confirmation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('switch'), label: labelSchema, number: e164, attempt: z.string().uuid(), requestedAt: z.number(), expiresAt: z.number() }),
    z.object({ kind: z.literal('end'), attempt: z.string().uuid().nullable(), requestedAt: z.number(), expiresAt: z.number() }),
  ]).nullable().default(null),
  lastContact: labelSchema.nullable().default(null),
  ack: z.object({ after: z.number(), started: z.boolean(), endSession: z.boolean(), retryCommand: z.boolean().optional() }).nullable(),
  pendingSwitch: z.object({ label: z.string(), number: e164 }).nullable().default(null),
  destination: z.object({
    attempt: z.string().uuid(), participantLabel: z.string(), label: z.string(), number: e164,
    callId: callSid.nullable(), state: z.enum(['queued', 'creating', 'unknown', 'ringing', 'connected', 'ending']),
    createdAt: z.number(), held: z.boolean(),
  }).nullable(),
  operator: z.object({
    generation: z.string().uuid(), identity: z.string(), participantLabel: z.string(),
    carrierCallId: callSid.nullable(), vapiCallId: z.string().nullable(),
    controlUrl: z.string().nullable(), state: z.enum(['creating', 'unknown', 'connected', 'ending']),
    createdAt: z.number(),
  }).nullable(),
  notice: z.string().nullable(),
  noticeDelivery: z.object({ content: z.string(), retryAt: z.number(), expiresAt: z.number() }).nullable().default(null),
  retryOperatorAt: z.number(),
});
export type Session = z.infer<typeof sessionSchema>;
export const toolSchema = z.object({
  id: z.string().min(1).max(200),
  function: z.object({ name: z.string(), arguments: z.unknown() }),
});
export const envelopeSchema = z.object({ message: z.object({
  type: z.string(), timestamp: z.number().optional(),
  call: z.object({ id: z.string().min(1).max(200) }),
  toolCallList: z.array(toolSchema).max(8).optional(),
  role: z.string().optional(), status: z.string().optional(),
  transcript: z.string().max(10000).optional(), transcriptType: z.string().optional(),
}) });

export function spokenDigits(text: string): string | undefined {
  const parts = text.toLowerCase().trim().replace(/[,:.!?-]/g, ' ').trim().split(/\s+/);
  const digits = parts.map(part => /^\d+$/.test(part) ? part : digitWords[part] ?? '').join('');
  return parts.every(part => /^\d+$/.test(part) || digitWords[part] !== undefined) && /^\d{1,4}$/.test(digits) ? digits : undefined;
}
export function spokenPin(text: string): string | undefined {
  const digits = spokenDigits(text);
  return digits?.length === 4 ? digits : undefined;
}
export function wakeWord(text: string): boolean { return /^operator[,.!?]*$/i.test(text.trim()); }
