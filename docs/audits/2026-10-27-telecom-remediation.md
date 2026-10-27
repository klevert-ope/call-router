# Telecom recovery remediation, 2026-10-27

Implemented the six main findings from the telecom review. Validation below covers local implementation. No provider calls, production deployment, private credential edits, or runtime database changes were made during implementation.

## Changes

1. Cleanup attempts every owned leg, operator snoop/audio bridge, session bridge, and ringback playback independently. Individual failures cannot prevent the other deletions. Terminal channel status is checked before declaring success. Partial cleanup retains its resource identities, a retry deadline, and whether explicit caller termination is required. Recovery does not depend on a successful primary-channel observation before retrying an already-pending cleanup.
2. An operator that has not connected and bound its Vapi controls within one minute is canceled using its persisted channel ID. Replacement requires successful cancellation and confirmed terminal status. Uncertain cancellation remains pending. Definitive setup errors also cancel and verify any allocated channel before replacement. Retired callbacks cannot bind or restore snoop audio; ownership is checked under the session lease. Destination originate uncertainty remains reconciliation-only, without automatic redial.
3. Busy, failure, and connection notices remain persisted until the speech request succeeds. Delivery metadata survives database reopen. Retries wait at least three seconds and any outstanding speech/mute fallback. Notices expire after one minute, and a new destination supersedes an earlier notice. A lost response may repeat harmless speech. Expiry is logged without terminating a healthy conversation.
4. ARI events retain session order while four sessions can run concurrently. The queue accepts at most 512 events. Overflow closes command availability and reconnects. Disconnect discards queued events, and stale scans stop rather than replaying the backlog. Reconciliation scans use bounded batches. One stalled caller setup no longer blocks another caller's disconnect event.
5. Asterisk plays local US ringback after the dial acknowledgement while a destination rings. One deterministic playback ID per session permits reconciliation after a lost response. Ringback stops before private prompts, notices, destination answer audio, cancellation, and cleanup. The caller's silence generator stops while bridge playback supplies audio timing and resumes when appropriate. This selects local ringback for both SIP 180/183 progress; pre-answer carrier announcements are not forwarded.
6. The public Telnyx endpoint templates now set received-RTP inactivity limits of 120 seconds during ordinary media and 600 seconds during SIP hold, with 30-second outbound RTP keepalives. Vapi receive timeouts remain disabled because assistant muting can legitimately stop outgoing audio. Its operator connection and control binding are reconciled separately. See [Asterisk RTP settings](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Module_Configuration/res_pjsip/#rtp_timeout).

Ringback uses ARI tone playback without downloaded sound files. See [Asterisk media playback](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Channels/ARI-and-Channels-Simple-Media-Manipulation/).

## Verification

Windows, Node v26.12.1, existing installed dependencies:

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm run build` | Passed |
| `node --import tsx --test --test-reporter=tap test/*.test.ts` | 126 tests, 124 passed, zero failed/cancelled, two real-Asterisk tests skipped; 13.59 seconds |
| `node scripts/test-asterisk.mjs` without explicit disposable-instance configuration | Rejected with exit 1 as required; this is not a passing media gate |
| `git diff --check` | Passed |

New regressions cover partial teardown, unconfirmed termination, cleanup intent and notice metadata across database reopen, ambiguous/missing operator creation, failed cancellation, definitive setup errors after allocation, retired callbacks, failed/expired/superseded notices, per-session ordering, queue capacity/discard, and ringback privacy and recovery. The simulated WebSocket test stalls one caller's answer request while requiring another caller's cleanup to complete. The opt-in real RTP test now also requires audible ringback, recovery without duplicate playback, and silence after playback stops.

The new persisted fields have schema defaults for existing sessions. No SQL migration or public tool-schema change is required. Callers still authenticate by spoken PIN from any phone; the primary leg, confirmation rules, private isolation, and destination no-redial policy are preserved.

## Rollout and remaining evidence

The Podman Hyper-V machine was stopped and the host had approximately 1.4 GiB free RAM. It was left stopped. Real Asterisk execution, the Node 24 container runtime, carrier SIP progress, audible ringback, and RTP inactivity behaviour were not verified in this run. Local provider simulations do not establish live media correctness.

Copy the RTP settings into the private `telnyx-in` and `telnyx-out` endpoint sections before rollout. Validate carrier silence suppression/DTX, physical mute, private hold, and sustained media loss. A holding bridge does not necessarily place the SIP dialog on hold, so its ordinary 120-second threshold may still apply. Outbound keepalives do not prove received media health. Adjust thresholds from staging evidence.

Run the required disposable-Asterisk gate and [live acceptance](../live-acceptance.md) against the exact deployment artifact before production use. Deploy only the backend for code changes; apply PJSIP configuration in a controlled window. Drain calls before rolling back to an older binary, which does not retain the new cleanup/delivery fields. Provider-compatible TLS/SRTP, spending policies, trunk-aware readiness, and RTP quality telemetry remain separate operational improvements.
