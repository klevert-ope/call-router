# Call-router remediation, 2026-10-25

Implemented the four local audit fixes and the requested seven-minute reply timeout. Any phone may authenticate with the PIN. No inbound owner-number restriction was added.

## Resulting behavior

- Five failed or invalid complete PIN attempts are allowed per call within a three-minute authentication window. Partial digit fragments do not consume attempts. Mispronunciation produces a retry prompt, and a correct fifth attempt succeeds.
- After six failed PIN attempts in a fixed 15-minute window across calls, verification is paced to one attempt per 30 seconds. The counter and pacing survive database reopen. Cooldown submissions receive a wait/retry prompt and do not consume the caller's five attempts. A successful PIN clears the failure/pacing state. There is no long shared PIN lockout.
- Admission allows two pending authentication sessions and 20 new sessions per 15 minutes. Admission is transactional and happens before allocating the operator. These service-wide limits do not depend on caller number.
- PIN, PIN-retry, and readiness announcements remain pending until their provider request succeeds. Transient failures retry after three seconds. Persistent delivery failure ends the call after one minute, subject to earlier authentication/reply expiry. A crash or ambiguous provider response can repeat a prompt, but cannot repeat an outbound call.
- After readiness, seven minutes without a fresh addressed reply ends the entire session. Recovery preserves the existing deadline. A fresh addressed reply renews it; ordinary conversation with a destination has no such timer. Successful command acknowledgements retain their separate 30-second fallback.
- Failed or unclear commands retain private isolation and reopen readiness for a fresh attempt. Unknown labels and paraphrased/mismatched tool arguments cannot authorize a different destination. Tools wait up to two seconds outside the lease for the matching final transcript, even if a different transcript arrived first.
- The local Vapi assistant template now uses 600 ms transcription endpointing and an 800 ms response wait. The live assistant was not modified. Deepgram documents endpointing as the silence interval before transcript finalization; increasing it is a tradeoff between brief-pause tolerance and latency, not a guarantee of recognition accuracy. See [Deepgram endpointing](https://developers.deepgram.com/docs/endpointing/) and [Vapi voice pipeline configuration](https://docs.vapi.ai/customization/voice-pipeline-configuration).
- Real RTP assertions identify each tone and reject self audio, the wrong peer, and destination audio at the operator. Both Asterisk test teardowns attempt all deletions and close local resources after failures. The audio test also protects setup failures and parses RTP header offsets.
- `npm run test:asterisk` requires explicit disposable ARI configuration and exactly two passing real-test results, with no skips or missing reports. This is a release-gate command; the ordinary component suite remains usable without Asterisk.

## Verification

Windows, Node v26.12.1, npm 12.2.1, existing installed dependencies:

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm run build` | Passed; generated `dist/` updated |
| `npm test` | 84 discovered, 82 passed, zero failed/cancelled, two real-Asterisk tests skipped; 13.72 seconds |
| `node --check scripts/test-asterisk.mjs` | Passed |
| `node scripts/test-asterisk.mjs` without explicit configuration | Correctly rejected with exit 1 before starting tests |

New regressions cover delivery/context failures, recovery after restart, permanent delivery failure, failed retry-prompt delivery, replay deduplication, PIN pacing after file reopen, admission caps, successful fifth PIN attempt, exact seven-minute boundary, deadline preservation after restart, ordinary conversation exclusion, corrected commands while a destination stays held, and delayed matching transcript delivery. Media negative controls reject loopback, wrong-peer tone, and a simulated `spy=both` mix. Cleanup failure injection verifies all later cleanup actions still run.

No external calls, deployed configuration changes, or production data changes occurred. Real Asterisk execution was not attempted: `podman-tasks` was stopped and the host reported about 1.1 GiB available RAM. The VM was left stopped. Actual SIP/RTP privacy, recognition quality, carrier behavior, deployed Node 24 runtime, and provider interoperability remain unverified.

Before release, publish the updated assistant template while preserving the existing resource IDs and credentials, deploy the backend, run the mandatory disposable-Asterisk gate, and complete the updated live acceptance procedure. The historical audit is preserved in `2026-10-25-testing-audit.md`; its original two reproductions now run as part of `test/announcement.test.ts`.
