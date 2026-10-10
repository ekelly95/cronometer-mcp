# DATA_MODEL.md — cronometer-mcp-next

**Status:** verified against real Gold-tier exports, 2026-08-16.
**Scope:** what the six CSV exports actually contain. Every schema below was read from
an actual file, not inferred from documentation or third-party parsers.

**Sample values are illustrative.** Column names, column order, encoding and the
missing-versus-zero behaviour are transcribed from real files and are exact. The
*values* shown as examples have been replaced with representative ones — the schema is
the verified part, and nobody's measurements need to be in it to make the point.

**Provenance caveat:** all six files came from a single account, single day, Gold tier,
imperial display units, US locale. Multi-day, metric, and free-tier behaviour are
**unverified**. Treat everything marked ⚠️ as a hypothesis until a second export confirms it.

---

## 1. Export inventory

| File | Shape | Cols | Notes |
|---|---|---|---|
| `servings.csv` | row-per-entry | 6 | **No nutrient columns** |
| `dailysummary.csv` | wide aggregate | 64 | Only source of nutrient data |
| `biometrics.csv` | row-per-measurement (EAV) | 6 | Explicit `Unit` column |
| `exercises.csv` | row-per-entry | 6 | Header-only in sample |
| `notes.csv` | row-per-entry | 4 | Header-only in sample |
| `fasts.csv` | row-per-interval | 5 | Gold-gated; header-only in sample |

Encoding, all six: **UTF-8, no BOM, LF line endings.** Micro sign is **U+00B5** (`µ`),
not Greek mu U+03BC. Do not normalise silently — match on the exact codepoint.

---

## 2. The event spine

Four of the six files share an identical three-column prefix:

```
Day, Time, Group, <payload...>
```

`servings`, `biometrics`, `exercises`, `notes` all follow it. This is the canonical
**point event** shape and should drive a shared base type.

Two files break the pattern, and the breaks are meaningful:

- **`fasts.csv`** uses `Start` / `End` and has no `Group`. A fast is an **interval
  event**, not a point event. Model it as a distinct type; do not force it into the spine.
- **`dailysummary.csv`** uses `Date` (not `Day`) plus `Group`. It is a **wide aggregate**,
  not an event.

⚠️ **`Date` vs `Day` is a real inconsistency.** A generic column mapper that assumes one
name will silently drop the other. Map per-file, explicitly.

---

## 3. Verified schemas

### servings.csv
```
Day, Time, Group, Food Name, Amount, Category
```
- `Day` — ISO `2026-08-16`
- `Time` — 12-hour with meridiem, `8:30 AM`
- `Group` — diary group: `Breakfast` | `Lunch` | `Dinner` | `Snacks` | `Uncategorized` ⚠️ (custom groups unverified)
- `Food Name` — free text, commas common, **untrusted input**
- `Amount` — single string, quantity + unit fused: `2.00 bagel`, `1.00 container - each 5.3 oz`, `32.00 fl oz`
- `Category` — food taxonomy: `Baked Products`, `Dairy and Egg Products`, `Beverages`, `Meals, Entrees, and Sidedishes`, `Snacks`, `Supplements`

**No nutrients, and no gram weights.** The Gold PDF report shows `— 95g` per entry; the
CSV does not. Per-food nutrient attribution is impossible from this file.

### dailysummary.csv
```
Date, Group, <61 nutrient columns>, Completed
```
`Group` here takes diary-group values **plus a `Total` row per day.**

Nutrient columns, in file order, units baked into the header text:

- **General:** Energy (kcal), Alcohol (g), Caffeine (mg), Oxalate (mg), Phytate (mg), Water (g)
- **Vitamins:** B1 (Thiamine) (mg), B2 (Riboflavin) (mg), B3 (Niacin) (mg), B5 (Pantothenic Acid) (mg), B6 (Pyridoxine) (mg), B12 (Cobalamin) (µg), Folate (µg), Vitamin A (µg), Vitamin C (mg), **Vitamin D (IU)**, Vitamin E (mg), Vitamin K (µg)
- **Minerals:** Calcium (mg), Copper (mg), Iron (mg), Magnesium (mg), Manganese (mg), Phosphorus (mg), Potassium (mg), Selenium (µg), Sodium (mg), Zinc (mg)
- **Carbohydrates:** Net Carbs (g), Carbs (g), Fiber (g), Insoluble Fiber (g), Soluble Fiber (g), Starch (g), Sugars (g), Added Sugars (g)
- **Lipids:** Fat (g), Cholesterol (mg), Monounsaturated (g), Polyunsaturated (g), Saturated (g), Trans-Fats (g), Omega-3 (g), ALA (g), DHA (g), EPA (g), Omega-6 (g), AA (g), LA (g)
- **Amino acids:** Cystine, Histidine, Isoleucine, Leucine, Lysine, Methionine, Phenylalanine, **Protein**, Threonine, Tryptophan, Tyrosine, Valine (all g)

Note **Vitamin D is IU** while every other fat-soluble vitamin is µg. Note `Protein (g)`
sits *inside* the amino-acid block, not with the macros.

`Completed` — lowercase string `'false'` / `'true'`. ⚠️ `'true'` unobserved.

### biometrics.csv
```
Day, Time, Group, Metric, Unit, Amount
```
Entity-attribute-value. The **only** file with an explicit `Unit` column — the
best-designed of the six, and the right shape to imitate.

Observed shape: `Weight` / `lbs` / `180.0`, `Group = Uncategorized`, **`Time` empty.**

⚠️ Metric vocabulary is open-ended (blood pressure, glucose, cholesterol, body fat…) and
each carries its own unit. Never hardcode; carry `Unit` through as data.

⚠️ Units reflect the account's **display preference**, not a canonical system. This account
exports `lbs` while the PDF shows both `81.6 kg / 180.0 lbs`. A metric account will export
`kg`. Store the source unit; convert only at presentation.

### exercises.csv
```
Day, Time, Group, Exercise, Minutes, Calories Burned
```

### notes.csv
```
Day, Time, Group, Note
```
`Note` is free text, fully user-authored — **highest prompt-injection risk in the dataset.**

### fasts.csv
```
Name, Start, End, Recurrence, Comments
```
⚠️ Entirely unverified beyond the header. `Start`/`End` format, `Recurrence` grammar, and
in-progress-fast representation (null `End`?) all unknown.

---

## 4. Missing is not zero

**The single most important property of this data.**

Cronometer encodes the distinction in the CSV:

| Group | Omega-3 (g) | B3 (mg) |
|---|---|---|
| Breakfast | `0.00` | `0.76` |
| Lunch | `` (empty) | `` (empty) |
| Dinner | `` (empty) | `` (empty) |
| Snacks | `0.01` | `0.02` |
| **Total** | **`0.01`** | **`0.79`** |

Empty string = the food's database record has no value for this nutrient.
`0.00` = a measured zero.

**Cronometer's own `Total` row collapses the distinction**, summing missing as zero. The
sample day therefore reports 0.01 g omega-3 on a day containing salmon, and 0.79 mg niacin
on 181 g of protein. Both are artifacts, not intake.

### Rules

1. Parse nutrient cells as **strings**. `pandas.read_csv` coerces `''` → `NaN`, and
   `.sum()` skips `NaN`, silently reproducing Cronometer's bug.
2. Model every nutrient as `Present(value) | Missing` — a nullable float is not enough,
   because downstream code will `or 0` it.
3. **Never emit a nutrient total without coverage.** Every aggregate carries
   `(value, groups_with_data, groups_total)`.
4. **Do not trust the `Total` row.** Recompute, and surface the divergence — that
   divergence is a feature worth showing the user.
5. Below a coverage threshold, the honest output is *"insufficient data"*, not a number.

This is what separates the tool from every nutrition AI that confidently reports
deficiencies that are really database gaps.

---

## 5. Parser rules

1. **Filter `Group == 'Total'` before aggregating** `dailysummary`, or every day
   double-counts.
2. **`Completed` is a string.** `'false'` is truthy in Python and JavaScript. Compare
   explicitly.
3. **Parse `Amount` with `^([\d.]+)\s+(.+)$`.** Splitting on whitespace breaks
   `1.00 container - each 5.3 oz`. Units contain digits, hyphens, and spaces.
4. **Rows are not time-sorted.** Snacks holds `7:30 PM` before `3:30 PM`. Sort explicitly.
5. **`Time` may be empty** (observed on biometrics). Optional in the type.
6. **`Group` is not chronology.** A `9:39 PM` yogurt sits under `Breakfast`. Group is a
   user label; never infer time-of-day from it.
7. **No timezone anywhere in any export.** `Day` + local `Time`, no offset. Timezone must
   be user-supplied configuration, and DST transitions are the caller's problem to declare.
8. **`Food Name` and `Note` are untrusted.** Sanitise leading `= + - @` and control
   characters before any CSV round-trip; treat as prompt-injection surface on the way to
   the model.
9. **Header-only files are normal.** Three of six arrived with zero rows. Empty is a valid
   state, not an error.

---

## 6. Capability gating

`fasts.csv` is Gold-only. Building against a Gold account will bake in assumptions that
break for free-tier users — the failure mode that made an existing implementation
effectively Gold-required.

Detect capability from **which files are present and non-empty**, never from account tier.
Generate a deliberately free-tier-shaped fixture (no `fasts.csv`) and keep it in CI.

---

## 7. What exports cannot do

- **Per-food nutrient attribution.** "Which foods drove low potassium" is unanswerable.
  Nutrients exist only at diary-group granularity.
- **Gram weights per entry.** Present in the PDF, absent from CSV.
- **Food database IDs.** No stable identifier for any logged food — only display names.
- **Targets.** Percentages appear in the PDF; the CSVs carry no target values.
- **Write-back.** Read-only by construction.

These five gaps are the concrete case for authorized access. They are also the honest
scope boundary for a v1 built on exports alone.

---

## 7b. The live export is not this schema

Verified 2026-08-17. Everything above describes the **manual** export, downloaded from
Cronometer's own export page. The live `/export?generate=dailySummary` endpoint returns a
*different* file: **63 columns, no `Group`**, one row per day.

That difference is not cosmetic. Every rule in §5 about filtering the `Total` row, and the
whole missing-versus-zero argument in §4, depends on having one row per diary group. The
live file has already collapsed them, so a nutrient's coverage cannot be counted and a
divergence from Cronometer's total cannot be classified — the total *is* the collapsed
number. Only a downloaded export can answer those questions.

One further trap, also verified: Cronometer serves exports as `text/csv` with **no
charset**. An HTTP client that falls back to ISO-8859-1 will mangle every non-ASCII byte,
turning the U+00B5 micro sign in five nutrient headers into `Âµ` so that those five match
nothing. Decode as UTF-8 explicitly.

---

## 8. Open questions

1. ~~**Does the export dialog have a nutrient toggle for `servings.csv`?**~~ **Answered
   2026-08-17**, by one live read of a single day. The `servings` export returned exactly
   `Day, Time, Group, Food Name, Amount, Category` — six columns, no nutrient columns. The
   third-party parser's ~60-column expectation does not describe this account's export.
   Importantly, the live `/export` endpoint returns the same schema as the manual export
   dialog, which is what makes the live tools safe to build on these parsers at all.
2. **Is the nutrient loss real schema drift?** More likely now that question 1 resolved in
   favour of the six-column shape rather than a toggle. `biometrics.csv` also gained `Time`
   and `Group` versus that same parser's 4-column expectation. ⚠️ The *cause* is still
   unresolved, but the current schema is now confirmed rather than assumed.

   Three §5 rules were confirmed against real data on the same read, having until then been
   exercised only by synthetic fixtures. The fused `Amount` really does carry units
   containing digits and spaces (`1.00 container - each 5.3 oz`). Rows really are not
   time-sorted — one `Snacks` group arrived `7:30 PM`, `3:30 PM`, `9:41 PM` in file order.
   And `Group` really is a label rather than a time of day: three `9:39 PM` entries were
   filed under `Breakfast`.
3. `fasts.csv` field formats and in-progress representation.
4. Multi-day, multi-month export behaviour — row ordering, any per-day header repetition.
   *Partial evidence only (noted 2026-10-09):* one real downloaded `dailysummary.csv` day
   has been analysed (README, "On a real day from this account"). Its group rows summed
   exactly to Cronometer's `Total` for energy and protein, and 45 of 61 nutrients showed
   the missing-summed-as-zero pattern. That confirms the per-day layout
   on real data; it says nothing yet about ordering or headers across many days.
5. Custom diary group names.
6. Metric-account unit strings.
7. `Completed = 'true'` representation.
8. Free-tier file set.
