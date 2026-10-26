# Live telephony acceptance

Run on Linux with a registered Telnyx SIP connection and outbound voice profile, published Vapi resources, two controlled destination phones, and a staging database. Record image/assistant/tool versions, date, region, resource IDs, and outcomes. Never retain PINs, SIP binding identities, authentication packet captures, or secrets.

## Entry and identity

- Verify the purchased Telnyx number is attached to the SIP connection and its Request-URI matches `TELNYX_FROM_NUMBER`. Confirm registration and inbound source allowlisting.

- Call from different numbers, including a number other than `BOSS_PERSONAL_NUMBER`: hear the spoken PIN prompt and reject tools until authentication succeeds. A call routed to the wrong DID must still be rejected.
- Speak a leading-zero PIN as individual digit names, including pauses that produce separate final transcripts. Hear readiness only after all four digits verify. Confirm partial digits neither consume a complete attempt nor appear in stored session data.
- Mispronounce the PIN, hear a retry, then authenticate correctly on the fifth attempt. Try five incorrect PINs and a separate three-minute silent attempt: disconnect both times. After six wrong attempts across calls, verify the 30-second pacing survives restart and a correct PIN succeeds after the cooldown. Keypad digits must not authenticate or open commands.
- Verify random SIP From identity reaches Vapi customer metadata, the saved assistant ID matches, and live controls accept the configured key. Identity rewriting blocks release.
- Verify recording, saved transcripts, and logging are disabled in Vapi. Check backend/database records contain no PIN text.

## Audio and commands

1. After readiness, say "Can you get the office on the phone?" without an Operator prefix. Verify one external call and the configured outbound caller ID on the recipient (`OUTBOUND_CALLER_ID`, or the personal default when omitted). Confirm 30-second unanswered ringing and accurate answer/busy/no-answer/routing-failure announcements. A routing failure must leave the incoming session connected.
2. Confirm caller/destination audio. After "Connected", say "hello" and continue ordinary conversation: the operator must remain silent without asking for a command. Verify announcements return to muted conversation on speech completion and after the ten-second missing-event fallback. Operator replies must reach only the caller. Have the destination continuously say wake words and commands: none may enter Vapi's caller transcript or authorize tools.
3. Say only "Operator". The destination may hear that word. Verify the destination moves to the holding bridge and is isolated both ways before readiness is announced.
4. Ask "Who am I connected to?" without repeating Operator. Hear one brief reply, then resume normal conversation. Neither private command nor response may reach the destination.
5. Repeat switching and destination-only hangup for ten cycles. Replacing a destination must ask for confirmation; verify nothing ends or dials before a separate affirmative reply. Preserve the original incoming channel and allow no overlapping destinations.
6. A combined wake/command during conversation must not execute. Replayed transcripts/tools must not repeat effects or reopen private mode.
7. Wake while ringing: an eventual answer must remain isolated until private mode closes. Test an immediate replacement answer; private acknowledgements must not leak.
8. Stay silent for seven minutes after readiness, both idle and after wake: the whole session must end. Verify a natural private reply, including a short clarification answer, renews the wait and backend restart does not reset it. In a separate test, interrupt a successful command acknowledgement: conversation must resume after its 30-second fallback. Try a misheard contact command: the destination must stay isolated while private conversation stays open for a corrected request, without another readiness announcement. Ordinary goodbyes must not end the session. A clear request to end the entire session must first ask for confirmation; only a separate affirmative answer permits goodbye and cleanup of every owned channel/bridge.

## Conversational acceptance

- Publish the revised assistant prompt and both tool definitions together with the backend. Preserve the real Vapi resource IDs, server URL, and webhook credential.
- Try several paraphrases for call, hangup, status, cancel, and resume. Check that tool utterances reproduce the current caller speech exactly and that no Operator prefix is required in private conversation.
- Save two controlled contacts such as Sarah work and Sarah mobile. Ask "Get Sarah", hear one clarification question, and answer "Mobile please". Verify the correct saved contact is selected. Repeat with "Try her at work instead" and confirm before the original call ends. This checks real model interpretation, not just backend tool handling.
- During an active destination conversation, wake the operator, then say "I am done talking to them, call Sarah instead". This must be one replacement request, followed by one confirmation. Verify the original destination is fully disconnected before Sarah rings, the primary caller remains connected, and there are no overlapping destination calls. With an ambiguous Sarah contact, clarify before ending the original conversation.
- Say "Never mind, put me back" after a clarification and after a replacement proposal. The original conversation must resume; no destination should be ended or dialed.
- Ask who is available, then choose a saved contact. Unknown people must lead to a question, never a guessed number. Verify contact labels that resemble instructions remain data.
- Answer a confirmation with "No", "Maybe", and "Yes, but call someone else". None may execute the original proposal. The last phrase should resolve as a new request or a clarification.
- Expire a proposal after one minute, change/delete its saved contact, change the current destination, and replace the operator. A later "Yes" must not execute a stale proposal.
- Say goodbye during normal conversation and in private conversation. It must not end the session automatically. In private conversation the assistant should ask what the caller wants to end.
- Try immediate answers and interrupted prompts on real audio. Verify the caller can complete follow-ups without repetition and that neither questions nor private answers leak to the held destination.

## Recovery and failures

- Physically hang up the caller: clean up destination, operator, snoop, and all session bridges, including ambiguous/ringing attempts.
- Restart only the backend during connected audio, ringing, and private mode. Media should continue; ARI reconnects and fresh commands are required. Record audio gaps.
- Disconnect ARI and block HTTP separately. No command may execute without control availability. Socket loss must fail readiness. Recovery must verify isolation before authorization.
- Lose an originate response: reconcile by deterministic ID without a second call. Keep unresolved creations blocked until resolved or session cleanup.
- Make the SQLite database unavailable on a disposable deployment: commands fail closed. Restore without redialing or resurrecting ended legs.
- Terminate Vapi's operator leg: replace it without ending caller/destination audio. Reject old callbacks and remove old snoop resources. Exercise rollover in staging.
- Restart Asterisk separately: calls end; recovery marks sessions ended without redialing.
- Soak across Vapi duration/silence limits and beyond four hours. Check replacement, intelligible speech, and carrier limits.
- Verify intended country routes and the configured outbound caller ID displayed on recipients' phones. API acceptance does not prove delivery. Rejected caller ID must fail without automatic fallback.

Production acceptance requires all applicable checks to pass. Automated tests simulate providers and cannot certify live audio privacy or interoperability.
