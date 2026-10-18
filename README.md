# Cronometer MCP

[![verify](https://github.com/ekelly95/cronometer-mcp/actions/workflows/verify.yml/badge.svg)](https://github.com/ekelly95/cronometer-mcp/actions/workflows/verify.yml)
[![npm](https://img.shields.io/npm/v/@ekelly95/cronometer-mcp)](https://www.npmjs.com/package/@ekelly95/cronometer-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for your [Cronometer](https://cronometer.com)
account. Ask Claude (or any MCP client) what you ate, what is left for today, how your
micronutrients look over the week — and have it log, edit or delete diary entries, with
your approval each time.

- **The whole diary, with ids.** Foods, exercise, notes and biometrics, each with the id
  the edit and delete tools need, plus the day's targets, what remains, and energy burned.
- **Honest nutrition.** Totals are computed food by food. A nutrient a food doesn't report
  is counted as *missing*, not as zero — so "61 mg of magnesium" comes back as "at least
  61 mg; only 4 of 12 foods report magnesium", which is what Cronometer's own total hides.
- **Safe writes.** Every account-changing tool asks for approval, deletes need an explicit
  confirmation, a timed-out write is never retried, and a read-only mode removes writes
  entirely.
- **One command to set up**, with your password kept in the operating system's credential
  store. Also runs as a Claude Desktop extension, or as a secure remote connector for
  claude.ai and the Claude phone apps.

> [!IMPORTANT]
> Cronometer has no public API. This uses the same private interfaces as Cronometer's own
> app and website, signed in as you. It is unofficial: it can break whenever Cronometer
> changes them, and Cronometer could restrict an account it sees automated. It is not
> affiliated with or endorsed by Cronometer. See [Risks](#risks).

## Quick start

Requires [Node.js](https://nodejs.org) 20 or later.

```sh
npx @ekelly95/cronometer-mcp setup
```

Setup explains the risk and asks you to type `ENABLE`, then asks for your Cronometer email,
password, an authenticator key if the account uses two-factor sign-in, and your diary
timezone. It checks the sign-in before saving anything, stores the password in the
Keychain (macOS), the Secret Service keyring (Linux) or DPAPI (Windows), and offers to add
the server to Claude Code, Claude Desktop and Codex.

Restart your client and ask:

- *What did I eat yesterday, and how close was I to my targets?*
- *How much protein do I have left today?*
- *Log two large eggs for breakfast.*
- *Which micronutrients were low this week — and which of those can't be trusted because
  foods didn't report them?*
- *Show my nutrient radar for the last 7 days.* (renders a chart; see `/nutrient_radar`)

`npx @ekelly95/cronometer-mcp doctor` checks the setup at any time.

### Other ways to run it

**Claude Desktop extension.** Download `cronometer-mcp.mcpb` from the
[latest release](https://github.com/ekelly95/cronometer-mcp/releases/latest) and open it.
Claude Desktop asks for your email and password and keeps them in your OS credential
store.

**Credentials in the client config** (for clients without a keyring, or containers):

```json
{
  "mcpServers": {
    "cronometer": {
      "command": "npx",
      "args": ["-y", "@ekelly95/cronometer-mcp"],
      "env": {
        "CRONOMETER_USERNAME": "you@example.com",
        "CRONOMETER_PASSWORD": "…",
        "CRONOMETER_LIVE_ENABLED": "1",
        "CRONOMETER_TIMEZONE": "America/New_York"
      }
    }
  }
}
```

**claude.ai and the phone apps.** `cronometer-mcp remote-setup` configures a Streamable
HTTP endpoint with its own single-user OAuth sign-in, run as a user service and published
through a tunnel such as Tailscale Funnel. See [docs/REMOTE.md](docs/REMOTE.md).

| Variable | Effect |
|---|---|
| `CRONOMETER_READ_ONLY=1` | Offer no tool that can change the account |
| `CRONOMETER_TOTP_SECRET` | Authenticator key for two-factor accounts (environment mode) |
| `CRONOMETER_TIMEZONE` | Diary timezone; defaults to the saved setup, else the computer's |
| `CRONOMETER_DATA_DIR` | Where the setup, session caches and exports live |

## Tools

46 tools: 24 that read and 22 that write. Dates accept `YYYY-MM-DD`, `today`, `yesterday`
or `N days ago`, resolved in the diary timezone.

**Diary and nutrition**

| Tool | |
|---|---|
| `get_diary` | One day or up to 14: every entry with its id, targets, consumed, remaining, energy burned |
| `get_daily_summary` | Nutrient totals with coverage per nutrient, and your Cronometer targets |
| `get_nutrition_scores` | Cronometer's category scores, with its confidence per nutrient |
| `nutrient_radar` | 31 vitamins, minerals and amino acids against adult reference intakes, for a chart |

**Foods, targets, body**

| Tool | |
|---|---|
| `search_foods` · `get_food_details` · `lookup_barcode` | Find foods, their measures and nutrients |
| `get_macro_targets` · `list_macro_templates` | Targets for a date, the weekly schedule, saved templates |
| `get_fasting_history` · `get_fasting_stats` | Fasts and fasting statistics |
| `list_biometric_metrics` · `get_biometrics` | Weight, body fat, blood pressure… over time |
| `search_activities` · `get_repeated_items` | Exercise activity ids; foods that repeat automatically |

**Long ranges and downloaded exports**

| Tool | |
|---|---|
| `export_food_log` · `export_exercises` · `export_biometrics` · `export_notes` · `export_raw` | Cronometer's CSV export, for ranges up to a year |
| `list_exports` · `analyze_export` | Coverage analysis of an export you downloaded, for months at a time |

**Writes** — each asks for approval; ⚠ marks those that also need `confirm: true`

| Tool | |
|---|---|
| `add_food_entry` · `update_food_entry` · ⚠ `remove_diary_entries` · ⚠ `copy_day` · `mark_day_complete` | The food diary (delete works on any entry type) |
| `add_note` · `update_note` · `add_biometric` · `add_exercise` | Notes, measurements, exercise |
| `add_custom_food` · `update_custom_food` · ⚠ `retire_custom_food` · `add_recipe` · `import_recipe` | Custom foods and recipes, including from free text |
| `set_macro_targets` · `create_macro_template` · ⚠ `delete_macro_template` · `set_macro_schedule_day` | Targets and the weekly schedule |
| ⚠ `delete_fast` · ⚠ `cancel_active_fast` · `add_repeat_item` · ⚠ `delete_repeat_item` | Fasts and repeated foods |

A write that hasn't yet been verified against a live account says so in its description,
and the model is told to read the result back. [docs/PROTOCOL.md](docs/PROTOCOL.md) lists
what each tool calls and what has been verified.

## Missing is not zero

Cronometer stores each food's nutrients from whatever its source reports. A branded
product's label might list eight nutrients; a lab-analysed whole food, ninety. When
Cronometer totals a day, a nutrient a food doesn't report is added as zero, so the total
looks complete when it isn't.

`get_daily_summary` keeps them apart. For a made-up day of 12 foods:

| Nutrient | Reported by | Result |
|---|---|---|
| Energy | 12 of 12 foods | **2,410 kcal** — a real total |
| Protein | 12 of 12 | **172 g** |
| Vitamin D | 9 of 12 | insufficient data — at least 520 IU |
| Magnesium | 4 of 12 | insufficient data — at least 61 mg |

A nutrient becomes a number only when every food reports it (or the share you choose with
`coverage_threshold`); otherwise you get a floor that says what it is. Days with nothing
logged are listed rather than averaged in as zero. The same rule drives the radar, which
draws an incomplete spoke as a dashed "at least" line and a nutrient nobody reported as no
data at all. None of this diagnoses anything; it reports what was logged.

## How it keeps the account safe

- **Approval on every write.** Write tools carry MCP's destructive/read-only hints and
  `anthropic/requiresUserInteraction`, which makes Claude Code ask every time, under every
  permission mode. Deletes and other irreversible tools also require `confirm: true`.
- **No duplicate writes.** A write that times out is reported as "outcome unknown — check
  the Cronometer app", never retried. A write is re-sent only when Cronometer refused it
  outright (401/403), which means it wasn't applied.
- **Ids, not guesses.** Edits and deletes take ids from `get_diary`; the server refuses an
  id that isn't on that day.
- **Untrusted data stays data.** Food names and notes come back inside a JSON-encoded
  fence the content cannot close, and the server tells the model to treat them as data.
- **Narrow network and storage.** HTTPS to `cronometer.com` and `mobile.cronometer.com`
  only, size-capped and time-limited. Passwords live in the OS credential store; session
  caches are private files (mode 600) in a private directory; secrets are redacted from
  every error and log line.
- **Gentle on Cronometer.** Calls run one at a time with a floor between them, and
  sessions are cached so the server rarely signs in.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Cronometer is not set up yet" | Run `npx @ekelly95/cronometer-mcp setup` in a terminal |
| "two-factor authentication" | Re-run setup and paste the authenticator's base32 key |
| "rate-limiting sign-ins" | Wait a few minutes; the session cache prevents this in normal use |
| No password found in the keyring (Linux) | Make sure GNOME Keyring or KDE Wallet is running and unlocked, and `secret-tool` is installed |
| Writes rejected as incompatible | Cronometer changed something; check for a newer version of this package |
| Anything else | `npx @ekelly95/cronometer-mcp doctor` |

## Risks

- **Unofficial interfaces.** Cronometer publishes no API. Its
  [terms](https://cronometer.com/terms) limit use to personal, non-commercial purposes and
  allow access to be ended without notice. This tool is for use with your own account only.
- **It can break.** The mobile API expects the app's version numbers, which can be updated
  with `CRONOMETER_APP_VERSION`/`CRONOMETER_APP_BUILD`; the web protocol's build hashes are
  discovered automatically. Either can still change in ways only a new release fixes.
- **Exports are rate-limited** by Cronometer; the `export_*` tools are for long ranges, and
  `get_diary` covers anything up to 14 days without them.
- **Not medical advice.** Reference intakes are population figures, not personal targets.

## How it works

The server talks to Cronometer's **mobile API** (the Android app's JSON interface) for
almost everything, and to the **web app's GWT-RPC protocol** only for CSV exports, macro
templates, fast edits and repeated foods. [docs/PROTOCOL.md](docs/PROTOCOL.md) has the
details; [docs/DATA_MODEL.md](docs/DATA_MODEL.md) describes the CSV export schemas.

It builds on two MIT-licensed projects:
[cronometer-api-mcp](https://github.com/rwestergren/cronometer-api-mcp) by Randy
Westergren, which established the mobile API, and
[cronometer-mcp](https://github.com/cphoskins/cronometer-mcp) by Paul Hoskins, which
established the web protocol. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```sh
npm ci
npm run verify      # typecheck + the full offline test suite
npm start           # run the stdio server from source (after npm run build)
```

Tests are offline and use synthetic fixtures; nothing in the suite has Cronometer
credentials. Live behaviour is checked by hand before a release on a throwaway diary date
([docs/RELEASING.md](docs/RELEASING.md)). Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
