# Running this on Linux

Built and tested on CachyOS (KDE Plasma 6). The server, parsers and Python bridge are
the same code as on Windows and macOS; only the launcher's password lookup and the
setup script are Linux-specific.

## Setup

```sh
git clone https://github.com/ekelly95/cronometer-personal-mcp.git
cd cronometer-personal-mcp
sh scripts/setup-linux.sh
```

You need `node`, `npm`, `uv` and `secret-tool` (from `libsecret`) on `PATH`, and a
running Secret Service provider: KDE Wallet (`ksecretd`) or GNOME Keyring.

The script runs the same sequence as the macOS one: install, Python environment from
the locked requirements, build, both test suites, timezone, the literal word `ENABLE`,
credentials, then optional registration with Codex and Claude Code. Claude Desktop has
no official Linux build, so it is not offered.

## What is different

| | macOS | Linux |
|---|---|---|
| Password | login Keychain | Secret Service keyring, service `cronometer-personal-mcp`, account = username |
| `credential_source` | `keychain` | `libsecret` |
| Data directory | `~/Library/Application Support/CronometerPersonalMcp` | `${XDG_DATA_HOME:-~/.local/share}/CronometerPersonalMcp` |
| Protection | mode `700`, checked on every start | the same |

```sh
# What setup runs. With no value piped in, secret-tool prompts on the terminal, so
# the password never appears in the process table.
secret-tool store --label='Cronometer Personal MCP' service cronometer-personal-mcp account "$USERNAME"

# What the launcher runs.
secret-tool lookup service cronometer-personal-mcp account "$USERNAME"
```

If the wallet is locked when a client starts the server, KDE or GNOME asks to unlock
it. That is expected.

## Verified on Linux

- Launcher refusals: unconfigured, data directory at mode `755`, no keyring entry.
- With a stored entry, the launcher reaches the server: `initialize` and `tools/list`
  answer with all tools.
- A `secret-tool` store, lookup and clear round trip.

Not yet verified here: one live read and one write with its undo against the real
account, and `.session.json` appearing at mode `600`.
