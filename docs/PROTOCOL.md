# How the connector talks to Cronometer

Cronometer has no public API. This connector uses the two private interfaces Cronometer's
own clients use, and nothing else:

| Interface | Host | Used for |
|---|---|---|
| **Mobile API** — the JSON interface of the Android app | `mobile.cronometer.com` | Everything it offers: the diary, foods, nutrition, targets, fasting, biometrics, custom foods, recipes, and most writes |
| **Web app protocol** — GWT-RPC, as the website speaks it | `cronometer.com` | Only what the mobile API does not offer: CSV exports, saving and deleting macro templates, the weekly schedule, deleting or cancelling a fast, repeated foods |

Every request goes through one guarded function (`src/live/http.ts`) that allows HTTPS to
exactly those two hosts, follows a redirect only to one of them, caps response size, and
times out. A timed-out write is reported as an unknown outcome and never retried.

## Mobile API

- **Sign-in:** `POST /api/v2/login` with the email and password, a six-digit code when
  two-factor is configured, and `timezone: null`. A non-null timezone there is a *write*:
  it replaces the account's timezone setting. The response carries a session key, the
  account id and timezone, the nutrient catalogue, per-nutrient targets, preferences and
  the biometric metric list. The session and that profile are cached (mode 600) in the
  data directory, because Cronometer rate-limits sign-ins.
- **v2 calls:** `POST /api/v2/<name>` with an `auth` block naming the app build. A
  session that has expired answers 401/403 or `{"result":"FAIL"}`; a read then signs in
  again and retries once. A write is re-sent only after an outright 401/403, which means
  it was not applied.
- **v3 calls:** REST under `/api/v3/user/<id>/…` with the session in `x-crono-session`.
  Only the diary-entry delete uses it.
- **Notes** are saved through the app's photo-upload endpoint, `POST /photoupload`, as a
  multipart form.
- **App identity:** the build and version the app reports are in `src/live/mobile/identity.ts`
  and can be overridden with `CRONOMETER_APP_VERSION` / `CRONOMETER_APP_BUILD` if
  Cronometer stops accepting them.

The protocol was established by
[rwestergren/cronometer-api-mcp](https://github.com/rwestergren/cronometer-api-mcp) (MIT),
which inspected the Android app; request shapes here follow it, and are credited in
`THIRD_PARTY_NOTICES.md`.

## Web app protocol (GWT-RPC)

Sign-in is the website's: the login page's anti-CSRF token, the login form, the
`sesnonce` cookie, then `authenticate` for the account id. Every GWT body names a
build-specific permutation and policy hash, discovered from `cronometer.nocache.js` with
fallbacks. Responses are read by `src/live/web/gwt.ts`, which follows GWT's object
back-references rather than assuming fixed positions; an earlier positional reader failed
on any account with more than one repeated food. Request bodies were ported from
`cronometer-mcp` 2.0.3 by Paul Hoskins (MIT), with the fixes this project made to it.

## What each tool uses, and what has been checked live

"Verified" means run against a real account and the result read back. Unverified writes
say so in their own description, so the model and the person approving the call both see
it.

| Tool | Interface · endpoint | Status |
|---|---|---|
| `status` | none | local only |
| `check_connection` | mobile · `login`, `get_macro_target_templates` | verified |
| `get_diary` | mobile · `get_diary`, `get_foods` | verified (per-entry kcal sums to Cronometer's total) |
| `get_daily_summary` | mobile · `get_diary`, `get_foods`, profile targets | verified |
| `get_nutrition_scores` | mobile · `get_diary`, `get_nutrition_scores` | verified |
| `nutrient_radar` (live) | mobile · as `get_daily_summary` | verified |
| `search_foods` | mobile · `find_food` | verified |
| `get_food_details` | mobile · `get_food` | verified |
| `lookup_barcode` | mobile · `barcode` | verified |
| `get_macro_targets` | mobile · `get_diary` (date), `get_macro_schedules` (week) | verified |
| `list_macro_templates` | mobile · `get_macro_target_templates` | verified |
| `get_fasting_history` | mobile · `get_fasting_with_date_range` | verified on an account with no fasts |
| `get_fasting_stats` | mobile · `get_fasting_stats` | verified |
| `list_biometric_metrics` | mobile · login profile / `get_metrics` | verified |
| `get_biometrics` | mobile · `get_biometrics` | verified |
| `search_activities` | mobile · `get_activity_forest`, `all_legacy_activities` | verified |
| `get_repeated_items` | web · `getRepeatedItems` | verified |
| `export_*`, `export_raw` | web · `generateAuthorizationToken`, `/export` | verified |
| `list_exports`, `analyze_export` | local files | local only |
| `add_food_entry` | mobile · `get_food`, `add_serving` | verified (except a recipe's Recipe-type serving measure, which counts servings; only recipes made in the app have one) |
| `update_food_entry` | mobile · `get_diary`, `edit_serving` | verified (grams, measure and diary group) |
| `remove_diary_entries` | mobile · `get_diary`, v3 `DELETE diary-entries` | verified (food, note, biometric, exercise) |
| `copy_day` | mobile · `copy` | verified |
| `mark_day_complete` | mobile · `set_complete` | verified |
| `add_note`, `update_note` | mobile · `/photoupload` | verified |
| `add_biometric` | mobile · `add_biometric` | verified (weight) |
| `add_exercise` | mobile · `add_exercise` | verified |
| `add_custom_food`, `update_custom_food`, `retire_custom_food` | mobile · `get_food`, `add_food` | verified (retire also covers recipes) |
| `add_recipe`, `import_recipe` | mobile · `get_foods`, `import_recipe`, `poll_async_result`, `add_food` | verified (preview and save) |
| `set_macro_targets` | web · `updateDailyTargetTemplate` | verified |
| `create_macro_template`, `delete_macro_template` | web · `saveMacroTargetTemplate`, `deleteMacroTargetTemplate` | verified |
| `set_macro_schedule_day` | web · `saveMacroSchedule` | verified ("monday" changes Monday) |
| `delete_fast`, `cancel_active_fast` | web · `deleteFast`, `cancelFastAndKeepSeries` | not yet verified (needs an account with fasts) |
| `add_repeat_item` | web · `addRepeatItem` | saved and read back; which day is weekday 0 not yet confirmed |
| `delete_repeat_item` | web · `deleteRepeatItem` | verified |

Writes are verified on a throwaway date (1900-01-02) and removed again, so a real diary is
never touched by a test.
