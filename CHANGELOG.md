# Changelog

Notable changes, newest first. Dates are when the change was committed. There are no
published releases; `package.json` stays at `0.1.0`.

## Unreleased

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
