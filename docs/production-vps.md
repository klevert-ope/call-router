# Production VPS runbook

This deployment runs one backend, SQLite, Asterisk, and Caddy on one Linux VPS. It is not highly available: VPS or Asterisk failure ends active calls. Complete [provider configuration](deployment.md) before opening traffic, then [live acceptance](live-acceptance.md) before relying on the service.

## Server handoff

Provide the VPS public IP, Linux distribution, SSH username/access method, and intended HTTPS hostname. Keep credentials out of source control. Select a host with enough memory for the Asterisk source build; final sizing must be measured with the expected simultaneous calls. Use a stable public IPv4 address and local persistent disk, with Docker Engine and Compose v2 installed and enabled at boot. Do not run additional backend replicas.

Point DNS to the VPS. If publishing an AAAA record, IPv6 must also reach this server. Allow SSH from your administration network, TCP 80/443 publicly, UDP 5060 only from current Telnyx signaling networks, and UDP 10000–10199 from the current Telnyx/Vapi media networks. Match cloud and host firewall rules. Keep TCP 3000, 8088, and 2019 private. Preserve SSH access while changing firewall rules. Host networking exposes Asterisk directly to the host firewall.

## Configure and launch

Upload the project to a stable location such as `/opt/call-router`, excluding node_modules, dist, local databases, logs, and editor folders. Use that same location and Compose project name for future releases so existing volumes are reused. Save a protected copy of every deployed release for rollback.

```sh
cd /opt/call-router
cp .env.example .env
cp -R deployment/asterisk.example deployment/asterisk
chmod 600 .env
sudo chown -R root:10001 deployment/asterisk
sudo chmod 750 deployment/asterisk
sudo chmod 640 deployment/asterisk/*.conf
```

Edit `.env` and the private Asterisk configuration. Generate each secret separately using `openssl rand -hex 32`. Set a personal PIN and real telephone numbers, replace every placeholder, and match ARI credentials in both files. Set `PUBLIC_BASE_URL` to the HTTPS hostname. See [deployment instructions](deployment.md) for Telnyx and Vapi account steps. The preflight requires read access to the private Asterisk files; run it as the deployment administrator.

Use Node 22.13 or later on the host for checks, or perform these checks in a separate build environment with the private configuration available:

```sh
npm ci
npm run check
npm run build
npm test
node --env-file=.env deployment/preflight.mjs
docker compose -f docker-compose.yml -f compose.production.yml config --quiet
docker compose -f docker-compose.yml -f compose.production.yml build --pull
docker compose -f docker-compose.yml -f compose.production.yml up -d
docker compose -f docker-compose.yml -f compose.production.yml ps
curl --fail https://YOUR_HOSTNAME/health/ready
```

The source build may take several minutes. Caddy obtains and renews certificates using the hostname and reachable ports 80/443; its certificate state persists in named volumes. It proxies to the backend on localhost. See [Caddy HTTPS](https://caddyserver.com/docs/automatic-https) and [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) documentation. An existing HTTPS proxy can be used instead by omitting the production overlay and configuring equivalent routing.

The proxy returns 404 for `/admin` routes. Use an SSH tunnel (`ssh -L 3300:127.0.0.1:3000 USER@VPS`) and access the admin API at `http://127.0.0.1:3300` using its bearer token. Public Vapi webhooks remain available at `/webhook/vapi-switchboard` and require their own bearer token.

## Backups and restore

After draining calls, run:

```sh
bash deployment/backup.sh /srv/private-switchboard-backups
```

The script stops only the backend, copies the complete SQLite directory including WAL files, and restarts the backend on exit. Asterisk media stays up, but commands are unavailable during the backup. Only treat a zero exit status as success. Schedule backups for quiet periods and copy them to encrypted off-server storage. Back up `.env`, private Asterisk configuration, and release files separately with restrictive permissions. Do not place backups inside the image build context. The database contains telephone numbers and identities.

To restore, first drain calls and save a fresh backup. Stop the backend using the same two Compose files. Obtain its stopped container ID with `docker compose -f docker-compose.yml -f compose.production.yml ps -aq switchboard`. Copy the existing `/app/data/.` to a separate safety directory. With the backend stopped, clear only the contents of its `/app/data` volume, then copy the complete selected backup directory into `/app/data/` using `docker cp BACKUP_DIRECTORY/. CONTAINER_ID:/app/data/`. Restore ownership to UID/GID 1000 using a one-off `docker compose ... run --rm --no-deps --user root --entrypoint chown switchboard -R 1000:1000 /app/data`. Start the backend and verify readiness, contacts, and recovery. Do not overlay a backup on existing SQLite WAL files. Restoring an old backup can revert contacts and session history; perform a restore drill before release.

## Updates and operations

Always include both Compose files for production operations. Back up before updates. For backend-only changes, build `switchboard`, then run `up -d --no-deps switchboard`; drain calls for schema changes. Asterisk changes and full stack restarts require draining calls. To roll back, stop the backend and restore the matching previous image/release and database together. Do not run old and new workers simultaneously. Never use `down -v` on this deployment.

Monitor public `/health/ready` externally, container health/restarts, disk usage, backup age, and ARI/reconciliation errors. Health checks report failures; they do not automatically restart unhealthy running containers. Docker restarts exited containers according to the restart policy. Container logs rotate at 10 MiB with three files per service using [Docker logging options](https://docs.docker.com/engine/logging/configure/). Keep provider packet logging disabled during real PIN entry.

Images currently use version tags. Record deployed image IDs/digests and retain the previous images before pulling updates. Review Node, Caddy, Debian, and Asterisk security updates and retest before rollout. Verify TLS, firewall rules, SIP registration, directional audio, caller ID, authentication, and restart/recovery behavior through [live acceptance](live-acceptance.md).
