# Call-router testing audit, 2026-10-25

Historical audit snapshot. The four findings below were subsequently addressed locally; see [remediation evidence](2026-10-25-remediation.md). The existing suite passes, but injected announcement failures expose recovery defects that it does not cover. This audit changes no application behavior.

## Scope and evidence

Reviewed TypeScript/Express entry points, SQLite persistence and migrations, switchboard state transitions, ARI events and provider adapters, existing tests, Compose/Docker deployment, Vapi templates, and verification/acceptance documentation. Used the Master Software Testing & Automation skill. This is a local, single-pass audit, not live telephony acceptance or an exhaustive security assessment.

Environment: Windows/PowerShell, Node v26.12.1, npm 12.2.1, installed workspace dependencies. The runtime Dockerfile selects Node 24; Node 24 execution was not verified. The workspace has no Git repository metadata, so no commit ID can be attached.

| Command/check | Outcome |
| --- | --- |
| `npm run check` | Passed |
| `npm run build` | Passed; regenerated `dist/` |
| `npm test` | Exit 0; 66 discovered, 64 passed, 0 failed, 2 skipped; runner duration 10.53 seconds |
| `node --import tsx --test docs/audits/2026-10-25-regressions.test.ts` | Exit 1; two tests fail at the intended delivery-recovery assertions |
| Local cross-call PIN-budget probe | Two distinct sessions accepted six incorrect complete PIN guesses total; each ended after its own three failures; `pin_attempts` remained empty |
| Local failed-resume probe | A failed mute during resume recovered on the next reconciliation after the provider recovered; excluded from findings |
| Real Asterisk, RTP, carrier/Vapi acceptance, load, soak, Linux deployment | Not run |

The reproduction tests use isolated in-memory SQLite and the existing fake external adapters. They inject one rejected announcement, restore that adapter, and assert eventual recovery. They use no external credentials, place no calls, and close their databases in `finally`. They are outside the default test glob because they intentionally expose unresolved defects. Promote them into the blocking suite when implementing the fix. The initial reproduction-file invocation had an import path error; the recorded two failures above are from the corrected file and both reach the intended assertions.

## 1. P1: Undelivered prompts are recorded as completed and cannot recover

Sources: `src/switchboard.ts:270-275`, `src/switchboard.ts:286-289`, and the arming guard at line 257.

PIN setup saves `promptedGeneration` before sending the authentication context and PIN prompt. If either request fails, later reconciliation sees that generation as already prompted and never sends the prompt. Restarting the backend preserves the marker. The caller receives silence until the authentication deadline disconnects them unless they independently know to speak the PIN.

The verified path similarly persists `commandMode='open'` before sending "Operator ready." A rejected readiness announcement leaves an idle session open with a null deadline. Ordinary reconciliation never re-enters `arm`, so a caller following the documented wait-for-readiness flow can wait indefinitely. A subsequent successful backend restart can re-arm this verified path; ordinary recovery does not.

Both variants are reproduced by the saved tests. The failure is at the application/provider boundary, independent of carrier audio. No live provider delivery failure was induced.

Remediation: represent pending announcements durably and distinguish queued, sent, and acknowledged delivery. Retry definitive pre-delivery failures and reconcile ambiguous outcomes within bounded deadlines. Preserve authorization and destination isolation while doing so. Simply moving the database write after `say` leaves an ambiguous-delivery crash window and needs an explicit duplicate/delivery policy.

Required regression oracle: reject context and speech independently, recover the provider, then reconcile and restart. The caller must receive the required prompt or a bounded explicit failure. Authorization must remain closed where required and destinations must remain isolated. Test ambiguous delivery separately from definite rejection. Owner: backend maintainer.

## 2. P1: The four-digit PIN has no attempt budget across calls

Sources: `src/switchboard.ts:15`, `src/switchboard.ts:111-133`, `src/asterisk.ts:111-121`, and `src/store.ts:61`.

Each new incoming channel starts with zero authentication attempts. Three failures terminate only that session. A new call receives a fresh budget, and concurrent sessions have independent budgets. Entry deliberately accepts callers other than the personal number. The only runtime use of `pin_attempts` is deleting expired rows; the table does not enforce any budget.

A local probe submitted three incorrect PINs in each of two fresh sessions. Both sessions accepted their three guesses and then ended, with no persistent budget record. This establishes the application behavior, not a successful PIN compromise or a measurement of live carrier throughput. Provider-level controls outside this checkout were not inspected.

Impact: repeated calls defeat any interpretation of the three-attempt rule as a bound on guessing the shared four-digit secret. Each unauthenticated call can also allocate an operator leg before verification.

Remediation: define and enforce durable cross-session abuse budgets and admission/concurrency limits before allocating expensive operator resources. Caller identity alone is insufficient for a shared-secret budget; account for callers changing identity and for denial-of-service against legitimate callers. Keep the documented any-phone entry behavior when selecting the policy.

Required regression oracle: after the configured budget is exhausted, fresh and simultaneous calls cannot reset it, and restarting the backend does not reset it. Verify cooldown expiry and legitimate recovery with an injected clock. Owner: backend/security maintainer. No live brute-force testing is needed.

## 3. P2: The RTP test cannot establish the source of received audio

Sources: `test/asterisk-audio.test.ts:44-46`, `:54-58`, `:76-89`.

The test sends distinct 440, 660, and 880 Hz tones, but reduces every received packet to total RMS energy. All tones have the same amplitude. Assertions described as receiving the other peer's tone accept any sufficiently loud signal, including self audio or the wrong peer. The test also checks caller-only snoop behavior only while the destination is held, when the destination is silent anyway. It does not measure destination-to-operator leakage during an ordinary connected conversation.

This is a reviewed weakness in the oracle, not evidence that production currently leaks audio. The real RTP test was skipped during this audit.

Remediation: measure expected and forbidden tone frequencies at each receiver using correlation or spectral analysis. Add a connected three-leg phase that requires caller ingress at the operator and rejects destination audio there. During private hold, reject caller and operator tones at the destination. Add negative controls for loopback, swapped routing, and `spy=both`; each must make the test fail. Owner: test/media maintainer.

## 4. P2: Real-Asterisk test cleanup stops after its first teardown error

Sources: `test/asterisk-audio.test.ts:90-93`, `test/asterisk-live.test.ts:75-79`.

The audio test awaits each channel deletion before closing its UDP socket. If the first deletion rejects, later channel deletions, socket closure, bridge deletion, WebSocket termination, and database closure are skipped. Its initial WebSocket connection also occurs before the cleanup `try`. The live test protects its WebSocket/database closure with nested `finally`, but a failed channel deletion still prevents subsequent channel and bridge cleanup.

These are the failure paths exercised by resilience testing, so teardown must tolerate unavailable ARI. Leaked channels/bridges can affect later runs, and open sockets can prevent runner termination. This finding is based on control-flow review; no real Asterisk cleanup failure was injected.

Remediation: register cleanup as each resource is acquired. Attempt every remote deletion independently, close every local resource unconditionally, and report aggregate cleanup errors after all attempts. Use a bounded second cleanup pass when ARI recovers. Owner: test maintainer.

Required regression oracle: inject rejection of the first deletion, verify that all later deletions were attempted, all local sockets/database handles closed, and the test reports failure within its deadline.

## Risk and coverage map

| Risk | Existing evidence | Missing check and proposed gate | Owner |
| --- | --- | --- | --- |
| Unauthorized commands or duplicate dialing | Passing domain, voice, switchboard, HTTP, and deduplication tests | Cross-session PIN budgets; blocking local regression gate | Backend/security |
| Silent or stuck call after control outage | Recovery tests cover several state transitions | Pending announcement delivery and context/speech rejection matrix; blocking regression gate | Backend |
| Private speech reaches wrong participant | Mocked ARI argument checks; optional real RTP test | Frequency-specific positive/negative controls, then real Asterisk lane before release | Media/test |
| Test faults leave live resources | Cleanup exists but short-circuits | Teardown failure injection and bounded resource inventory check | Test |
| Persistence and migrations | Passing real SQLite tests, file reopen, separate-connection fencing, legacy data cases | Abrupt process kill with file-backed DB, supported runtime execution | Backend/test |
| Backend reconnect preserves real media | Mocked event test; real test manually reconnects a raw WebSocket | Disposable Asterisk test using actual `AsteriskEvents` lifecycle and backend restart | Backend/media |
| Provider interoperability and call quality | Acceptance procedure exists | Execute and record caller ID, bidirectional audio, privacy, long sessions, carrier outcomes | Release operator |
| Release accidentally omits real tests | Default command exits successfully with both real tests skipped | Separate release command requiring enabled real tests and rejecting missing/empty/skipped required results | Release/CI |

No CI workflow was found in this workspace. `npm test` is a useful component gate, but does not enforce the real-Asterisk release lane or live acceptance. Keep local checks fast; make required release evidence explicit rather than silently promoting a component-suite pass to deployment readiness. Browser tests are not applicable to the current backend-only product.

Recommended order: fix announcement recovery and define cross-call authentication limits, strengthen the media oracle and cleanup, then run the disposable real-Asterisk lane and documented live acceptance on the exact deployment artifact. No containers or production resources were started or modified by this audit.
