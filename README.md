# Persistent voice switchboard

TypeScript/Express, Telnyx SIP trunks, Asterisk 22.8.0, Vapi, and SQLite. Your incoming call stays connected while dialing, switching, or disconnecting destinations. Access and commands use speech only.

```text
Your mobile -> Telnyx -> Asterisk -> Telnyx outbound -> Contact
                          |
               caller-only snoop/whisper
                          |
                     Vapi operator
                          |
                  HTTPS backend tools
```

Asterisk anchors media and controls call legs. Vapi hears your microphone and speaks only to you. The backend validates commands and persists state. The purchased number routes to Asterisk for this continuous-session flow.

## Setup

Follow [Linux deployment](docs/deployment.md) for trunk configuration, Vapi setup, and Docker Compose. Deploy to a Linux VPS with a stable public IP. HTTP and ARI bind to localhost; publish the backend through an HTTPS reverse proxy.

For the bundled HTTPS proxy, preflight checks, backups, and restore procedure, follow the [production VPS runbook](docs/production-vps.md).

1. Copy `.env.example` to `.env` and replace every placeholder. Use separate random admin, webhook, and ARI secrets.
2. Copy `deployment/asterisk.example/` to `deployment/asterisk/`, replace its placeholders, and match ARI credentials to `.env`.
3. Configure the Telnyx credential-based SIP connection and outbound voice profile and publish the Vapi assistant/tools.
4. On the VPS run `docker compose -f docker-compose.yml -f compose.production.yml up --build -d`. This includes Caddy for HTTPS. The first Asterisk build takes several minutes.
5. Check `/health/ready`, add contacts, and complete [live acceptance](docs/live-acceptance.md).

Number purchase, Telnyx approvals, DNS/TLS, and Vapi publishing require your accounts. Production use requires live acceptance.

Keep real credentials in your local `.env` and `deployment/asterisk/` files. Git ignores those files, other `.env.*` variants, private keys, credential directories, runtime databases, backups, and deployment archives. Publish only placeholder values in `.env.example` and `deployment/asterisk.example/`. Docker also excludes private configuration and keys from its build context. Never use `git add -f` to include private configuration or runtime data.

Vapi resources can be provisioned with `VAPI_API_KEY`: create a bearer webhook credential matching `VAPI_WEBHOOK_SECRET`, the two tools, the assistant, and a SIP endpoint. Save the assistant ID and SIP URI in `.env`. Configure the SIP number's authentication with a separate `VAPI_SIP_USERNAME` and `VAPI_SIP_PASSWORD`, each 20–40 characters, and copy those values into the `vapi-auth` section of private `pjsip.conf`. The `vapi` endpoint must reference `outbound_auth=vapi-auth` to answer Vapi's SIP authentication challenge. Keep `VAPI_PUBLIC_KEY` for live call controls.

Telnyx resources can be provisioned with a private `TELNYX_API_KEY`: create a credential-based SIP connection and outbound voice profile, attach the profile, and assign `TELNYX_FROM_NUMBER` to the connection. Generate SIP credentials and place them in the private `deployment/asterisk/pjsip.conf`. Set inbound caller/called-number formats to +E.164 and leave the outbound caller-ID override empty so the backend can supply the configured outbound caller ID. The runtime uses SIP credentials and does not require the Telnyx REST API key. Account verification and caller-ID approval must already be complete.

## Voice-only use

Call the Telnyx number from any phone. After the PIN prompt, say the four digits, such as "zero", "four", "two", "seven". Brief pauses are supported: the backend joins digit fragments arriving within five seconds of each other and validates once four digits are collected. Fragments stay in memory only and are discarded on expiry, operator replacement, disconnection, or completion. Use the actual `OPERATOR_PIN` from your private `.env`, including any leading zeros. Do not add "Operator" or "my PIN is". A misheard PIN gets a spoken retry prompt. Five incorrect or invalid attempts, or three minutes without authentication, ends the session. Partial digit fragments do not consume an attempt. Keypad input has no control function.

`BOSS_PERSONAL_NUMBER` is the default outbound caller ID when `OUTBOUND_CALLER_ID` is omitted. It does not restrict who can call in. An explicit `OUTBOUND_CALLER_ID` changes the number shown to recipients; there is no automatic caller-ID fallback after a carrier rejection.

When idle, wait for "Operator ready", then speak naturally. During a destination conversation, say only "Operator" and wait for "Operator ready". The destination is isolated before private conversation opens and may hear the wake word. Once private conversation opens, you do not need to repeat "Operator" or memorize commands.

| Example request | Behavior |
| --- | --- |
| "Can you get the office on the phone?" | Call the saved office contact |
| "Try her at work instead" | Resolve the person from the current private conversation; ask if unclear |
| "I am done talking to them, call Sarah instead" | Confirm, end the current destination, then call saved Sarah while keeping your incoming session connected |
| "Actually, call number one" | Ask before ending an existing destination and calling the saved number 1 contact |
| "Stop trying" or "Hang up on them" | Stop ringing or end only the destination |
| "Who am I connected to?" | Report the destination state |
| "Who can you call?" | Offer up to five saved contact labels; other names remain available by asking |
| "Never mind, put me back" | Cancel the proposed action and resume the held conversation |
| "Please end my entire session" | Ask for confirmation before ending all legs |

The assistant interprets intent and resolves saved contacts. Short answers such as "Mobile, please" can complete a clarification. It asks one short question when a name, pronoun, or desired action is ambiguous. Only saved contacts can be dialed; numbered requests require a matching saved label. Natural wording is interpreted by the configured Vapi model, so recognition and ambiguity handling must be checked on live calls.

Replacing a destination or ending the whole session requires a separate fresh affirmative answer to the server's question. A proposal expires after one minute and is canceled by a new request, private opening, control recovery, or operator replacement. A changed destination invalidates confirmation; a changed or deleted contact also invalidates a proposed switch. Ordinary goodbyes do not end the session. No confirmation automatically repeats or redials a call.

Clarifications, contact discovery, confirmation questions, and failed requests keep private conversation open and preserve the held destination. There is no repeated readiness announcement between follow-up turns. A successful action and its acknowledgement normally close private conversation and resume the destination. During ordinary destination conversation the assistant is muted; greetings such as "hello" do not trigger clarification. "Operator" starts a new private conversation, with the current destination and last requested contact supplied as context.

Server announcements briefly enable the assistant's voice, then mute it again after speech completion, with a ten-second fallback if that event is missing. A persisted 30-second acknowledgement fallback handles missing speech events. After "Operator ready", seven minutes without a fresh private caller reply ends the whole session, including the destination. The reply deadline survives restart; ordinary connected conversations have no seven-minute timer. Conversational tool replies are brief natural sentences; fixed server announcements retain their seven-word limit.

The caller's Asterisk silence generator runs only when the caller is alone in the main bridge, supplying audio timing for private operator speech. It stops when the destination joins or resumes: leaving it active suppresses destination-to-caller audio. Hold, operator setup, and caller recovery synchronize the generator with actual bridge membership. The opt-in `test/asterisk-audio.test.ts` regression sends synthetic RTP tones through real Asterisk and verifies both directions, private isolation, resumption, and caller recovery without dialing external numbers.

Anyone with the correct PIN may use the service from any phone. The spoken PIN authorizes access. The configured PIN is never in the assistant prompt. The Vapi template disables recordings, saved transcripts, and logging. Live transcript webhooks remain necessary. The backend never stores authentication transcript text; Vapi processes speech to provide the service.

## Address book

Use `Authorization: Bearer ADMIN_TOKEN` on every admin request. The production proxy returns 404 for public `/admin` requests. Open an SSH tunnel with `ssh -L 3300:127.0.0.1:3000 USER@VPS`, then use `http://127.0.0.1:3300/admin/contacts` locally.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/admin/contacts` | None |
| PUT | `/admin/contacts/office` | `{"number":"+15550001111"}` |
| DELETE | `/admin/contacts/office` | None |

Labels are lowercased with collapsed whitespace, limited to 80 characters. Numbered labels are canonicalized: `number one` becomes `number 1`, and likewise for single-digit number words. The caller transcript and tool arguments use the same normalization, so "Operator, call number one" can authorize the `number 1` contact without another attempt. All labels use the same lowercase and whitespace normalization. Numbers use E.164. Updates affect future calls; deletion does not hang up an active destination.

The backend waits up to two seconds outside the session lease for a matching final caller transcript, including when a different transcript arrived first. A tool still requires a fresh matching caller transcript, verified PIN, and open private conversation. Each accepted turn is consumed once, even if a tool is resent under a different ID. The Vapi template uses Deepgram numeral conversion, disables smart formatting that can turn digits into times, and uses a 600 ms transcription pause threshold and an 800 ms response wait to tolerate brief pauses. Endpointing waits longer after a PIN prompt or a standalone wake word to reduce cut-off speech.

Unauthenticated admission is limited to two pending sessions and 20 new sessions per 15 minutes, shared across caller numbers. After six failed PIN attempts within 15 minutes, verification is paced to one attempt per 30 seconds across calls and restarts. Callers hear a wait/retry prompt; cooldown submissions do not consume their five attempts. A successful PIN clears the failure/pacing state. These limits control guessing and resource use without a caller-number allowlist.

PIN, retry, and readiness announcements remain pending until the control request succeeds. Failed sends retry every three seconds, bounded by a one-minute delivery deadline and the authentication/reply deadlines. A crash or ambiguous send may repeat a prompt; it cannot repeat an outbound call. Persistent delivery failure ends the session.

## State and recovery

SQLite stores contacts, sessions, attempts, and tool results at `DATABASE_PATH`, which defaults to `./data/switchboard.sqlite`. Startup applies SQL migrations automatically. Run one backend replica against the database.

The primary Asterisk channel identifies a session. Destination/operator IDs are persisted before originate requests. Ambiguous creations reconcile by ID and are never blindly redialed. Switching waits for confirmed termination. Leases serialize mutations; duplicate tools return stored results.

Recovery runs every 15 seconds, with deadline checks every second. ARI reconnects and rescans resources. Commands stay closed during disconnection and require fresh transcripts after recovery. Backend shutdown does not request hangups. Asterisk/VPS failure ends media; recovery marks sessions ended without redialing. Operator replacement preserves caller/destination legs.

Explicit end-session commands and caller disconnect clean up the session. Vapi call-record deletion is never used for live hangup. Unknown creations remain blocked until resolved or session cleanup. Bridge deletion alone does not terminate channels; cleanup explicitly ends owned legs.

Monitor readiness, connection/reconciliation failures, and unresolved attempts. Protect backups containing numbers and SIP binding identities. Ended-data retention defaults to 30 days via `SESSION_RETENTION_DAYS`. Run one backend replica. Compose persists SQLite in the `switchboard-sqlite` volume. Back up the entire database directory while the backend is stopped, including any WAL files.

## Development and tests

Use Node 22.13 or later with the [built-in SQLite driver](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html). Node 22.13 emits an experimental SQLite warning. Scripts do not load `.env` automatically.

```sh
npm ci
npm run check
npm run build
npm test
```

Tests use isolated in-memory SQLite databases and temporary files. No database server or database environment variable is required. Start locally with `node --env-file=.env --import tsx src/main.ts`.

See [verification](docs/verification.md) for automated coverage and opt-in Asterisk tests. Provider tests simulate ARI/Vapi. Live acceptance verifies real audio, SIP identity, caller ID, carrier outcomes, and restarts. Deployment instructions include an opt-in real Asterisk smoke test.

## Troubleshooting

If an incoming call answers without the PIN prompt, inspect the backend logs, Asterisk channel state, SIP registration, and recent Vapi calls before changing audio settings. Avoid SIP packet logging during PIN entry.

If Asterisk logs `There were no auth ids available` for `vapi`, check that the Vapi SIP number has matching digest credentials in `pjsip.conf` and that the endpoint references `vapi-auth`. API keys and the webhook bearer credential do not authenticate SIP. After updating the private configuration, reload it with `docker compose -f docker-compose.yml -f compose.production.yml exec asterisk asterisk -rx 'module reload res_pjsip.so'`.

If Vapi connects but the backend cannot bind its callback, verify that the generated 64-character identity reaches Vapi's customer SIP URI. ARI interprets a bare alphanumeric `callerId` as a display name, which can leave the SIP From user as `asterisk`. The backend uses the explicit `<identity>` caller-ID format so both caller and connected-line identity are set before SIP negotiation. Do not replace this per-session value with a fixed `from_user`.

If destination audio is silent, check bridge membership and that the caller's silence generator stops when the destination joins. Use the opt-in RTP test on disposable Asterisk to check both audio directions, private isolation, and resumption.

If a destination does not ring, check the Telnyx `sip-trunking` detail records for `sip_invite_failure_status`, `telnyx_error_code`, and `hangup_cause`. Verify the outbound profile permits the destination and the configured caller ID is approved. Routing failures are announced as "Call could not connect" before readiness returns. A failed destination does not end the incoming switchboard session.
