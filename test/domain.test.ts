import test from 'node:test';
import assert from 'node:assert/strict';
import { affirmative, commandSchema, e164, labelSchema, operatorIdentity, replies } from '../src/domain.js';

test('normalizes labels and rejects malformed telephone numbers', () => {
  assert.equal(labelSchema.parse('  NuMbEr   1 '), 'number 1');
  assert.equal(labelSchema.parse('Number One'), 'number 1');
  assert.throws(() => labelSchema.parse('  '));
  for (const n of ['15551234567', '+012345', '+12 hello', '+1234567890123456']) assert.throws(() => e164.parse(n));
});
test('command schema excludes call IDs, arbitrary numbers, and missing labels', () => {
  assert.throws(() => commandSchema.parse({ action: 'dial', utterance: 'Operator call office' }));
  assert.throws(() => commandSchema.parse({ action: 'hangup', utterance: 'Operator hang up', primaryCallId: 'caller' }));
  assert.throws(() => commandSchema.parse({ action: 'dial', label: 'office', number: '+15550001111', utterance: 'Operator call office' }));
});
test('confirmation accepts natural affirmative replies but rejects ambiguity and negation', () => {
  for (const text of ['Yes, please.', 'go ahead', 'Yeah', 'Operator, yes please', "That's right", 'sure do it', 'Sounds good', 'Please go ahead', "Yes, let's do it"]) assert.equal(affirmative(text), true, text);
  for (const text of ['no', 'yes but call someone else', 'maybe', 'do not do it', 'she said yes', 'yes or no', 'Operator call office']) assert.equal(affirmative(text), false, text);
});

test('all fixed operational responses contain at most seven words', () => {
  for (const phrase of Object.values(replies)) assert.ok(phrase.split(/\s+/).length <= 7, phrase);
});
test('SIP binding accepts only a full random identity', () => {
  const token = 'a'.repeat(64);
  assert.equal(operatorIdentity(token), token);
  assert.equal(operatorIdentity(`"Switchboard" <sip:${token}@example.com>`), token);
  assert.equal(operatorIdentity('sip:known-caller@example.com'), undefined);
  assert.equal(operatorIdentity(`prefix${token}`), undefined);
});

test('natural utterances and short follow-up answers need no Operator prefix', () => {
  assert.equal(commandSchema.parse({ action: 'dial', label: 'office', utterance: 'Get them at work instead' }).action, 'dial');
  assert.equal(commandSchema.parse({ action: 'clarify', question: 'Work or mobile?', utterance: 'Get Sarah' }).action, 'clarify');
  assert.equal(commandSchema.parse({ action: 'dial', label: 'sarah mobile', utterance: 'Mobile please' }).action, 'dial');
  assert.throws(() => commandSchema.parse({ action: 'clarify', utterance: 'Sarah' }));
  assert.throws(() => commandSchema.parse({ action: 'confirm', utterance: 'yes', label: 'other' }));
});
