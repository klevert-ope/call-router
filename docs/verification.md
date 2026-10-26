# Verification

## Local checks

Run with Node 22.13 or later:

```sh
npm ci
npm run check
npm run build
npm test
```

The type check includes source and tests. The build compiles the backend to `dist/`. Tests use isolated in-memory SQLite databases and temporary database files; no database server or container runtime is required.

The suite covers SQLite migrations, persistence, transactions, lease fencing, tool deduplication, HTTP authentication and validation, PIN parsing and timeouts, numbered contacts, private command authorization, destination isolation, caller ID selection, call switching, ambiguous originate results, operator replacement, and recovery. ARI REST and Vapi calls are simulated. ARI event tests use a real WebSocket connection to a simulated server.

On 2026-10-19 in the Windows workspace, `npm run check` and `npm run build` passed. `npm test` reported 64 passed, zero failed, and two skipped. The skipped tests require an explicitly enabled Asterisk instance. These results do not certify the deployed service or provider audio.

On 2026-10-25, the audit fixes added durable PIN/readiness delivery, five-attempt spoken retries, shared PIN pacing, admission limits, a persisted seven-minute reply deadline, matching-transcript waits, private command retries, frequency-specific media assertions, and fault-tolerant test cleanup. See [remediation evidence](audits/2026-10-25-remediation.md). The media oracle has explicit loopback, wrong-peer, and destination-leakage negative controls.

## Asterisk checks

The default component suite keeps both real Asterisk tests disabled unless `ASTERISK_TEST_ENABLED=1`:

| Test | Checks |
| --- | --- |
| `test/asterisk-live.test.ts` | Operator channel creation, bridges, holding, snoop setup, and event reconnection using local auto-answer channels |
| `test/asterisk-audio.test.ts` | Synthetic RTP audio in both directions, private hold isolation, resumption, and caller recovery |

Use disposable Linux Asterisk with the test dialplan and localhost ARI/RTP access. Follow [deployment](deployment.md#real-asterisk-tests) for commands. Neither test places external calls.

For the required real-Asterisk gate, set the enable flag and ARI credentials for a disposable instance, then run:

```sh
npm run test:asterisk
```

This command fails if configuration is absent, either test fails or times out, or the TAP report is missing, incomplete, or skipped. It requires exactly two passing real tests. Use this as a separate release gate; a default suite pass with skips does not meet it.

## Live acceptance

Follow [live acceptance](live-acceptance.md) to check Telnyx registration and routing, Vapi identity and controls, spoken authentication, actual phone audio, privacy, displayed caller ID, long sessions, and restart recovery. `/health/ready` checks SQLite and ARI availability; it does not prove those provider behaviors.

## Conversational controls

The conversation regression suite exercises natural transcript/tool pairs, short clarification answers, held-call cancellation/resumption, saved-contact discovery, confirmation before switching or ending, consumed-turn replay rejection, and invalidation after timeout, contact edits, destination changes, or control recovery. Existing status-to-mutation rejection, authentication, isolation, idempotency, and recovery tests remain enabled.

These tests supply tool intent explicitly. They verify backend behavior, not the Vapi model's semantic accuracy or live speech recognition. Publish the revised tool definitions and assistant prompt together, then complete conversational live acceptance to establish those behaviors. No real provider call or model evaluation is part of the default suite.
