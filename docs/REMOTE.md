# Using the connector from claude.ai and the Claude phone apps

Claude Code, Claude Desktop and Codex start the server on your computer. Claude's hosted
apps — claude.ai on the web, and the iPhone and Android apps — cannot. They reach a
connector from Anthropic's cloud, as a **custom connector**, which needs:

- **HTTPS on a public address**,
- MCP's **Streamable HTTP** transport, and
- an **OAuth** sign-in.

`cronometer-mcp serve-http` provides the last two: a Streamable HTTP endpoint with a small
built-in OAuth server that lets exactly one person in — whoever knows the owner password
you choose. It listens on `127.0.0.1` only. A tunnel provides the public HTTPS address;
these steps use [Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel), which
is free and gives a stable `https://<machine>.<tailnet>.ts.net` name.

**The trade-off:** it works while the computer is on, awake and signed in. When it isn't,
Claude says it couldn't reach the connector; nothing else breaks.

Read [what this exposes](#what-this-exposes) before you turn it on.

## Set up (once)

You need `cronometer-mcp setup` done first, and a Claude account (the free plan allows one
custom connector).

1. **Install Tailscale** and sign in. In the [admin console](https://login.tailscale.com/admin/dns),
   turn on **MagicDNS** and **HTTPS certificates**.

2. **Configure the connector:**

   ```sh
   npx @ekelly95/cronometer-mcp remote-setup
   ```

   It reads this machine's Tailscale name for the public URL, asks for a local port
   (default 8787) and an **owner password** (12+ characters, stored only as a scrypt hash),
   and offers to write a service that starts it when you sign in:

   | OS | Service | Start it |
   |---|---|---|
   | Linux | `~/.config/systemd/user/cronometer-mcp-remote.service` | `systemctl --user daemon-reload && systemctl --user enable --now cronometer-mcp-remote` |
   | macOS | `~/Library/LaunchAgents/io.github.ekelly95.cronometer-mcp-remote.plist` | `launchctl load <that file>` |
   | Windows | a Task Scheduler task you create (trigger: at log on) | the command `remote-setup` prints |

   To run it in a terminal instead: `npx @ekelly95/cronometer-mcp serve-http`.

3. **Publish the port.** `--bg` keeps Funnel on across reboots; the first run may ask you
   to allow Funnel for this machine.

   ```sh
   tailscale funnel --bg 8787
   ```

4. **Check it from outside your network** — for example on your phone with Wi-Fi off. This
   should show a short JSON document whose `resource` is your MCP URL:

   ```text
   https://<machine>.<tailnet>.ts.net/.well-known/oauth-protected-resource/mcp
   ```

5. **Add the connector on claude.ai** (on the web; the phone app cannot add one):
   **Customize → Connectors → Add custom connector**.
   - URL: `https://<machine>.<tailnet>.ts.net/mcp`
   - Leave the OAuth client ID and secret **empty**; Claude registers itself.
   - **Add**, then **Connect**. A sign-in page from your computer opens; enter the owner
     password and choose **Allow**.

6. **Set tool permissions** on the connector's page: reads to **Always allow**, every write
   and delete to **Needs approval** (or **Blocked**). In the hosted apps this setting is what
   makes Claude ask before changing your diary.

7. **On the phone**, start a chat, tap **+ → Connectors**, and switch Cronometer on.

## Day to day

- **Keep the computer awake** while you might use it.
- **Logs** are in `remote/server.log` inside the data directory
  (`~/.local/share/cronometer-mcp` on Linux, `~/Library/Application Support/cronometer-mcp`
  on macOS, `%LOCALAPPDATA%\cronometer-mcp` on Windows): one line per request — method,
  path, status, time — plus startup diagnostics. Query strings, bodies, codes and tokens
  are never written, and credentials are redacted. The file rotates at 5 MB.
- The remote connector and the stdio server share the saved setup and session caches.

## Change the password, disconnect, or turn it off

| To | Do |
|---|---|
| Change the owner password | Re-run `remote-setup` and restart the service. Existing connections keep working; new sign-ins need the new password. |
| Disconnect every Claude account | Delete `remote/state/state.json` in the data directory and restart the service. Every token stops working. |
| Take it off the internet | `tailscale funnel --https=443 off` (or `tailscale funnel reset`) |
| Stop it starting at sign-in | `systemctl --user disable --now cronometer-mcp-remote` · `launchctl unload <plist>` · delete the scheduled task |
| Remove it completely | All of the above, then delete the `remote` folder and the connector on claude.ai. |

## What this exposes

The remote connector has the full reach of the stdio server — every read and write tool —
for whoever completes the sign-in. (Set `CRONOMETER_READ_ONLY=1` in the service's
environment to offer reads only.) What stands in the way:

- **The owner password.** Anyone who has it can connect their own Claude account. Make it
  long and unique. After five wrong attempts in fifteen minutes, sign-in is refused for
  everyone, including you, until the window passes.
- **Only Claude can be a client.** Registration accepts only Claude's own callback
  addresses on claude.ai and claude.com, plus `http://localhost/callback` (or `127.0.0.1`)
  on any port, which is how Claude Code on the same machine signs in. A code can never be
  sent anywhere else.
- **Tokens expire and rotate.** Access tokens last an hour. Refresh tokens rotate on every
  use and lapse after 30 days unused; a spent one presented again revokes the whole
  connection. Only hashes are stored.
- **Loopback only.** The server binds to `127.0.0.1` and rejects any request whose `Host`
  is not your public name.

What it does not change: Cronometer still sees requests from your own connection, the
Cronometer password stays in your OS credential store, and the same untrusted-data fence
wraps everything returned to Claude.

This is for one person's own account. Running it as a service for other people's accounts
would be a different thing entirely, and is not what Cronometer's terms allow.

## Running it somewhere else

`dist/http/main.js` reads everything from the environment, for a host that keeps secrets
its own way: set `MCP_PUBLIC_URL`, `MCP_STATE_DIR`, `MCP_OWNER_PASSWORD_HASH` (from
`remote-setup`'s saved file), optionally `MCP_LISTEN_PORT` and `MCP_LOG_FILE`, plus
`CRONOMETER_USERNAME`, `CRONOMETER_PASSWORD`, `CRONOMETER_LIVE_ENABLED=1` and
`CRONOMETER_TIMEZONE`. Put HTTPS in front and forward to the loopback port. Cronometer then
sees a datacenter address instead of your home one, which is worth weighing first.

An always-on setup on Fly.io, so the connector works while this computer is off, is
planned in [`plans/fly-io.md`](plans/fly-io.md).
