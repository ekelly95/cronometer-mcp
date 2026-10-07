# Personal Cronometer MCP

This is a local, personal bridge between Cronometer and MCP clients such as Codex and Claude Code. It combines the useful live-account coverage of Paul Hoskins’s `cronometer-mcp` client with a stricter TypeScript layer that preserves missing nutrition data, labels account-changing actions honestly, and keeps credentials out of MCP configuration files.

It is a personal learning project built by a NASM Certified Sports Nutrition Coach (CSNC) who has also taken university-level nutrition courses outside their degree major. That background informs the project’s priorities, but this software is not a medical device or a substitute for medical care.

It provides full live access supported by the pinned client: food diary reads and writes, coverage-aware nutrient analysis of downloaded exports, raw CSV exports, food search, macro targets and schedules, fasting records, biometrics, day copying, and repeated foods.

## Important limits

- This is an unofficial personal tool. Cronometer does not provide or support this interface. A Cronometer website change can break it without warning, and automated access may put the account at risk. Read Cronometer’s current [Terms of Service](https://mobile.cronometer.com/terms/) before enabling it.
- Some CSV export features may require Cronometer Gold. Cronometer documents its supported manual export flow in [Account Settings: Data Export](https://support.cronometer.com/hc/en-us/articles/360018760151-Account-Settings).
- This reports what was logged and how complete the record is. It is not a medical device, does not diagnose nutrient deficiencies, and does not provide medical advice.
- Local by default. The stdio server is what Codex, Claude Code and Claude Desktop start. An **opt-in remote connector** serves the same tools over HTTPS behind a single-user OAuth sign-in so the Claude iPhone app can use them — see [REMOTE.md](REMOTE.md). It listens on loopback only and is published deliberately through Tailscale Funnel. There is still no hosted or multi-user deployment, telemetry, or arbitrary code-execution tool.

## What makes the nutrition summary safer

Cronometer’s daily summary has a subtle trap: an empty nutrient cell means “no data,” while a displayed zero means a recorded zero. Its `Total` row can collapse missing cells into zero. This server parses the diary-group rows itself, calculates coverage for every nutrient, and only returns an intake value when the requested coverage threshold is met. With the default threshold of `1`, every diary-group cell for that nutrient must contain data.

A nutrient result therefore has one of two shapes:

- `kind: "value"` — includes the value, unit, group coverage, day coverage, and Cronometer Total comparison.
- `kind: "insufficient-data"` — includes coverage and an explicitly named lower-bound `observedSubtotal`, but cannot express that subtotal as intake.

That distinction is maintained from CSV parsing through the final MCP output.

## Every diary read is parsed here, not upstream

The pinned client reads a CSV with `csv.DictReader` and hands back rows of untyped strings. That is fine as a transport and useless as a model of your diary, so this server does not use it. `cronometer_get_food_log`, `cronometer_get_exercises`, `cronometer_get_biometric_log` and `cronometer_get_notes` each fetch the raw export and parse it here instead. What that buys you:

- `1.00 container - each 5.3 oz` comes back as a quantity and a unit, not one string to be guessed at later.
- A blank exercise duration is reported as missing, not as zero minutes.
- Units stay as your account displays them. Nothing is converted.
- A row that cannot be read is dropped *and reported*, with the file and line, so a short list is never quietly short.
- A time that was never recorded is `null`, never midnight.

One deliberate refusal is worth knowing about. If Cronometer's export ever loses a column this server needs, the parser would return zero rows — which looks exactly like a day you did not log. Rather than hand that back, the call fails and names the missing column. An empty answer here would be the same class of mistake as reading an absent nutrient as zero.

The same rule now applies to the live reads that do not go through a CSV. If one of those comes back empty in a shape the connector does not recognise, the result carries `unverified: true` — meaning "empty, and I could not confirm that". A call that genuinely fails raises instead, so the flag is reserved for the one genuinely ambiguous case: a response that names data it then cannot find.

Getting that boundary right took two passes. The first flagged *every* empty result as unverified, reasoning that a missing element-type marker might mean the format had changed. Checking the actual responses showed the opposite — an empty collection has no element type because it has no elements — so the warning was firing on correct answers, which is how a warning becomes noise. It now fires only when the response contains something the parser could not read.

Live calls are also paced, at least a second apart. It is imperceptible while you read the answers, and it is the difference between a conversation and a scrape.

One thing to avoid when setting up your diary: **do not name a diary group `Total`.** Cronometer writes its own per-day total into the same column as your group names, and the export gives no way to tell the two apart. A group with that name would be read as the day's total and left out of the sum, so its food would silently vanish from every intake figure. Any other name is fine.

Nutrient cells are also read strictly. A cell must be empty or a plain non-negative decimal; anything else — text, a thousands separator, a negative number — is recorded as missing with a note saying which column and line, rather than being coerced into a number that would quietly change a total.

## Windows setup

Open PowerShell and run:

```powershell
Set-Location C:\dev\cronometer
.\scripts\setup-windows.ps1
```

On macOS the equivalent is `sh scripts/setup-macos.sh`, which does the same things in the same order — see [Other platforms](#other-platforms) for what is proven there and what is not.

The setup does the following:

1. Reinstalls the locked Node dependencies.
2. Creates or updates a private Python 3.12 environment from a hash-checked five-package lockfile (`requests` and its four transitives — the protocol client is vendored, not installed).
3. Builds the server and runs all offline tests.
4. Asks for the Cronometer diary timezone. `America/New_York` is the recommended default for this computer.
5. Shows the unsupported-interface warning and requires the exact word `ENABLE` before live access is switched on.
6. Prompts for the Cronometer username and password. Windows DPAPI encrypts the password for the current Windows account; it is not written to this repository, a command line, Codex configuration, or Claude configuration.
7. Offers to register the server with each client it finds installed — Codex, Claude Code, and Claude Desktop. Each is asked about separately, and skipping one does not affect the others.
   - **Codex** also gets `default_tools_approval_mode = "writes"` written into its `config.toml`, so every tool not marked read-only prompts for approval. If that step fails the setup says so plainly rather than leaving you with a registered server that does not ask.
   - **Claude Code** needs no approval setting; see [Write safety](#write-safety) for why.
   - **Claude Desktop** has no CLI for this, so its `claude_desktop_config.json` is edited directly. The previous file is backed up first, any servers you already had are preserved, and an existing `cronometer-personal` entry is never overwritten.

Restart the MCP client after registration. Start with:

> Call `cronometer_status`, then check the Cronometer connection. Do not change anything.

The first real connection may take longer because it signs in and creates a session. Later connections reuse a validated JSON session cache.

## Nutrient coverage needs a downloaded export

This is the part worth understanding, because it decides which tool answers a question about nutrients.

Cronometer offers the same data two ways, and they are not equivalent:

| | Rows | Can it tell missing from zero? |
|---|---|---|
| **Live** (`cronometer_export_raw` with `daily_summary`) | One per **day**, already totalled | **No** |
| **Downloaded** (`cronometer_analyze_export`) | One per **meal**, plus Cronometer's own total | **Yes** |

Coverage works by comparing meals. If Lunch's omega-3 cell is blank while Breakfast reads `0.00`, that is a database gap, not a zero intake. The live export has already collapsed those meals into one number — and that number is precisely the one that counted the blanks as zero. So there is no live nutrition summary. There used to be a `cronometer_get_nutrition_summary` tool, but against the real live export it could only ever refuse, so it was removed rather than left to cost a call and an error every time.

Two things about reading the result. A nutrient's `value` is the **sum** over the days listed in `days`, not a daily figure. And a day inside the requested range that has no rows at all adds nothing to that sum — the same missing-as-zero trap one level up — so those days are listed in `daysAbsentFromExport`, with `daysInRange` beside them. Average over the days that were actually logged.

If a future export drops or renames a single nutrient column, the analysis still runs: that nutrient comes back as insufficient data with a `missing-nutrient-column` issue, and the other sixty are unaffected. Only a missing `Date`, `Group` or `Completed` column stops it.

On a real day from this account, at full coverage: **16 of 61 nutrients** could be reported as numbers. The other **45** were refused, every one of them a case where Cronometer's own total had summed absent data as zero. Energy and protein matched Cronometer exactly and are trustworthy. Omega-3 read 0.01 g — on a day containing salmon — from only two of four meals.

To use it: in Cronometer, **Settings → Account → Export Data**, download, and extract the CSVs into a dated folder under the exports directory the launcher configures (`%LOCALAPPDATA%\CronometerPersonalMcp\exports\2026-08-16\`, and so on). `cronometer_list_exports` shows what it can see. Each export is a snapshot, so keeping them dated builds the history that multi-month analysis needs.

Two things about that directory. It sits inside the same ACL-protected folder as your credentials, because an export is your whole diary per meal. And the server never accepts a *path* — a tool passes a folder **name**, which is resolved and checked to be inside that directory, so nothing outside it can be read even through a symlink.

## Logging food

Verified working end to end on 2026-08-17: search, add, read back, delete, read back.

It takes two steps, because a diary entry is identified by a *measure* rather than by a food:

1. `cronometer_search_foods` — returns `food_source_id` (the food) and `food_id` (its default measure), plus a description like `1 large - 50g` telling you what one of them weighs.
2. `cronometer_add_food_entry` — pass both identifiers, `measure_id: 0`, the number of measures as `quantity`, and the real total weight as `weight_grams`. Both amounts must be above zero.

`measure_id` accepts only `0`, the universal gram measure. The protocol packs the diary group into the top 16 bits of the measure id and keeps only the bottom 16 of whatever it is given, so a real measure id from `cronometer_get_food_details` (such as `1072101`) would be sent as a different number. Until that encoding is verified against a real entry, other ids are refused rather than logged against whatever the truncated number means.

One thing still worth a deliberate check: the vendored client's own docstring says that with the gram measure, `quantity` should equal `weight_grams`, while the flow above passes the number of measures. The 2026-08-17 test used the flow above. If an entry's displayed amount looks wrong in the app, that is the first place to look.

`cronometer_get_food_details` lists every measure a food has with its gram weight, so you can work out `weight_grams` for "two large" or "half a cup" without guessing.

**One real limitation.** `servings.csv` carries no serving identifier, so `cronometer_get_food_log` cannot return one — and `cronometer_remove_food_entry` needs it. In practice you can only delete an entry whose ID you still have from logging it in the same conversation. To remove anything logged earlier, or logged in the app, use the Cronometer app. This is a gap in what the export exposes, not something the connector can work around.

## What has actually been verified

Tools are grouped by evidence, not by intent. Everything below was exercised against a
real account on 2026-08-17.

**Verified working.** Food search, food details, the food diary and the other CSV-backed
reads, the downloaded-export analysis, macro-template list/create/delete, repeat-item
add/delete, biometric add/remove for **weight**, and adding then removing a food entry.

**Verified broken, and refused rather than attempted.**

- `cronometer_add_biometric` accepts **weight only**. Asking for a heart rate of 60
  created a *Weight* entry of 60 lbs — the metric encoding for the other three is
  guesswork, and `body_fat` shares `weight`'s encoding byte for byte, so it must
  mis-file the same way. A write that quietly files data under the wrong metric
  corrupts a trend you read later and gives no sign it happened, so the other metrics
  are refused. Record them in the Cronometer app.
- `cronometer_set_day_complete` failed: Cronometer has removed the `setDayComplete`
  method, the same way it removed `findFoods`. Nothing local can fix that, so the tool
  has been removed — it asked for approval and then failed every time.

**Fixed after a live test.** `cronometer_get_repeated_items` used to return
`food_source_id` and `measure_id` transposed, an always-empty weekday list, and a diary
group of `0`. It now reads the response the way the protocol actually writes it —
back to front — and reports the weekdays correctly.

The diary group is reported as `null`, because Cronometer does not send it back: two
rules created in *different* groups returned identical responses apart from their ids,
quantity and weekdays. The group you choose when creating a rule is applied, it just
cannot be read back. `null` says that; `0` would have looked like a real group.

**Never exercised.** `copy_day` (it copies a whole day and cannot be cleanly undone,
because serving IDs are not readable back from the export), `set_macro_targets` and
`set_macro_schedule_day` (Cronometer computes recommended targets from your profile and
setting these overrides that calculation — not something to do as a test), and the two
fasting tools (there is no create-fast tool, so there is nothing to delete or cancel).

## Write safety

Read and write tools are deliberately separate. Every account-changing tool is marked non-read-only, and every tool marked destructive rejects the call unless `confirm: true` is present.

Approval works differently in each client, so here is exactly what you get where:

| Client | What makes a write ask first | Configured by |
|---|---|---|
| **Claude Code** | Each of the 13 account-changing tools carries `anthropic/requiresUserInteraction`, so it prompts on **every** call — including under `acceptEdits`, `auto`, and `bypassPermissions` — and no allow rule can skip it | The server itself. Nothing to set up. Needs Claude Code 2.1.199 or later |
| **Codex** | `default_tools_approval_mode = "writes"`, so every tool not marked read-only prompts | The setup script, in Codex's `config.toml` |
| **Claude Desktop** | Desktop's own tool-approval prompt | Claude Desktop |
| **Claude web and mobile** (remote connector) | Each tool's permission on the connector page: set writes and deletes to *Needs approval* | You, in claude.ai — see [REMOTE.md](REMOTE.md) |

The Claude Code case is the strong one, because the requirement travels with the tool rather than living in a config file you might change later. The others depend on client configuration: the setup script sets Codex's, and tells you loudly if it could not. Older Claude Code versions ignore the flag and fall back to their normal permission handling, as do other MCP clients — an unknown `_meta` key is harmless, which is why it is sent unconditionally.

Read tools deliberately carry no such flag. A status check that nagged would only teach you to click through prompts without reading them.

Writes are never retried automatically. If a write times out, the server reports that its outcome is unknown. Inspect the Cronometer app before deciding whether to try anything again; otherwise a retry could duplicate food, biometrics, templates, or repeated items.

An expired session is handled differently for reads and writes. A read signs in again and tries once more. A write that meets an expired session fails, and is not re-sent, but the dead session is discarded so the next call signs in afresh instead of failing the same way.

## Manual MCP registration

The setup normally offers to do this. If you skipped it, the command contains only the local launcher path—never credentials.

Codex:

```powershell
codex mcp add cronometer-personal -- pwsh -NoProfile -ExecutionPolicy Bypass -File C:\dev\cronometer\scripts\run-mcp.ps1
```

Then add this line inside the new `[mcp_servers.cronometer-personal]` section of `%USERPROFILE%\.codex\config.toml`:

```toml
default_tools_approval_mode = "writes"
```

Claude Code, available to the Windows user in every project:

```powershell
claude mcp add --scope user cronometer-personal -- pwsh -NoProfile -ExecutionPolicy Bypass -File C:\dev\cronometer\scripts\run-mcp.ps1
```

Claude Desktop has no registration command. Add this to the `mcpServers` object in `%APPDATA%\Claude\claude_desktop_config.json`, keeping any servers already there, then restart Desktop:

```json
"cronometer-personal": {
  "command": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\dev\\cronometer\\scripts\\run-mcp.ps1"]
}
```

Use the real path to `pwsh.exe` on this machine — `(Get-Command pwsh).Source` prints it. If that path is under `C:\Program Files\WindowsApps\` (the Microsoft Store build), use `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` instead: the versioned folder is replaced on every Store update, and a registration that points into it stops starting. The setup script makes that substitution itself. Back the file up before editing: it holds Claude Desktop's own preferences as well as the server list, and a bad edit loses them. The setup script does all of that for you, which is the better route.

Check registration with `codex mcp get cronometer-personal` or `claude mcp get cronometer-personal`. Anthropic’s current [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) explains its configuration scopes and the [permission rules](https://code.claude.com/docs/en/permissions) that apply to MCP tools. Codex uses the same MCP configuration for its CLI and IDE extension; see OpenAI’s [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Packaging this as a Desktop Extension (`.mcpb`/`.dxt`) would remove the hand-editing step, but an extension bundle would also have to carry the credential prompt and the Python environment. That is not built; the launcher-plus-config route above is what this repository supports.

## Credential and network boundary

- `scripts/run-mcp.ps1` decrypts the DPAPI-protected password and passes it to the server through environment variables. Be clear about what that costs: the launcher runs for as long as the MCP session does, and while it runs the plaintext password is present in the environment of three processes — the launcher, Node, and the Python child. It is never written to disk in the clear, never placed on a command line, and never stored in an MCP configuration file, but any process running as this Windows user could read it. That is the trade for not typing a password into a config file.
- The Python child replaces the incumbent’s executable pickle session with size-checked JSON and stores it in the private application-data directory. On Windows that directory is protected by an ACL the setup script applies: inheritance broken, a single access rule for your own account, and no entry for SYSTEM or the administrators group. Two layers guard it, and they check different things. The launcher reads the actual ACL on every start and refuses to run if the directory has become inheritable or has gained any other identity. The Python bridge cannot read a Windows ACL without extra packages, so it only refuses to run when `CRONOMETER_DATA_DIR` is unset — enough to stop the session cookie falling back to an unprotected home-directory default, but not a check on the permissions themselves. Start the server any way other than through the launcher and you get the weaker of the two.
- The networking session accepts only HTTPS requests whose exact host is `cronometer.com`, including redirects. Proxy and certificate environment variables are not passed to the child, so a machine-wide proxy cannot interpose.
- Calls are serialized, dates and identifiers are validated twice, and any tool result over 2 MB is refused rather than silently truncated — ask for a shorter date range.
- Food names, notes, website errors, and all other live text are returned inside an explicit untrusted-data boundary, JSON-encoded so that the text cannot forge the end of that boundary. They must never be treated as instructions.

## Useful tools

The 30 MCP tools are grouped conceptually as follows:

- Connection: status and connection check.
- Downloaded exports: list them, and run the coverage-aware nutrient analysis over one. These read a folder on this computer and never touch the network.
- Diary: food log, exercise, biometric history, notes, raw CSV export, add/remove food, and copy a day.
- Food database: search and food details.
- Macros: read targets/schedules, set daily targets, list/create/delete templates, and assign a template to a weekday.
- Fasting: history, statistics, delete a fast, and cancel an active fast while keeping its series.
- Biometrics: read recent values, add a value, and delete a value.
- Repeated foods: list, add, and delete rules.

There is intentionally no arbitrary GWT request tool, browser automation, raw SQL, shell execution, or automatic background sync. The one HTTP transport is the opt-in, single-user remote connector in [REMOTE.md](REMOTE.md).

## Development verification

All tests are offline and use synthetic data:

```powershell
npm run verify      # typecheck, TypeScript, Python, and the setup scripts
```

That is 508 TypeScript tests, 52 Python and 35 setup checks. The individual steps are `npm run typecheck`, `npm test`, `npm run test:python` and `npm run test:setup`; the last skips itself loudly where PowerShell is absent, rather than failing for a reason unrelated to the code being checked.

`npm test` builds first and checks both legacy MCP and the modern `2026-07-28` stdio handshake. The protocol suite calls every tool against a fake bridge, verifies tool permission labels, checks that every destructive tool refuses an unconfirmed call, ensures read handlers cannot reach mutation methods, and drives hostile multi-line text through both the success and error paths to prove neither can forge the end of the untrusted-data boundary. The remote connector's suite (`test/http`) runs the whole OAuth sign-in in-process — registration, PKCE, lockout, refresh rotation and reuse revocation — and then both protocol eras over Streamable HTTP with the issued token.

Two honest limits on what those tests show. The generic output schema deliberately types `data` as unknown, because the shape of a live response is Cronometer's to decide — so "validates against the output schema" is a real check only for the export analysis and the parsed diary reads, which are the tools with a fully specified result. And every test is offline: they prove the wrapper behaves, not that the undocumented interface still works.

The only live check that should be run casually is the connection check. Do not test write tools against the real account unless the intended account change is itself the test.

## A note on two files this repository does not contain

Parts of the source and the security audit refer to `CLAUDE.md` and `AGENTS.md`. Those are working files for the AI assistants used to build this project, and they stay on the machine rather than in the repository — they are written *to* an assistant rather than to a reader, and they carry personal context that reads poorly stripped of it.

Nothing load-bearing is hidden by that. The design rules they state are visible where they are enforced: the missing-versus-zero type in `src/domain/nutrient.ts`, the write annotations in `src/mcp/registry.ts`, the untrusted-data fence in `src/mcp/server.ts`, the network boundary in `python/live_bridge.py`. The reasoning behind them is in `BUILD_PLAN.md`, `DATA_MODEL.md` and the security audit, all of which are addressed to a person. References to the two absent files are left as written rather than edited out, because the audit in particular is a dated record and quietly rewriting its citations would make it less trustworthy, not more.

## Other platforms

macOS is built: `scripts/setup-macos.sh` and `scripts/run-mcp.sh` mirror the Windows pair step for step, storing the password in the login Keychain instead of DPAPI and protecting the data directory with mode `700` instead of an ACL. Everything else is the same code.

Being plain about the state of it, because it matters more than the claim:

| | Windows | macOS | Linux |
|---|---|---|---|
| Run end to end against a real account | yes | **not yet** | no |
| Test suite in CI | yes | yes | shell scripts linted only |
| Setup and launcher written | yes | yes | launcher only, untested |

The parts of the macOS path that are ordinary code — the Claude Desktop config writer, the configuration validator, every parser — are covered by tests that run on macOS in CI on every push. What has never been exercised on a Mac is the part that needs one: the Keychain prompt, the directory-mode refusal, and one real read and write. [MACOS.md](MACOS.md) lists those four checks explicitly and says which is most likely to reveal a difference.

Linux gets the launcher for free, since it takes the non-Darwin branch for its data directory and permission check, but there is no setup script and nobody has run it.

## Provenance and license

The GWT-RPC protocol implementation began as Paul Hoskins’s MIT-licensed `cronometer-mcp` 2.0.3. It is now **vendored and modified** at `python/vendor/cronometer_client.py` rather than installed from PyPI, with his copyright notice preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) as the licence requires.

That change was made in August 2026, for a specific reason. Upstream's last commit was 8 March 2026. By August it had eight open issues and four unmerged pull requests — two of them fixing a Cronometer change that had already broken food search outright, and with it the ability to log food at all. A pinned dependency cannot be patched. Vendoring meant those fixes could be applied, and it means the next breakage is fixable here rather than only reportable elsewhere.

Every deliberate difference from the original is listed in the vendored file's header, and two of them are adapted from public pull requests by other contributors, credited in the notices. The protocol reverse-engineering itself is Paul Hoskins's work and remains the hard part of this project.

`requests` is now the only runtime dependency this project does not own.

This project’s own code is MIT licensed; see [LICENSE](LICENSE).
