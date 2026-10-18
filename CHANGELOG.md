# Changelog

Notable changes, newest first.

## 1.0.2 — 2026-10-18

### Fixed
- `add_custom_food` saved 0 for fiber, sugars, sodium and saturated fat when they were
  left out, so the food looked like it reported them. They are now left unset. Foods
  created with 1.0.0–1.0.1 keep their zeros; edit them in the app if that matters.
- `add_food_entry` with `grams` on a recipe whose default measure is a serving logged that
  many servings (150 g became 150 servings). Grams now go against the recipe's gram
  measure, and are refused when it has none.
- The live backend treated an `import_recipe` call without `save` as a save. The tool's
  schema always defaulted to `save: false`, so this was unreachable through MCP; the
  backend now agrees.
- Windows: PowerShell decodes its pipes in the console code page, so on a multi-byte
  code page (Japanese, Chinese, Korean Windows) a non-ASCII password was saved mangled
  while setup reported success. The secret now crosses the pipe as base64, and setup
  checks that it decrypts back unchanged before saving. Configurations saved by 1.0.1 or
  earlier are still read the old way, which on single-byte code pages such as 437
  always returned the original text. Checked on Windows 11.
- `get_fasting_history` without an `end_date` ended on today in UTC, which is tomorrow
  every evening in the Americas. It now uses the diary timezone.
- `remove_diary_entries` deleted every entry carrying a given id, though ids are unique
  only within a type. An id that names two entries now removes nothing and says so.
- Tool errors are now also scrubbed of the password read from the OS keyring at the MCP
  layer, not only in the live backend.

### Changed
- `setup` and `remote setup` warn when the Node they register belongs to a version
  manager (nvm, fnm, Volta, asdf, mise, n, nodenv), since that path breaks when the
  version is switched.

### Security
- Remote connector: anyone who could reach `/register` could push the owner's signed-in
  client off the twenty-client list and sign them out. A full list now only drops clients
  that never signed in, and registration is limited to ten per fifteen minutes.

## 1.0.1 — 2026-10-18

### Fixed
- `get_daily_summary` gave the account profile's default energy range as the energy
  target instead of the day's macro template. Macro targets (energy, protein, carbs, net
  carbs, fat) now come from the template in effect, matching the app; over days on
  different templates, no single target is given.

## 1.0.0 — 2026-10-18

The first public release, and a rewrite of the live connection.

### Changed
- **The live connection is now TypeScript talking to Cronometer's mobile API.** The
  vendored Python GWT client, its bridge process and the `uv` environment are gone. The
  web protocol is kept, in TypeScript, only for CSV exports, macro templates and the
  weekly schedule, fast edits and repeated foods. See `docs/PROTOCOL.md`.
- **Renamed** to `@ekelly95/cronometer-mcp`; the MCP server key is `cronometer`, so tools
  appear as `mcp__cronometer__<tool>`, and tool names lose their `cronometer_` prefix. An
  existing setup is migrated on first run (the old directory and keyring entry are left
  in place).
- **One command, every platform:** `cronometer-mcp setup` replaces the three setup scripts
  and two launchers. It checks the sign-in before saving anything, stores the password in
  the OS credential store, and offers to register with Claude Code, Claude Desktop and
  Codex. The server reads the password into its own memory rather than passing it
  through the environment of three processes.
- Diary reads (`get_diary`) return every entry with its id, so any entry can be edited or
  deleted, not only ones logged in the same conversation.
- Date inputs accept "today", "yesterday" and "N days ago", resolved in the diary timezone.
- Tools that read the CSV export are now named `export_*` and are meant for long ranges.

### Added
- `get_daily_summary`: live, coverage-aware nutrition computed food by food, with the
  account's own targets. A nutrient a food does not report counts against coverage
  instead of adding a silent zero.
- `nutrient_radar` reads the live diary by default; a downloaded export is optional.
- `get_nutrition_scores`, `lookup_barcode`, `list_biometric_metrics`, `get_biometrics`,
  `search_activities`.
- Writes: `update_food_entry`, `remove_diary_entries` (any entry type), `mark_day_complete`,
  `add_note`, `update_note`, `add_exercise`, `add_custom_food`, `update_custom_food`,
  `retire_custom_food`, `add_recipe`, `import_recipe`. `add_food_entry` takes any measure
  or grams; `add_biometric` takes any metric and unit.
- Two-factor sign-in (TOTP), read-only mode (`CRONOMETER_READ_ONLY=1`), and a description
  on every write not yet verified against a live account.
- `cronometer-mcp doctor`, `remote-setup` and `serve-http`: the OAuth remote connector now
  runs on Linux (systemd user service) and macOS (launch agent), not only Windows.
- An MCPB bundle for one-click Claude Desktop install, and an MCP Registry entry.

### Fixed
- Repeated foods: the response reader follows GWT object back-references. The old reader
  failed on any account with more than one repeated food.
- Expired session tokens stay on the redaction list, so one cannot leak into an error
  after a new session replaces it.

## 0.x — 2026-08-17 to 2026-10-14 (never published)

### Added
- `cronometer_nutrient_radar` and the `nutrient_radar` prompt. They average a downloaded
  export over logged days against adult reference intakes, across 31 spokes.
- The radar marks a nutrient that no diary group recorded as a `no-data` spoke, and names
  export columns that are missing in `nutrientColumnsMissingFromExport`.
- A CI job that runs the Python bridge tests in the hash-locked environment.

### Changed
- `cronometer_copy_day` is marked destructive and requires `confirm: true`.
- `cronometer_analyze_export` refuses a date range with no diary rows, rather than
  returning 61 insufficient-data nutrients.
- `cronometer_export_raw` refuses a response whose header is not the requested export,
  such as a login page.
- `cronometer_get_recent_biometrics` reads its response by walking the GWT stream, pinned
  against a live capture. The old heuristic read the data backwards and rejected ids
  containing `_`, which is likely why it had been seen returning nothing while a weight
  was logged. MODIFIED (17).
- The vendored client's remaining heuristic parsers (fasts, fasting
  stats, macro targets, templates and schedules) no longer fill fields they cannot find
  with `0`, `0.0` or `""`. A missing identifying or measured field raises; an optional
  one is `null`. The daily macro targets for an unset day are `{}`, not four zero targets.
  An open fast is no longer reported as finished. See MODIFIED (14)–(16) in
  `python/vendor/cronometer_client.py`.
- `cronometer_add_biometric` reports an error if Cronometer accepts the entry but its id
  cannot be read. The error says not to retry.
- The remote connector's log rotates while it runs, not only at startup.
- Closing the live bridge fails a call that is still in flight immediately, instead of
  leaving it to time out.
- The package is named `cronometer-personal`, matching the server.

### Fixed
- `setup-remote.ps1` no longer lets a Node warning end up in the stored password hash.
- Stopping the remote connector's scheduled task now stops its server. Windows had left
  the Node process running and holding the port, so the next start failed.
- Documentation drift: the tool count, the loopback redirect for Claude Code, the
  seven-day window for detecting refresh-token reuse, and README checkout paths.

## 2026-10-07

- **Add opt-in remote connector for Claude's hosted apps** (`34707b5`). OAuth 2.1 with
  PKCE and Streamable HTTP, bound to loopback behind Tailscale Funnel. See `REMOTE.md`.
- **Fix session retry, remove dead tools, tighten inputs** (`4e3293c`).

## 2026-08-17

- **Stop a busy machine from failing the suite** (`db565c7`).
- **Correct the test count in the README** (`8aa65a0`).
- **Let the server start without a Python environment** (`fb6d4a4`).
- **Carry the server's error data out of the stdio test** (`7ccec94`).
- **Make the stdio test explain itself, and give the timeout test room** (`0a42fcb`).
- **Initial release snapshot** (`2d7905b`).
