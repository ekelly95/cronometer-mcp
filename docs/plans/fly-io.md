# Plan: an always-on remote connector on Fly.io

Status: **planned, not started.**

## Why

The remote connector (`docs/REMOTE.md`) runs on the owner's own computer behind Tailscale
Funnel, so it is only reachable while that computer is on and awake. Hosting the same
server on Fly.io makes it reachable whenever claude.ai or a phone asks. Fly machines can
stop when idle and start on the next request, which should keep the cost to cents a month
for one person.

The trade-offs are covered in "What changes for the owner" below.

## What already fits

- `dist/http/main.js` is configured entirely from the environment: `MCP_PUBLIC_URL`,
  `MCP_STATE_DIR`, `MCP_OWNER_PASSWORD_HASH`, `MCP_LISTEN_PORT`, `MCP_LOG_FILE`, and the
  `CRONOMETER_*` variables.
- OAuth state lives in files under `MCP_STATE_DIR` (`src/http/oauth/store.ts`). The
  Cronometer session caches live under `CRONOMETER_DATA_DIR`. Both can sit on one Fly
  volume and survive restarts.
- The app is a web-standard `fetch` handler (`src/http/app.ts`) served through
  `node-adapter.ts`, with no platform dependency beyond Node.

## Code changes

1. **Listen address.** `src/http/start.ts` binds `127.0.0.1` only, but Fly's proxy
   connects over the machine's own network interface.
   - Add an opt-in `MCP_LISTEN_HOST`, defaulting to `127.0.0.1`. On Fly it is set to
     `0.0.0.0`, or to `::` if Fly routes over IPv6.
   - The `Host` header check stays as it is: Fly passes the public hostname through.
   - Keep the "loopback only" claim in `docs/REMOTE.md` true for the local setup, and
     describe the hosted exception.
2. **Client addresses behind the proxy.** Check whether anything uses the peer address,
   such as logging or the lockout. Behind Fly every request comes from the proxy; take the
   address from `Fly-Client-IP` only when an explicit opt-in is set, never by default.
3. **Lockout across restarts.** The five-attempts-in-fifteen-minutes lockout may be held
   only in memory. On a machine that stops when idle, a restart would clear it. Repeated
   guessing keeps the machine awake, so the window is narrow. Still: persist the attempt
   counter in the state directory, or confirm it already is.
4. **Tests** for the new listen-host option and any proxy-address handling.

## New files

- **`Dockerfile`:**
  - two stages: `npm ci` plus `npm run build`, then a `node:24-slim` runtime holding
    `dist/` and the production `node_modules`;
  - runs as a non-root user;
  - `CMD ["node", "dist/http/main.js"]`.
- **`.dockerignore`.**
- **`fly.toml`:**
  - one app;
  - `[http_service]` with `internal_port = 8787`, `force_https = true`,
    `auto_stop_machines = "stop"`, `auto_start_machines = true`, `min_machines_running = 0`;
  - a `[mounts]` volume at `/data`;
  - `MCP_STATE_DIR=/data/oauth`, `CRONOMETER_DATA_DIR=/data/cronometer`,
    `MCP_LISTEN_HOST=0.0.0.0`, `CRONOMETER_LIVE_ENABLED=1`;
  - the smallest shared-CPU machine. scrypt needs 32 MiB per sign-in, so 256 MB is enough.
- **One machine only.** The OAuth store and session caches are single-writer files.
  Document that the app must never be scaled past one machine, and set it with
  `fly scale count 1`.
- **`.github/workflows/verify.yml`:** build the image so the Dockerfile cannot rot
  unnoticed. Deploying stays manual (`fly deploy`); there is no deploy from CI.
- **npm `files` whitelist:** leave it alone. These files only matter in the repo.

## Owner setup (to document in `docs/REMOTE.md`, "Always on: Fly.io")

1. Create a Fly.io account. It needs a card. Then run `fly auth login`.
2. From the repo:
   - `fly launch --no-deploy`, reusing the checked-in `fly.toml` and choosing an app name
     and the nearest region;
   - `fly volumes create data --size 1`.
3. Generate the owner password hash locally. Reuse `remote-setup`, or add a small
   `cronometer-mcp hash-password` subcommand that prints only the hash.
4. Store the secrets with `fly secrets set` (they are encrypted and never in the repo):
   - `MCP_OWNER_PASSWORD_HASH`
   - `CRONOMETER_USERNAME`, `CRONOMETER_PASSWORD`, and `CRONOMETER_TOTP_SECRET` if
     two-factor is on
   - `MCP_PUBLIC_URL=https://<app>.fly.dev/mcp`
   - `CRONOMETER_TIMEZONE`
5. Run `fly deploy`, then add `https://<app>.fly.dev/mcp` as a custom connector in claude.ai.
   It then appears on the phone apps too.
6. Optionally set `CRONOMETER_READ_ONLY=1` to offer reads only from the hosted copy.

## What changes for the owner

- **The Cronometer password moves to Fly's secret store**, outside the OS keyring.
  That's the cost of always-on: a machine that isn't the owner's has to be able to sign in.
- **Cronometer sees sign-ins from a datacenter address.** Unknown whether that triggers
  extra checks. Other hosted Cronometer connectors suggest it is tolerated. Watch for
  `TOTP_CODE_REQUIRED`, a 429 or a forced sign-out after the first deploy.
- **The first request after an idle stretch waits a second or two** while the machine
  starts.
- **Still single-user.** One owner, one account, same terms as the local connector.

## Verification

- `curl https://<app>.fly.dev/mcp` without a token returns 401. The OAuth metadata
  endpoints respond.
- claude.ai completes the sign-in and lists the tools. `get_daily_summary` for today
  matches the local server.
- `fly machine stop`, then a new claude.ai request: the machine starts, and the existing
  connection still works, because the tokens survive on the volume.
- Five wrong owner passwords lock sign-in, and the lock holds across a machine restart.
- Logs (`fly logs`) show no secrets. Redaction covers the `CRONOMETER_*` values exactly as
  it does locally.
