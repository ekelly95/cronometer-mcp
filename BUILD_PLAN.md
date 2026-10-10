# BUILD_PLAN.md — cronometer-mcp-next

Seven milestones. The user explicitly selected full live read/write on 2026-08-16.
Milestones are verification boundaries; continue through them unless a real credential,
account-risk, or external-state decision requires the user.

Every milestone has acceptance criteria that are mechanically checkable. If a criterion
cannot be verified by a passing test, it is not done.

---

## M0 — Skeleton and fixtures

Set up the project and, critically, the synthetic test data. Fixtures come first because
every later milestone is validated against them.

**Build:**
- TypeScript project, ESM, Node 20+, strict mode on.
- `vitest` configured.
- Directory layout: `domain/` canonical types with zero I/O and zero dependencies,
  `parse/` one module per export file, `analyze/` coverage-aware aggregation, `live/`
  the bridge to the Python helper, `mcp/` server and tool definitions, `config/`
  timezone and data-directory resolution. `mcp/` may import `analyze/` and `domain/`;
  `analyze/` and `parse/` may import `domain/`; nothing imports `mcp/`; no CSV logic
  lives outside `parse/`.

**Fixtures** — hand-written synthetic CSVs in `test/fixtures/`, matching the verified
schemas in `DATA_MODEL.md` exactly (column names, `µ` = U+00B5, no BOM, LF endings):

| Fixture | Purpose |
|---|---|
| `gold-complete/` | All six files, several days, realistic values |
| `free-tier/` | Same, **without `fasts.csv`** — capability detection |
| `empty-diary/` | All files header-only, zero rows |
| `missing-nutrients/` | The critical case — see below |
| `malformed/` | Ragged rows, bad dates, injection payloads |

The `missing-nutrients` fixture must reproduce the real-world failure this project exists
to fix: a day containing a fish dish where the omega-3 cells are **empty strings**, other
groups have `0.00`, and Cronometer's own `Total` row sums missing as zero. Include a
parallel niacin case on a high-protein day.

The `malformed` fixture must include a food name beginning with `=`, one containing a
comma and quotes, one with emoji, and a note containing text resembling an instruction to
a language model.

**Acceptance:** `npm test` runs green with zero tests. All five fixture directories exist.
No real data anywhere in the tree.

Two further fixtures — metric-units and multi-month — are deliberately **not** built here.
Both depend on properties `DATA_MODEL.md` §8 lists as unverified, and inventing them would
let M2 validate its coverage logic against fabricated data. Add them only from real exports.

---

## M1 — Parsers

One module per export file. Pure functions: file contents in, domain objects out. No I/O,
no MCP, no aggregation.

**Build:**
- `domain/` types first: `CalendarDay`, `LocalTime` (optional), `DiaryGroup`,
  `Quantity { value, unit }`, `NutrientValue = Present(number) | Missing`, `Unit`,
  `PointEvent`, `IntervalEvent`.
- Parsers for all six files.
- `Amount` parsed with `^([\d.]+)\s+(.+)$` into `Quantity`.
- `Completed` compared as a string literal.
- `Date` vs `Day` mapped per-file, explicitly.

**Acceptance — each of these is a test:**
1. Empty nutrient cell parses to `Missing`; `"0.00"` parses to `Present(0)`. They are not
   equal and cannot be conflated by the type system.
2. `"1.00 container - each 5.3 oz"` → `{ value: 1.0, unit: "container - each 5.3 oz" }`.
3. Header-only files parse to empty arrays, not errors.
4. `free-tier/` parses without `fasts.csv` present.
5. Biometric row with empty `Time` parses successfully.
6. `Group` is never used to infer time of day — assert a `9:39 PM` entry under `Breakfast`
   round-trips with both values intact.
7. Malformed rows produce a structured error naming the file and line, and do not abort
   the whole import.
8. Round-tripping a food name beginning with `=` through any CSV output escapes it.

---

## M2 — Coverage-aware aggregation

The heart of the project. Everything here exists to avoid reporting database gaps as
nutritional findings.

**Build:**
- Aggregate nutrients across groups and days, tracking `(value, withData, total)`.
- Filter `Group === "Total"` before summing — sum the group rows independently.
- Compare the recomputed total against Cronometer's own `Total` row and expose the
  divergence.
- A coverage threshold below which the result is `InsufficientData`, not a number.

**Acceptance — each is a test:**
1. On `missing-nutrients/`, omega-3 returns coverage strictly below 1.0 and is **not**
   reported as a plain number.
2. **Divergence from Cronometer's `Total` row is classified, not merely detected.** Two
   independent causes exist and must not be conflated:
   - **Rounding** — group values are displayed rounded while the export totals them
     unrounded, so `0.76 + 0.02` legitimately reports `0.79`. Benign. Tolerance is
     `±0.005 × groupCount` for a 2-decimal column.
   - **Missing-as-zero** — Cronometer sums absent cells as zero. This is the real signal.

   Assert that a complete day whose divergence falls inside the rounding tolerance is
   **not** flagged, and that the `missing-nutrients` fixture **is** — for the right reason.

   Coverage, not total divergence, is the primary signal. A nutrient with `Missing` cells
   is suspect whether or not the arithmetic happens to line up. Treat divergence as a
   secondary diagnostic.
3. Summing a day's groups never includes the `Total` row — assert on a multi-group day
   that the result is not doubled.
4. A nutrient with 100% coverage reports coverage 1.0 and a plain value.
5. Multi-day aggregation reports per-nutrient coverage across days, not a single global
   number.
6. No code path in `analyze/` contains `?? 0`, `|| 0`, or `Number(x) || 0` applied to a
   nutrient. Enforce with a lint rule or a grep-based test.

---

## M3 — Isolated live client

> **Status, 2026-10-09.** The client is no longer a pinned dependency: it was vendored on
> 2026-08-17 into `python/vendor/cronometer_client.py`, with every change from upstream
> numbered in its header. The plan below is kept as written.

Use the pinned MIT `cronometer-mcp==2.0.3` client through a narrow Python JSON-lines
bridge. Keep the TypeScript process in charge of MCP permissions and nutrition semantics.

**Build:**
- Fixed egress boundary: HTTPS to `cronometer.com` only.
- Live opt-in through `CRONOMETER_LIVE_ENABLED=1`.
- Credentials inherited as environment variables, never command arguments or output.
- Validated, non-executable JSON session cache replacing the upstream pickle file.
- Strict method allowlist, input bounds, one-year maximum live export range, timeouts, and
  serialized calls.
- Never auto-retry a write; timeouts report an unknown outcome.
- Pin and hash the small runtime dependency set. Preserve the upstream MIT notice.

**Acceptance:**
1. Unit tests exercise every allowed method without live network access.
2. Requests to HTTP or any non-Cronometer host are refused.
3. Protocol delimiters and malformed dates/IDs are refused before reaching the client.
4. Session state round-trips as JSON and no pickle file is created.
5. Credentials and cookie values are redacted from errors.
6. The Node bridge serializes calls and kills the child after a timeout.

---

## M4 — Unified MCP server

> **Status, 2026-10-09.** Two tools listed below no longer exist. The coverage-aware
> nutrition summary over the live export was removed: that export is already collapsed to
> day totals, so it could only refuse (DATA_MODEL.md §7b). Coverage comes from
> `cronometer_analyze_export` over a downloaded export instead. "Mark a day
> complete/incomplete" was removed after Cronometer dropped `setDayComplete`. `copy_day`
> now also requires `confirm: true`, and the server has 31 tools and one prompt.

Build one stdio server on protocol `2026-07-28` via `serveStdio()`. Zod schemas emit JSON
Schema 2020-12. The live export feeds the M1 parser and M2 coverage analysis, so convenience
does not bypass nutrition correctness.

**Read tools:** status/connection check, food diary, coverage-aware nutrition summary, raw
export, food-database search/details, macro targets/templates/schedule, fasting history and
stats, recent biometrics, and repeat items.

**Write tools:** add/remove food, set daily macro targets, create/delete macro templates,
assign one schedule day, delete/cancel fasts, add/remove biometrics, copy a day, mark a day
complete/incomplete, and add/delete repeat items.

Keep the server instructions' first 512 characters self-contained. Every tool has an output
schema and accurate `readOnlyHint`, `destructiveHint`, and `idempotentHint` annotations.
Deletion tools require `confirm: true` in addition to host approval.

**Acceptance:**
1. Server starts over stdio and responds to `tools/list` in legacy and modern MCP eras.
2. Every tool declares an output schema; every successful response validates against it.
3. Nutrition output cannot express an intake value without coverage.
4. Read handlers cannot reach a mutation method; enforce from a declarative registry test.
5. Every write is marked non-read-only; every deletion is destructive and checks confirmation.
6. Tool responses contain no credential values or filesystem paths.
7. Live text is returned as clearly delimited untrusted data.

---

## M5 — Packaging and personal setup

**Build:**
- Local `node dist/mcp/main.js` bin entry and one-command Windows setup.
- Required timezone plus explicit live opt-in. Fail loudly if timezone is unset — never
  guess it.
- Codex `config.toml`, `codex mcp add`, Claude Code, and Claude Desktop instructions.
- The Windows launcher supplies credentials from a per-user DPAPI-encrypted store and Codex
  setup sets this server's approval mode to `writes`; examples contain no credential values.
- README stating plainly: not affiliated with or endorsed by Cronometer; organizes and
  analyzes recorded data; not a medical device; does not provide medical advice.
- MIT license.

**Acceptance:** the server appears in Codex and Claude, a tools-list smoke test passes, and
the README carries the non-affiliation, unsupported-interface, account-risk, and non-medical
statements.

---

## M6 — Declarative analytics *(deferred until real multi-month verification)*

A single `analyze_nutrition` tool with validated grouping, filtering, comparison, and
top-contributor operations. No arbitrary code execution.

Deferred deliberately: it is only worth building once M1–M4 prove the coverage model
holds up against multi-month data.

---

## Explicitly not being built

These remain outside the personal tool:

- Browser automation, mobile endpoint reverse engineering, or arbitrary/raw GWT execution.
- Multi-user or hosted deployment. *(A single-user remote connector over HTTP was added
  on 2026-10-07 so the Claude iPhone app can use the server; it is opt-in, listens on
  loopback behind Tailscale Funnel, and is gated by an owner password. See `REMOTE.md`
  and §12 of the security audit.)*
- Code Mode or any sandboxed code execution.
- Telemetry, crash reporting, or usage analytics.
- Food-database lookups (USDA/Open Food Facts) — a later milestone, not v1.
- Any feature that infers, estimates, or fills in a nutrient value that was not exported.
- Background writes, scheduled writes, or automatic retries of an uncertain write.
