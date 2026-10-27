# Linux VPS deployment

## Host and network

Use Docker Engine and Compose v2 on a Linux VPS with a stable public IPv4 address and HTTPS DNS. Compose uses host networking for Asterisk/backend. SQLite lives at `/app/data/switchboard.sqlite` in the Compose volume declared as `switchboard-sqlite`. Reserve backend port 3000, ARI port 8088, SIP 5060/UDP, and RTP 10000-10199/UDP.

Proxy public HTTPS to `http://127.0.0.1:3000`. Preserve Authorization and JSON bodies. Keep ARI private and restrict access to the SQLite volume. Allow inbound SIP only from current Telnyx signaling networks. Allow RTP from Telnyx/Vapi media networks and outbound SIP/RTP to both services. Use the current regional network lists:

- https://support.telnyx.com/en/articles/1130676-configuring-an-asterisk-credentials-trunk
- https://docs.vapi.ai/advanced/sip/sip-networking

If behind NAT, add `external_media_address`, `external_signaling_address`, and appropriate `local_net` entries to the PJSIP transport, and forward SIP/RTP ports. Use the same Vapi region for SIP URI and organization.

The example uses UDP and G.711 ulaw/alaw. HTTPS does not encrypt SIP/RTP. Configure compatible SIP TLS/SRTP on both provider connections if required.

The Telnyx endpoint templates set `rtp_timeout=120`, `rtp_timeout_hold=600`, and `rtp_keepalive=30`. These detect missing received media, rather than silence in speech, and keep the outbound NAT binding active. Copy these settings into both private `telnyx-in` and `telnyx-out` endpoint sections before rollout. Test continuous RTP, carrier silence suppression/DTX, physical mute, and hold before accepting these thresholds. Asterisk holding bridges do not necessarily put the SIP dialog into remote hold, so the 120-second limit can still apply there. Vapi receive timeouts stay disabled because a muted assistant can legitimately send no audio; its call and control binding are monitored separately. See [Asterisk RTP settings](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Module_Configuration/res_pjsip/#rtp_timeout).

## Asterisk

Copy `deployment/asterisk.example` to `deployment/asterisk`. Replace all `REPLACE_` placeholders. The latter directory is ignored by Git and the backend Docker build.

- Match `ari.conf` username/password to `.env`. Use a random 64-character hexadecimal password. ARI binds to localhost.
- In `pjsip.conf`, enter the Telnyx SIP connection credentials and all current inbound signaling addresses in separate `match=` lines. Leave outbound `from_user` unset so the backend supplies the configured caller ID: `OUTBOUND_CALLER_ID`, or `BOSS_PERSONAL_NUMBER` when the override is omitted.
- Keep the Vapi endpoint's `from_user` unset so the random per-generation identity reaches Vapi. Keep `direct_media=no` on every endpoint.
- `from-telnyx` enters `Stasis(switchboard)` and has no outbound route. The `reject` context rejects unsolicited Vapi-side requests.
- Keep default endpoint/app names unless you change both Asterisk configuration and `.env`.

The container runs as UID/GID 10001. Give it read access to config files. Protect the directory with mode 750 and files with mode 640 and an appropriate owner/group. Do not enable SIP packet logging while speaking a PIN. The sample logs warnings/errors and performs no recordings.

The image builds Asterisk 22.8.0 from the official archive with bundled PJSIP. Maintain it by selecting a tested supported 22.x version through the Dockerfile build argument. Retest audio behavior after upgrades.

## Telnyx SIP connection

1. Buy or select a voice-capable Telnyx number. In Mission Control create a **credential-based SIP connection** and copy its SIP username/password. Assign the number to this connection, rather than to a TeXML application or a direct Vapi import.
2. Create or select an Outbound Voice Profile, allow the intended countries/destinations, and attach the SIP connection. Verify the desired outbound caller ID under Numbers / Verified Numbers, or use a Telnyx number owned by the account. The backend defaults to `BOSS_PERSONAL_NUMBER`; set `OUTBOUND_CALLER_ID` explicitly to use another approved number. Leave the connection's ANI override empty. Inbound callers may use any number and must pass the spoken PIN.
3. In `pjsip.conf`, replace both SIP username placeholders and the SIP password. Set the registration `contact_user` to the purchased number. Use the regional Telnyx SIP proxy consistently in the registration, outbound AoR, and `from_domain` settings. The example uses `sip.telnyx.com`.
4. Set the connection's inbound called-number format to +E.164 and ensure the Request-URI contains the assigned DID, not the SIP username. Set `TELNYX_FROM_NUMBER` to that same DID. The backend also accepts digits-only E.164 by adding the leading plus.
5. Replace the inbound identify placeholder with every current signaling IP/CIDR for your Telnyx region, and restrict the firewall accordingly. Permit the provider's current RTP networks.
6. Reload/restart Asterisk after draining calls. Check `pjsip show registrations`, `pjsip show identifies`, and the Telnyx connection diagnostics before acceptance calls.

The backend requires no Telnyx REST API key, account SID, Ed25519 webhook public key, or TeXML callback URLs in this topology. Asterisk authenticates to Telnyx with SIP credentials; Vapi webhooks still use their separate bearer credential. A rejected caller ID must fail without automatically retrying with a different number. Choose a different `OUTBOUND_CALLER_ID` only as an explicit configuration change.

Official setup reference: https://support.telnyx.com/en/articles/1130676-configuring-an-asterisk-credentials-trunk

## Vapi

1. Create a Custom Credential with a Bearer Token matching `VAPI_WEBHOOK_SECRET`. Use the Authorization header and Bearer prefix.
2. Replace host/credential placeholders in `config/vapi-tools.json`, create each tool separately, and retain returned IDs.
3. Replace host/credential/tool placeholders in `config/vapi-assistant.json`, create/publish the assistant, and save its ID as `VAPI_ASSISTANT_ID`. Verify model, voice, and transcriber availability in your account.
4. Create a SIP phone number with provider `vapi`, your saved assistant ID, and `sip:username@sip.vapi.ai`. EU organizations use `sip:username@sip.eu.vapi.ai`. Set that URI in `.env`. Configure the SIP number's `authentication` with a separate random username/password, each 20–40 characters. Save them as `VAPI_SIP_USERNAME` / `VAPI_SIP_PASSWORD` and replace the matching placeholders in `pjsip.conf`'s `vapi-auth` section. Preserve `outbound_auth=vapi-auth` on the `vapi` endpoint. These digest credentials answer Vapi's SIP challenge; API keys cannot replace them.
5. Set the organization's private/public keys in `.env`. Private access verifies metadata/assistant identity; the public key authenticates live controls.
6. Preserve transcript/speech-update webhooks, silent first-message behavior, disabled artifacts, and empty automatic end-call phrases. Do not attach generic transfer/endCall tools.

Route the Telnyx number to Asterisk. Importing it directly into Vapi is unnecessary for this topology. The operator's random 256-bit SIP From username must appear in Vapi customer metadata. Identity rewriting blocks release.

## Start the service

Complete `.env` and private `deployment/asterisk` configuration before starting. Use separate random admin, webhook, and ARI secrets. Startup applies the SQL migrations in `migrations/` to the configured SQLite file.

Compose sets `DATABASE_PATH=/app/data/switchboard.sqlite` and mounts a writable named volume there. The image creates that directory owned by the Node user. Keep the database on a local filesystem and run one backend replica. For backups, stop the backend and copy the whole data directory, including any `-wal` and `-shm` files, before restarting it.

On the Linux VPS:

```sh
docker compose config --quiet
docker compose up --build -d
docker compose exec asterisk asterisk -rx 'core show version'
docker compose exec asterisk asterisk -rx 'pjsip show endpoints'
docker compose exec asterisk asterisk -rx 'pjsip show identifies'
```

Check public `/health/ready`, add contacts, and complete live acceptance. The first source build takes several minutes. `docker compose down` preserves volumes; `down -v` deletes them. Restart the backend separately to preserve media. Drain before Asterisk upgrades/restarts.

Before updates, drain calls and back up the database and configuration. To roll back, stop the backend and restore the matching saved release, configuration, and database. Run one backend replica.

## Real Asterisk tests

On disposable Linux Asterisk, add `deployment/asterisk-test/extensions.conf` to its dialplan and reload it. Keep that test context out of production. It has no external dialing route.

With normal ARI variables in `.env`:

```sh
ASTERISK_TEST_ENABLED=1 node --env-file=.env --import tsx --test test/asterisk-live.test.ts
```

The test opens its own Stasis app, creates local autoanswer channels, verifies bridge/hold/snoop resources, reconnects the event socket, and cleans up its own resources. It requires no paid carrier call. It does not prove actual directional audio; use live acceptance for that.

The RTP test uses local external-media channels to send synthetic tones and verify both audio directions, private hold isolation, resumption, and caller recovery. Run it against disposable Asterisk with ARI and RTP accessible on localhost:

```sh
ASTERISK_TEST_ENABLED=1 node --env-file=.env --import tsx --test test/asterisk-audio.test.ts
```

After setting the enable flag and disposable ARI credentials, run `npm run test:asterisk` to require both tests and reject skips. Both opt-in tests use the same enable flag. Neither places external calls or verifies Telnyx/Vapi interoperability. See [live acceptance](live-acceptance.md) for provider and phone checks.

When updating this release, publish both revised `config/vapi-tools.json` tool definitions and the `config/vapi-assistant.json` conversation prompt to the existing Vapi resources, preserving their real IDs, webhook credential and server URL. The manage tool now includes clarify, contacts, resume, cancel, and confirm actions. Update both tools as well as the assistant; the old exact-command prompt cannot provide the new conversation flow. Deploy the backend together with that assistant update, then perform live acceptance. Editing the local template alone does not change Vapi.
