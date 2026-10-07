# Using the connector from the Claude iPhone app

The stdio server works with Claude Code, Claude Desktop and Codex because they start it
on this computer. Claude's hosted apps — claude.ai on the web, and the iPhone and Android
apps — cannot. They reach a connector from Anthropic's cloud, as a **custom connector**,
which means three things:

- the server must answer over **HTTPS on a public address**,
- it must speak MCP's **Streamable HTTP** transport, and
- it must sign Claude in with **OAuth** (the hosted apps offer no other way for a personal account).

This repository's answer costs nothing: the server runs on this PC, listens on loopback
only, and [Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel) gives it a
stable `https://<pc>.<tailnet>.ts.net` address. A small built-in OAuth server lets exactly
one person in — whoever knows the owner password you choose.

**The trade-off:** the phone can use it only while this PC is on, awake and signed in.
If it is not, Claude says it couldn't reach the connector. Nothing else breaks.

Read [the security notes](#what-this-exposes) before you turn it on.

## Set up (once)

You need the normal Windows setup done first (`scripts\setup-windows.ps1`) and a paid or
free Claude account (the free plan allows one custom connector).

1. **Install Tailscale** for Windows and sign in. The free Personal plan is enough.
2. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), turn on
   **MagicDNS** and **HTTPS certificates**.
3. **Build and configure** the remote connector:

   ```powershell
   npm run build
   pwsh -File scripts\setup-remote.ps1
   ```

   It reads this machine's Tailscale name, asks you to choose an **owner password**
   (12+ characters — it is stored only as a scrypt hash), and offers to register a
   Windows logon task so the server starts whenever you sign in.

4. **Publish it** with Funnel. `--bg` keeps it on across reboots; the first run may ask
   you to allow Funnel for this machine in the admin console.

   ```powershell
   tailscale funnel --bg 8787
   ```

5. **Check it from outside your network** — for example in Safari on the phone with
   Wi-Fi off. This should show a short JSON document whose `resource` is your MCP URL:

   ```text
   https://<pc>.<tailnet>.ts.net/.well-known/oauth-protected-resource/mcp
   ```

6. **Add the connector on claude.ai** (on the web — the phone app cannot add one):
   **Customize → Connectors → Add custom connector**.
   - URL: `https://<pc>.<tailnet>.ts.net/mcp`
   - Leave the OAuth client ID and secret **empty**. Claude registers itself.
   - Click **Add**, then **Connect**. A sign-in page from your PC opens; enter the owner
     password and choose **Allow**. The connector should show **Connected**.

7. **Set tool permissions** on the connector's page: read tools to **Always allow**, and
   every write and delete tool to **Needs approval** (or **Blocked** if you never want it
   from the phone). This is the setting that makes Claude ask before changing your diary;
   don't rely on anything else for that in the hosted apps.

8. **On the iPhone**, start a chat, tap **+ → Connectors**, and switch Cronometer on.

Try "What did I eat yesterday?" first. Then, if you want to see the approval prompt,
"log one medium banana for today" — approve it, check it in the Cronometer app, and ask
Claude to remove it.

## Day to day

- **Keep the PC awake while you might use it.** Settings → System → Power → *When plugged
  in, put my device to sleep after* → **Never**. The logon task starts the server; Funnel
  restarts by itself.
- **Logs** are in `%LOCALAPPDATA%\CronometerPersonalMcp\remote\server.log`: one line per
  request (method, path, status, time), plus startup and helper diagnostics. Query strings,
  bodies, codes and tokens are never written, and credentials are redacted.
- **Start or stop it by hand:** `Start-ScheduledTask 'Cronometer MCP (remote)'` /
  `Stop-ScheduledTask 'Cronometer MCP (remote)'`, or run
  `pwsh -File scripts\run-mcp.ps1 -Transport http` in a terminal.
- **Claude Code and Desktop** keep using the stdio server exactly as before. The remote
  connector keeps its own Cronometer session file, so the two never overwrite each other's.

## Change the password, disconnect, or turn it off

| To | Do |
|---|---|
| Change the owner password | Re-run `scripts\setup-remote.ps1`. Existing connections keep working; only new sign-ins need the new password. |
| Disconnect every Claude account | Delete `%LOCALAPPDATA%\CronometerPersonalMcp\remote\oauth\state.json` and restart the task. Every token stops working; reconnect from claude.ai. |
| Take it off the internet | `tailscale funnel --https=443 off` (or `tailscale funnel reset` to clear every Funnel/Serve setting) |
| Stop it starting at sign-in | `Unregister-ScheduledTask 'Cronometer MCP (remote)'` |
| Remove it completely | All three of the above, then delete the `remote` folder and the connector in claude.ai. |

## What this exposes

The remote connector is the stdio server's full reach — every read and write tool — made
available to whoever completes the sign-in. What stands in the way:

- **The owner password.** Anyone who has it can connect their own Claude account. Make it
  long and use it nowhere else. After five wrong attempts in fifteen minutes, sign-in is
  refused for everyone, including you, until the fifteen minutes pass.
- **Only Claude can be a client.** Registration accepts only Claude's own callback
  addresses, so a sign-in can never send a code anywhere else.
- **Tokens expire and rotate.** Access tokens last an hour. Refresh tokens rotate on every
  use and lapse after 30 days unused; a stolen one replayed later revokes the whole
  connection. Only hashes are stored on disk.
- **Loopback only.** The server binds to `127.0.0.1`; Funnel is the only way in, and it
  rejects any request whose `Host` is not your public name.

What it does not change: Cronometer still sees requests from your home connection, the
Cronometer password stays DPAPI-encrypted as before, and the same untrusted-data fence
wraps everything returned to Claude.

Funnel is documented by Tailscale as beta. The design reasoning is in §12 of
`SECURITY_AUDIT_2026-08-17.md`.

## Moving it off this PC later

Nothing in `src/http` is specific to Windows or Tailscale. Any always-on host that can
run Node and Python, terminate HTTPS, and forward to the loopback port works the same way:
set `MCP_PUBLIC_URL`, `MCP_STATE_DIR`, `MCP_OWNER_PASSWORD_HASH`, the usual `CRONOMETER_*`
variables, and run `node dist/http/main.js`. The Cronometer password then lives wherever
that host keeps secrets rather than in DPAPI, and Cronometer sees a datacenter address
instead of your home one — both worth weighing before you move it.
