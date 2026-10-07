"""Cronometer API client using the GWT-RPC protocol.

Authenticates via the web login flow, then exports nutrition data
(servings, daily summaries, exercises, biometrics, notes) as CSV.

NOTE: Cronometer has no public API. This client uses the same GWT-RPC
protocol as the web app. The GWT magic values (permutation hash, header)
may change when Cronometer deploys new builds. See README for details.

────────────────────────────────────────────────────────────────────────────
VENDORED AND MODIFIED.

Originally cronometer_mcp/client.py from cronometer-mcp 2.0.3.

    Copyright (c) 2026 Paul Hoskins
    MIT License. The full licence text is preserved in THIRD_PARTY_NOTICES.md,
    distributed with this software as the licence requires.

Vendored on 2026-08-17 rather than installed from PyPI. Upstream's last commit
was 2026-03-08; by August it had eight open issues and four unmerged pull
requests, two of them fixing a Cronometer change that had broken food search
outright. A pinned dependency cannot be patched, and waiting was not a strategy.

Deliberate changes from upstream, each marked `MODIFIED` at the site:

  1. find_foods() calls Cronometer's current JSON food-search endpoint. Upstream
     used a GWT-RPC `findFoods` method that Cronometer has since removed; it now
     answers with IncompatibleRemoteServiceException. Approach follows upstream
     PR #8 by alex-mark, independently corroborated by PR #6 by auctionsjeff.
  2. Read-only calls re-authenticate once on an expired session. Writes never
     retry. Upstream PR #1 placed the retry inside `_gwt_post`, which every
     account-changing method routes through — that would silently re-send a
     write whose outcome is unknown.
  3. A failed parse raises instead of returning an empty list. Upstream answered
     a failed call with `return []`, so a server error arrived as "you have no
     data" — the exact failure this project exists to prevent.
  4. Refreshed fallback GWT hashes (upstream PR #2); the defaults had gone stale.
  5. The pickle session store is replaced with validated JSON by the subclass in
     live_bridge.py. Unpickling executes arbitrary code; a cookie jar should not.
  6. An empty collection is recognised as a *confirmed* empty rather than an
     unverified one. Change 3 first flagged every empty result unverified, on the
     theory that a missing element type might mean the format had changed. The
     real responses said otherwise: an empty collection carries no element type
     because it has no elements. The flag was firing on correct answers, which is
     how a warning becomes noise. It now fires only when a response has content
     the parser could not read.
  7. Exports are decoded as UTF-8 rather than left to requests' guess. Cronometer
     sends `text/csv` with no charset, so requests falls back to ISO-8859-1 and
     mangles every non-ASCII byte — including the U+00B5 micro sign in five
     nutrient headers, which then match nothing and read as missing everywhere.
  8. Measure ids are read relative to the description ref rather than from a fixed
     offset. Upstream read i-4, a zero field, so every measure reported id 0 and
     every logged serving fell back to the universal gram measure.
  9. add_biometric accepts `weight` only. The metric encodings for the other three
     are unverified and wrong: a live test asking for heart_rate 60 produced a
     Weight entry of 60 lbs, and body_fat shares weight's encoding byte for byte.
 10. A removed method is told apart from an expired session. Both arrive as //EX;
     only the latter is worth retrying, and calling the former "session expired"
     misreports a permanent server-side change as a transient local one.
 11. Repeated items are read by walking the GWT stream instead of scanning for
     "large integers". GWT writes its data section in reverse of the textual
     order, so upstream's first large integer was the measure id: every item came
     back with food_source_id and measure_id swapped, an always-empty weekday
     list, and a diary group of 0 that Cronometer never sent. Confirmed against
     two records written with deliberately distinct values.
 12. A rejected session is discarded where it is detected, in `_gwt_post`, so a
     write that meets an expired session no longer leaves every later write to
     fail the same way. Nothing is re-sent. And `_gwt_read` takes a body builder
     rather than a body: the body embeds the nonce, so the old retry re-sent the
     dead one and could never succeed.
 13. Numbers in GWT bodies are written without exponents (`_gwt_number`).
     Upstream's `str()` turned 0.00001 into `1e-05`.

Keep this list current. It is the whole record of how this file differs from the
code it came from.
────────────────────────────────────────────────────────────────────────────
"""

import csv
import io
import json
import logging
import os
import re
from collections.abc import Callable
from datetime import date
from decimal import Decimal
from pathlib import Path

import requests

logger = logging.getLogger(__name__)


def _gwt_number(value: float) -> str:
    """A number as the GWT body expects it: integers bare, never an exponent.

    MODIFIED (13): upstream wrote floats with `str()`, which switches to exponent
    form below 1e-4 — `str(0.00001)` is `1e-05` — and Cronometer's parser was
    never shown to accept that. `Decimal(repr(...))` keeps the shortest exact
    digits and the `f` format spells them out positionally.
    """
    if value == int(value):
        return str(int(value))
    return format(Decimal(repr(float(value))), "f")


# MODIFIED (3): the two failure kinds that upstream expressed as `return []`.
# Naming them is what lets a caller tell "nothing is recorded" apart from
# "the answer could not be read", which upstream could not express at all.
class CronometerResponseError(RuntimeError):
    """Cronometer's answer could not be read. It is NOT evidence of no data."""


class SessionExpiredError(CronometerResponseError):
    """The session was rejected. A read may retry once; a write must not."""


class UnrecognisedResponse(CronometerResponseError):
    """A well-formed response whose shape is not the one we expect."""


# MODIFIED (3): the honest answer to "the response was //OK, but the structure I
# expected was not in it".
#
# Raising would be wrong, because a genuinely empty record produces no type
# marker either — an account with no biometrics would start erroring. Returning a
# bare [] is what upstream did, and it is how a wire-format change came back as
# "you have none". So: a real list/dict subclass, meaning every existing caller
# keeps working untouched, while anything that cares can read `.unverified` and
# report that the emptiness is unconfirmed rather than measured.
class UnverifiedEmpty(list):
    """Empty — but the emptiness could not be confirmed."""

    unverified = True


class UnverifiedEmptyMapping(dict):
    """Empty — but the emptiness could not be confirmed."""

    unverified = True

# URLs
LOGIN_HTML_URL = "https://cronometer.com/login/"
LOGIN_API_URL = "https://cronometer.com/login"
GWT_BASE_URL = "https://cronometer.com/cronometer/app"
EXPORT_URL = "https://cronometer.com/export"
# MODIFIED (1): the endpoint the web app uses for food search since Cronometer
# removed the GWT-RPC findFoods method. Same host as everything else here, so the
# connector's exact-host allowlist needs no widening.
FOOD_SEARCH_URL = "https://cronometer.com/api/v3/user/{user_id}/food-search/string"
GWT_NOCACHE_JS_URL = "https://cronometer.com/cronometer/cronometer.nocache.js"
GWT_CACHE_JS_URL = "https://cronometer.com/cronometer/{permutation}.cache.js"

# NCCDB "universal" measure_id that works for any food in updateDiary.
# CRDB foods have food-specific measure_ids in their getFood response,
# but those IDs cause "ghost entries" (counted but invisible in diary).
# Using an NCCDB measure_id (here: eggs' "mL chopped" measure) with the
# correct weight_grams produces working entries for ALL food sources.
UNIVERSAL_MEASURE_ID = 124399

# GWT magic values — used as fallbacks if auto-discovery fails.
DEFAULT_GWT_CONTENT_TYPE = "text/x-gwt-rpc; charset=UTF-8"
DEFAULT_GWT_MODULE_BASE = "https://cronometer.com/cronometer/"
# MODIFIED (4): refreshed from upstream PR #2. These are only fallbacks — the
# hashes are normally discovered from the live bootstrap JS — but a stale fallback
# turns a discovery failure into a confusing "application is out of date" error
# rather than an obvious one.
DEFAULT_GWT_PERMUTATION = "8991EC9262AAC4288DD509AA25E804F1"
DEFAULT_GWT_HEADER = "F074E4C7D41D83A4BC27CA0816B7B731"

GWT_AUTHENTICATE = (
    "7|0|5|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "authenticate|java.lang.Integer/3438268394|"
    "1|2|3|4|1|5|5|-300|"
)

GWT_GENERATE_AUTH_TOKEN = (
    "7|0|8|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "generateAuthorizationToken|java.lang.String/2004016611|"
    "I|com.cronometer.shared.user.AuthScope/2065601159|"
    "{nonce}|1|2|3|4|4|5|6|6|7|8|{user_id}|3600|7|2|"
)

# MODIFIED (1): GWT_FIND_FOODS was removed along with its wire-format parser.
# The method it addressed no longer exists server-side, so keeping the template
# would only preserve a path that fails with a misleading "application is out of
# date" error. find_foods() uses FOOD_SEARCH_URL instead.

GWT_UPDATE_DIARY = (
    "7|0|12|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "updateDiary|java.lang.String/2004016611|"
    "I|java.util.List|{nonce}|"
    "java.util.Collections$SingletonList/1586180994|"
    "com.cronometer.shared.entries.changes.AddEntryChange/3949104564|"
    "com.cronometer.shared.entries.models.Serving/2553599101|"
    "com.cronometer.shared.entries.models.Day/782579793|"
    "1|2|3|4|3|5|6|7|8|{user_id}|9|10|1|1|11|12|"
    "{day}|{month}|{year}|{quantity}|{diary_group}|0|{measure_id}|0|0|"
    "{weight_grams}|{food_source_id}|A|{food_id}|0|1|"
)

GWT_REMOVE_SERVING = (
    "7|0|8|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "removeServing|java.lang.String/2004016611|"
    "J|I|{nonce}|1|2|3|4|3|5|6|7|8|{serving_id}|{user_id}|"
)

GWT_GET_FOOD = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getFood|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|2|5|6|7|{food_source_id}|"
)

GWT_GET_ALL_MACRO_SCHEDULES = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getAllMacroSchedules|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|2|5|6|7|{user_id}|"
)

GWT_GET_DAILY_MACRO_TARGET_TEMPLATE = (
    "7|0|8|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getDailyMacroTargetTemplate|java.lang.String/2004016611|"
    "I|com.cronometer.shared.entries.models.Day/782579793|"
    "{nonce}|"
    "1|2|3|4|3|5|6|7|8|{user_id}|7|{day}|{month}|{year}|"
)

GWT_UPDATE_DAILY_TARGET_TEMPLATE = (
    "7|0|12|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "updateDailyTargetTemplate|java.lang.String/2004016611|"
    "I|com.cronometer.shared.targets.models.MacroTargetTemplate/3691130822|"
    "{nonce}|"
    "java.lang.Boolean/476441737|"
    "java.lang.Double/858496421|"
    "com.cronometer.shared.entries.models.Day/782579793|"
    "{template_name}|"
    "1|2|3|4|3|5|6|7|8|{user_id}|"
    "7|9|0|10|{carbs}|0|11|{day}|{month}|{year}|"
    "10|{calories}|10|{fat}|0|1|0|0|0|12|10|{protein}|0|"
)

GWT_GET_MACRO_TARGET_TEMPLATES = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getMacroTargetTemplates|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|2|5|6|7|{user_id}|"
)

GWT_SAVE_MACRO_SCHEDULE = (
    "7|0|9|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "saveMacroSchedule|java.lang.String/2004016611|"
    "I|com.cronometer.shared.targets.DayOfWeek/913617675|"
    "{nonce}|"
    "com.cronometer.shared.targets.DayOfWeek$DayOfWeekEnum/3974900421|"
    "1|2|3|4|4|5|6|7|6|8|{user_id}|7|9|{day_of_week}|{template_id}|"
)

GWT_DELETE_MACRO_TARGET_TEMPLATE = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "deleteMacroTargetTemplate|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|3|5|6|6|7|{user_id}|{template_id}|"
)

# --- Biometric GWT templates ---

GWT_GET_RECENT_BIOMETRICS = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getRecentBiometrics|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|2|5|6|7|{user_id}|"
)

GWT_ADD_BIOMETRIC = (
    "7|0|9|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "addBiometric|java.lang.String/2004016611|"
    "com.cronometer.shared.biometrics.Biometric/2989635787|"
    "I|{nonce}|"
    "com.cronometer.shared.entries.models.Day/782579793|"
    "1|2|3|4|3|5|6|7|8|6|"
    "{value}|9|{day}|{month}|{year}|0|A|0|1|0|{flags}|"
    "0|0|0|0|0|{metric_position}|0|{user_id}|"
)

GWT_REMOVE_MEASUREMENT = (
    "7|0|8|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "removeMeasurement|java.lang.String/2004016611|"
    "J|I|{nonce}|"
    "1|2|3|4|3|5|6|7|8|{biometric_id}|{user_id}|"
)

# MODIFIED (9): only `weight` is verified, and the others are demonstrably wrong.
#
# `flags` encodes which metric an entry is filed under. Tested live on 2026-08-17:
# asking for `heart_rate` with a value of 60 created a **Weight** entry of 60 lbs.
# The table shows why — `body_fat` carries flags identical to `weight`, and two
# different metrics cannot share one encoding, so at least those two mis-file.
#
# A write tool that quietly files data under the wrong metric is worse than one
# that refuses: it corrupts a trend the user reads later and gives no sign it did.
# `_SUPPORTED_BIOMETRICS` is the allowlist actually enforced, and it holds only the
# entry observed to work. Anyone deriving the real encodings should confirm each by
# writing one and reading it back through the CSV export — that is what caught this.
_BIOMETRIC_TYPES = {
    "weight": {"flags": 65539, "metric_position": 2, "unit": "lbs"},
    # UNVERIFIED and known to mis-file. Kept only as a starting point for whoever
    # works out the real values; nothing reaches these while the allowlist stands.
    "blood_glucose": {"flags": 196609, "metric_position": 2, "unit": "mg/dL"},
    "heart_rate": {"flags": 65540, "metric_position": 2, "unit": "bpm"},
    "body_fat": {"flags": 65539, "metric_position": 2, "unit": "%"},
}

#: The metrics add_biometric will actually write. See above.
_SUPPORTED_BIOMETRICS = frozenset({"weight"})

# --- Fasting GWT templates ---

GWT_GET_USER_FASTS = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getUserFasts|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|2|5|6|7|{user_id}|"
)

GWT_GET_USER_FASTS_FOR_RANGE = (
    "7|0|8|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getUserFastsForRange|java.lang.String/2004016611|"
    "I|com.cronometer.shared.entries.models.Day/782579793|"
    "{nonce}|"
    "1|2|3|4|4|5|6|7|7|8|{user_id}|"
    "7|{start_day}|{start_month}|{start_year}|"
    "7|{end_day}|{end_month}|{end_year}|"
)

GWT_GET_FASTING_STATS = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getFastingStats|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|2|5|6|7|{user_id}|"
)

GWT_DELETE_FAST = (
    "7|0|8|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "deleteFast|java.lang.String/2004016611|"
    "I|java.lang.Integer/3438268394|"
    "{nonce}|"
    "1|2|3|4|4|5|6|6|7|8|{user_id}|{fast_id}|0|"
)

GWT_CANCEL_FAST_KEEP_SERIES = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "cancelFastAndKeepSeries|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|3|5|6|6|7|{user_id}|{fast_id}|"
)

# --- Diary operations GWT templates ---

GWT_COPY_DAY = (
    "7|0|8|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "copyDay|java.lang.String/2004016611|"
    "I|com.cronometer.shared.entries.models.Day/782579793|"
    "{nonce}|"
    "1|2|3|4|4|5|6|7|7|8|{user_id}|"
    "7|{src_day}|{src_month}|{src_year}|"
    "7|{dst_day}|{dst_month}|{dst_year}|"
)

GWT_SET_DAY_COMPLETE = (
    "7|0|9|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "setDayComplete|java.lang.String/2004016611|"
    "I|com.cronometer.shared.entries.models.Day/782579793|"
    "java.lang.Boolean/476441737|"
    "{nonce}|"
    "1|2|3|4|4|5|6|7|8|9|{user_id}|"
    "7|{day}|{month}|{year}|{complete}|"
)

# --- Repeat item GWT templates ---

GWT_GET_REPEATED_ITEMS = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "getRepeatedItems|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|2|5|6|7|{user_id}|"
)

GWT_ADD_REPEAT_ITEM = (
    "7|0|11|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "addRepeatItem|java.lang.String/2004016611|"
    "I|com.cronometer.shared.repeatitems.RepeatItem/477684891|"
    "{nonce}|"
    "java.util.ArrayList/4159755760|"
    "java.lang.Integer/3438268394|"
    "{food_name}|"
    "1|2|3|4|3|5|6|7|8|{user_id}|7|{quantity}|"
    "9|{day_count}|{day_entries}|"
    "0|11|{diary_group}|0|{food_source_id}|{food_id}|0|"
)

GWT_DELETE_REPEAT_ITEM = (
    "7|0|7|https://cronometer.com/cronometer/|"
    "{gwt_header}|"
    "com.cronometer.shared.rpc.CronometerService|"
    "deleteRepeatItem|java.lang.String/2004016611|"
    "I|{nonce}|"
    "1|2|3|4|3|5|6|6|7|{user_id}|{repeat_item_id}|"
)

# US ordering (getAllMacroSchedules) to ISO ordering (saveMacroSchedule)
# getAllMacroSchedules: 0=Sun, 1=Mon, ..., 6=Sat
# saveMacroSchedule:   0=Mon, 1=Tue, ..., 6=Sun
_US_TO_ISO_DOW = {0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5}

EXPORT_TYPES = {
    "servings": "servings",
    "daily_summary": "dailySummary",
    "exercises": "exercises",
    "biometrics": "biometrics",
    "notes": "notes",
}


class CronometerClient:
    """Client for the Cronometer GWT-RPC API.

    Credentials are read from CRONOMETER_USERNAME and CRONOMETER_PASSWORD
    environment variables, or can be passed directly.
    """

    def __init__(
        self,
        username: str | None = None,
        password: str | None = None,
        gwt_permutation: str | None = None,
        gwt_header: str | None = None,
    ):
        self.username = username or os.environ.get("CRONOMETER_USERNAME", "")
        self.password = password or os.environ.get("CRONOMETER_PASSWORD", "")
        self.gwt_permutation = gwt_permutation or DEFAULT_GWT_PERMUTATION
        self.gwt_header = gwt_header or DEFAULT_GWT_HEADER

        if not self.username or not self.password:
            raise ValueError(
                "Cronometer credentials required. Set CRONOMETER_USERNAME and "
                "CRONOMETER_PASSWORD environment variables, or pass them directly."
            )

        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "cronometer-mcp/0.1"})
        self.nonce: str | None = None
        self.user_id: str | None = None
        self._authenticated = False
        self._cookie_path = Path(
            os.environ.get("CRONOMETER_DATA_DIR", Path.home() / ".local" / "share" / "cronometer-mcp")
        ) / ".session_cookies"

    def _get_anticsrf(self) -> str:
        """Step 1: Fetch the login page and extract the anti-CSRF token."""
        resp = self.session.get(LOGIN_HTML_URL)
        resp.raise_for_status()
        match = re.search(r'name="anticsrf"\s+value="([^"]+)"', resp.text)
        if not match:
            raise RuntimeError("Could not find anti-CSRF token on login page")
        return match.group(1)

    def _login(self, anticsrf: str) -> None:
        """Step 2: POST credentials to the login endpoint."""
        resp = self.session.post(
            LOGIN_API_URL,
            data={
                "anticsrf": anticsrf,
                "username": self.username,
                "password": self.password,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("error"):
            raise RuntimeError(f"Login failed: {result['error']}")
        if not (result.get("success") or result.get("redirect")):
            raise RuntimeError(f"Login failed: unexpected response {result}")

        # Extract sesnonce cookie
        self.nonce = self.session.cookies.get("sesnonce")
        if not self.nonce:
            raise RuntimeError("Login succeeded but no sesnonce cookie received")
        logger.info("Login successful")

    def _discover_gwt_hashes(self) -> None:
        """Discover current GWT permutation and header hashes.

        Fetches the GWT bootstrap JS to get the permutation hash, then
        fetches the compiled cache.js to extract the serialization policy
        hash (GWT header) for the 'app' endpoint.

        Falls back to the hardcoded defaults if discovery fails.
        """
        try:
            # Step 1: Get permutation hash from nocache.js
            resp = self.session.get(GWT_NOCACHE_JS_URL)
            resp.raise_for_status()
            perm_match = re.search(r"='([A-F0-9]{32})'", resp.text)
            if not perm_match:
                logger.warning("Could not extract permutation hash; using default")
                return
            permutation = perm_match.group(1)

            # Step 2: Get GWT header from the compiled cache.js
            cache_url = GWT_CACHE_JS_URL.replace("{permutation}", permutation)
            resp = self.session.get(cache_url)
            resp.raise_for_status()
            # The 'app' endpoint hash appears as: 'app','<32-HEX>'
            header_match = re.search(
                r"'app','([A-F0-9]{32})'", resp.text
            )
            if not header_match:
                logger.warning(
                    "Could not extract GWT header from cache.js; using default"
                )
                # Still update permutation even if header extraction fails
                self.gwt_permutation = permutation
                return

            self.gwt_permutation = permutation
            self.gwt_header = header_match.group(1)
            logger.info(
                "GWT hashes discovered: permutation=%s, header=%s",
                self.gwt_permutation,
                self.gwt_header,
            )
        except Exception:
            logger.warning(
                "GWT hash discovery failed; using defaults", exc_info=True
            )

    def _gwt_authenticate(self) -> None:
        """Step 3: GWT authentication to get user ID."""
        body = GWT_AUTHENTICATE.replace("{gwt_header}", self.gwt_header)
        resp = self.session.post(
            GWT_BASE_URL,
            data=body,
            headers={
                "content-type": DEFAULT_GWT_CONTENT_TYPE,
                "x-gwt-module-base": DEFAULT_GWT_MODULE_BASE,
                "x-gwt-permutation": self.gwt_permutation,
            },
        )
        resp.raise_for_status()

        match = re.search(r"OK\[(\d+),", resp.text)
        if not match:
            raise RuntimeError(
                f"GWT authenticate failed to extract user ID. "
                f"Response: {resp.text[:200]}"
            )
        self.user_id = match.group(1)

        # Update nonce from cookies
        new_nonce = self.session.cookies.get("sesnonce")
        if new_nonce:
            self.nonce = new_nonce
        logger.info("GWT auth successful, user_id=%s", self.user_id)

    def _generate_auth_token(self) -> str:
        """Step 4: Generate a short-lived auth token for export requests."""
        body = GWT_GENERATE_AUTH_TOKEN.replace("{gwt_header}", self.gwt_header)
        body = body.replace("{nonce}", self.nonce or "")
        body = body.replace("{user_id}", self.user_id or "")

        resp = self.session.post(
            GWT_BASE_URL,
            data=body,
            headers={
                "content-type": DEFAULT_GWT_CONTENT_TYPE,
                "x-gwt-module-base": DEFAULT_GWT_MODULE_BASE,
                "x-gwt-permutation": self.gwt_permutation,
            },
        )
        resp.raise_for_status()

        # MODIFIED (4): a GWT exception response starts //EX and still carries a
        # quoted string, so upstream's regex below would happily extract a fragment
        # of the exception text and return it as an auth token. Every later call
        # would then fail for a reason that had nothing to do with the real cause.
        # From upstream PR #2.
        if resp.text.startswith("//EX"):
            raise SessionExpiredError(
                f"Cronometer returned a GWT exception, so the session is not usable. "
                f"Response: {resp.text[:200]}"
            )

        match = re.search(r'"([^"]+)"', resp.text)
        if not match:
            raise RuntimeError(
                f"Failed to extract auth token. Response: {resp.text[:200]}"
            )
        token = match.group(1)
        logger.info("Auth token generated")
        return token

    # MODIFIED (2): from upstream PR #1, but deliberately NOT placed inside
    # `_gwt_post`. Fourteen account-changing methods route through that function,
    # so a retry there would re-send a write whose outcome is unknown — the one
    # thing this project promises it never does. Read call sites opt in instead.
    @staticmethod
    def _is_confirmed_empty(raw: str) -> bool:
        """Is this Cronometer saying "there are none of those"?

        MODIFIED (6): distinguishing this from "I cannot read the answer" matters,
        and getting it wrong in the cautious direction is still getting it wrong.
        An earlier pass flagged every empty result `unverified`, on the theory that
        a missing element-type marker might mean the format had changed. Checking
        the actual responses showed the opposite: an empty collection legitimately
        has no element type, because there are no elements to type. Three reads on a
        live account all returned exactly this, and all three were correct:

            //OK[0,1,["java.util.ArrayList/4159755760"],0,7]

        A flag that fires on every genuinely empty account is a flag nobody reads,
        so it has to fire only when the doubt is real.

        Two things must hold. The string table may name container types only — a
        domain type such as `biometrics.Biometric` means there IS content and the
        parser's failure to find it is a real problem. And the collection size, the
        first token in textual order, must be zero.
        """
        table = CronometerClient._extract_gwt_string_table(raw)
        if not all(entry.startswith("java.util.") for entry in table):
            return False
        tokens = CronometerClient._tokenize_gwt_data(raw, table)
        return bool(tokens) and tokens[0] == 0

    @staticmethod
    def _empty_or_unverified(raw: str) -> "UnverifiedEmpty | list":
        """Empty, and honest about which kind of empty it is."""
        return [] if CronometerClient._is_confirmed_empty(raw) else UnverifiedEmpty()

    def _discard_session(self) -> None:
        """Forget the session so the next call signs in from scratch.

        MODIFIED (12): split out of `_reauthenticate` so a rejected *write* can
        discard a dead session without retrying. Before this, only a read could
        reset it, and a write that met an expired session left `_authenticated`
        set: every later write failed the same way until a read happened by.
        """
        self._authenticated = False
        self.nonce = None
        self.user_id = None
        self.session.cookies.clear()
        self._cookie_path.unlink(missing_ok=True)

    def _reauthenticate(self) -> None:
        """Discard cached session state and sign in again."""
        logger.info("Session rejected; signing in again")
        self._discard_session()
        self.authenticate()

    # MODIFIED (5): upstream persisted the session with `pickle.dumps` and restored
    # it with `pickle.loads`. Unpickling executes whatever is in the file, so
    # anything able to write there gains code execution as the user — too much
    # authority for a cookie jar. SafeCronometerClient in live_bridge.py overrides
    # both with size-checked, field-validated JSON.
    #
    # These raise rather than being deleted. If a future change stops overriding
    # them, the failure should be immediate and obvious instead of silently
    # reintroducing an executable session file.
    def _save_session(self) -> None:
        raise NotImplementedError(
            "session persistence must be provided by SafeCronometerClient; "
            "the pickle-based implementation was deliberately removed"
        )

    def _restore_session(self) -> bool:
        raise NotImplementedError(
            "session restoration must be provided by SafeCronometerClient; "
            "the pickle-based implementation was deliberately removed"
        )

    def authenticate(self) -> None:
        """Full authentication flow: discover hashes, login, GWT auth."""
        if self._authenticated:
            return
        if self._restore_session():
            self._authenticated = True
            return
        self._discover_gwt_hashes()
        anticsrf = self._get_anticsrf()
        self._login(anticsrf)
        self._gwt_authenticate()
        self._authenticated = True
        self._save_session()

    def export_raw(
        self,
        export_type: str,
        start: date | None = None,
        end: date | None = None,
    ) -> str:
        """Export raw CSV data from Cronometer.

        Args:
            export_type: One of 'servings', 'daily_summary', 'exercises',
                        'biometrics', 'notes'.
            start: Start date (defaults to today).
            end: End date (defaults to today).

        Returns:
            Raw CSV text.
        """
        self.authenticate()

        if start is None:
            start = date.today()
        if end is None:
            end = date.today()

        # MODIFIED (2): an export is a read, so a refused session may be retried
        # once. From upstream PR #1, but scoped to this method rather than placed
        # in the shared POST path where writes would inherit it.
        try:
            return self._export_request(export_type, start, end)
        except SessionExpiredError:
            self._reauthenticate()
            return self._export_request(export_type, start, end)

    def _export_request(self, export_type: str, start: date, end: date) -> str:
        token = self._generate_auth_token()
        generate_value = EXPORT_TYPES.get(export_type, export_type)

        resp = self.session.get(
            EXPORT_URL,
            params={
                "nonce": token,
                "generate": generate_value,
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            },
            headers={
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-origin",
            },
        )
        if resp.status_code in (401, 403):
            raise SessionExpiredError(
                f"Cronometer refused the export with status {resp.status_code}"
            )
        resp.raise_for_status()

        # MODIFIED (7): Cronometer sends `Content-Type: text/csv` with no charset, so
        # requests falls back to ISO-8859-1 and every non-ASCII byte is mangled — the
        # micro sign arrives as 'Âµ', and any accented food name or emoji in a note is
        # corrupted the same way. The bytes are UTF-8; the exports are documented as
        # UTF-8; and five nutrient headers (B12, Folate, Vitamin A, Vitamin K,
        # Selenium) carry U+00B5, so without this they never match the nutrient table
        # and read as missing everywhere. Set rather than guessed: apparent_encoding
        # is content-dependent and would vary between exports.
        resp.encoding = "utf-8"
        return resp.text

    def export_parsed(
        self,
        export_type: str,
        start: date | None = None,
        end: date | None = None,
    ) -> list[dict]:
        """Export and parse CSV data into a list of dicts.

        Args:
            export_type: One of 'servings', 'daily_summary', 'exercises',
                        'biometrics', 'notes'.
            start: Start date (defaults to today).
            end: End date (defaults to today).

        Returns:
            List of dicts, one per CSV row.
        """
        raw = self.export_raw(export_type, start, end)
        reader = csv.DictReader(io.StringIO(raw))
        return list(reader)

    def _gwt_post(self, body: str) -> str:
        """POST a GWT-RPC payload and return the raw response text.

        MODIFIED (2): raises a typed error rather than a bare RuntimeError, and
        **never retries**. Fourteen account-changing methods reach Cronometer
        through here. Upstream PR #1 put an automatic retry in this function; a
        write that times out or is refused mid-flight has an unknown outcome, and
        re-sending it can duplicate a diary entry or delete the wrong record.

        Reads opt into a single retry by calling `_gwt_read` instead.
        """
        resp = self.session.post(
            GWT_BASE_URL,
            data=body,
            headers={
                "content-type": DEFAULT_GWT_CONTENT_TYPE,
                "x-gwt-module-base": DEFAULT_GWT_MODULE_BASE,
                "x-gwt-permutation": self.gwt_permutation,
            },
        )
        resp.raise_for_status()
        if not resp.text.startswith("//OK"):
            # MODIFIED (2): //EX is GWT's exception marker, and distinguishing it
            # lets a read retry once where everything else stays a plain failure.
            #
            # MODIFIED (10): but //EX covers two unrelated situations and only one is
            # worth retrying. IncompatibleRemoteServiceException means Cronometer has
            # changed or removed the method — permanent, and signing in again cannot
            # help. Treating it as an expired session, as this first did, bought a
            # pointless extra round trip on every affected read and reported "session
            # expired" for a fault with nothing to do with the session. Seen live for
            # findFoods and again for setDayComplete.
            if resp.text.startswith("//EX"):
                if "IncompatibleRemoteServiceException" in resp.text:
                    raise CronometerResponseError(
                        "Cronometer no longer provides this operation: the method has "
                        "been changed or removed on their side, so retrying will not "
                        f"help. Response: {resp.text[:300]}"
                    )
                # MODIFIED (12): the session is dead either way, so forget it here,
                # where reads and writes both pass. Nothing is re-sent — a write
                # still fails — but the next call signs in instead of reusing it.
                self._discard_session()
                raise SessionExpiredError(
                    "Cronometer rejected the call, most likely because the session "
                    "expired. The saved session was discarded, so the next call signs "
                    f"in again. Response: {resp.text[:300]}"
                )
            raise CronometerResponseError(
                f"GWT-RPC call failed. Response: {resp.text[:300]}"
            )
        return resp.text

    def _gwt_read(self, build_body: Callable[[], str]) -> str:
        """A read-only GWT call, which may re-authenticate once and try again.

        MODIFIED (2): deliberately separate from `_gwt_post`. Only read methods
        call this. A write must never land here — repeating a write whose outcome
        is unknown is the failure this project promises it does not have, and the
        separation is what makes that checkable rather than merely intended.

        MODIFIED (12): takes a body *builder*, not a body. Every GWT body embeds
        the session nonce, and signing in again replaces it, so a body built before
        the retry carried the dead nonce into it and the retry could not succeed.
        """
        try:
            return self._gwt_post(build_body())
        except SessionExpiredError:
            self._reauthenticate()
            return self._gwt_post(build_body())

    # MODIFIED (1): _parse_find_foods, the GWT wire-format parser for the removed
    # findFoods method, was deleted with it. Roughly 170 lines of string-table
    # decoding that can no longer be reached; _parse_food_search_hits replaces it.

    def find_foods(self, query: str, max_results: int = 50) -> list[dict]:
        """Search Cronometer's food database.

        Args:
            query: Search term.  The Cronometer web app uppercases queries
                   before sending; this method does the same automatically.
            max_results: Maximum number of results to return (default 50).

        Returns:
            List of dicts, each with keys:

            - ``food_id`` (int): Numeric food identifier.
            - ``food_source_id`` (int): Source database identifier (e.g. USDA).
            - ``name`` (str): Food name as stored in Cronometer.
            - ``measure_desc`` (str): Default measure description
              (e.g. ``"1 large - 50g"``).
            - ``score`` (int): Relevance score from the search engine.

        MODIFIED (1): Cronometer removed the GWT-RPC `findFoods` method. Calling it
        now returns IncompatibleRemoteServiceException ("This application is out of
        date"), which broke search and, with it, food logging — you cannot log a
        food without first finding its identifiers. The web app moved to the JSON
        endpoint used below. Same host, so the network allowlist is unchanged.

        The returned shape is deliberately identical to the old one so that
        get_food() and add_serving() need no changes.
        """
        self.authenticate()
        hits = self._food_search_request(query, max_results, allow_retry=True)
        return self._parse_food_search_hits(hits)

    def _food_search_request(
        self, query: str, max_results: int, *, allow_retry: bool
    ) -> object:
        """Search is a read, so a rejected session may be retried once."""
        if not self.user_id:
            raise CronometerResponseError("food search needs an authenticated user ID")

        params = {
            "query": query.upper(),
            "maxResults": max_results,
            "sources": "All",
            "categoryId": 0,
            "selectedTab": "ALL",
            "type": "All",
        }
        resp = self.session.get(FOOD_SEARCH_URL.format(user_id=self.user_id), params=params)

        if resp.status_code in (401, 403) and allow_retry:
            # A restored session can still be refused by this newer endpoint.
            self._reauthenticate()
            return self._food_search_request(query, max_results, allow_retry=False)

        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError as exc:
            # Deliberately without the body: it is untrusted text, and an error
            # message is a channel like any other.
            raise CronometerResponseError(
                "Cronometer food search returned a response that was not JSON"
            ) from exc

    @staticmethod
    def _parse_food_search_hits(hits: object) -> list[dict]:
        """Map the food-search JSON onto the long-standing result shape.

        Field mapping is the one upstream PR #6 verified against the old GWT
        parser: searching "Eggs, Cooked" produced id=464674 and measureId=1072101
        under both, which is what makes it safe to keep add_serving() unchanged.

        Every field is type-checked rather than coerced. A hit that does not carry
        what a caller needs is skipped, because a food entry built from a
        half-understood record would be logged against the wrong food.
        """
        if not isinstance(hits, list):
            raise UnrecognisedResponse(
                "Cronometer food search returned something other than a list of results"
            )

        foods: list[dict] = []
        for hit in hits:
            if not isinstance(hit, dict):
                continue

            food_id = hit.get("measureId")
            food_source_id = hit.get("id")
            name = hit.get("name") or hit.get("displayString")
            # `isinstance(True, int)` is True in Python, so booleans are excluded
            # explicitly; a True that became food_id 1 would log the wrong food.
            if (
                not isinstance(food_id, int)
                or isinstance(food_id, bool)
                or not isinstance(food_source_id, int)
                or isinstance(food_source_id, bool)
                or not isinstance(name, str)
                or not name
            ):
                continue

            score = hit.get("score", 0)
            if not isinstance(score, (int, float)) or isinstance(score, bool):
                score = 0

            measure_desc = hit.get("measureDisplayName")
            if not isinstance(measure_desc, str):
                measure_desc = ""

            foods.append(
                {
                    "food_id": food_id,
                    "food_source_id": food_source_id,
                    "name": name,
                    "measure_desc": measure_desc,
                    "score": score,
                }
            )
        return foods

    def get_food(self, food_source_id: int) -> dict:
        """Get detailed food information including available measures.

        Args:
            food_source_id: Food source ID from find_foods results.

        Returns:
            Dict with keys:

            - ``food_source_id`` (int): Echo of the input.
            - ``raw_response`` (str): Raw GWT-RPC response for debugging.
            - ``measures`` (list[dict]): Available serving measures, each with:
              - ``measure_id`` (int): Numeric ID needed by add_serving.
              - ``description`` (str): Human-readable description
                (e.g. ``"1 large - 50g"``).
              - ``weight_grams`` (float): Weight in grams for this measure.
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_FOOD
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{food_source_id}", str(food_source_id))
        ))
        return self._parse_get_food(raw, food_source_id)

    @staticmethod
    def _parse_get_food(raw: str, food_source_id: int) -> dict:
        """Parse a getFood GWT-RPC response to extract measure information.

        The response contains food metadata and a list of Measure objects.
        Each Measure has fields (reading backwards from the Measure type ref):

            i-6  description_ref (1-based string table index)
            i-5  flags (0)
            i-4  measure_id (integer, the key value needed by add_serving)
            i-3  food_source_id
            i-2  flags (0)
            i-1  quantity (1.0)
            i    <Measure type ref>

        Weight in grams is a float that appears earlier in the token stream,
        before the Measure$Type ref/back-ref for each measure.
        """
        result: dict = {
            "food_source_id": food_source_id,
            "measures": [],
        }

        if not raw.startswith("//OK[") or not raw.endswith(",0,7]"):
            return result

        # Extract string table
        closing = ",0,7]"
        st_close = len(raw) - len(closing) - 1
        depth, pos, in_str = 1, st_close - 1, False
        while pos >= 0 and depth > 0:
            ch = raw[pos]
            if ch == '"' and (pos == 0 or raw[pos - 1] != "\\"):
                in_str = not in_str
            elif not in_str:
                if ch == "]":
                    depth += 1
                elif ch == "[":
                    depth -= 1
            pos -= 1
        st_open = pos + 1
        string_table: list[str] = json.loads(raw[st_open : st_close + 1])

        def _resolve(ref: int) -> str | None:
            if 1 <= ref <= len(string_table):
                return string_table[ref - 1]
            return None

        # Find Measure class index in string table
        measure_type_idx: int | None = None
        for idx, entry in enumerate(string_table):
            if entry.startswith("["):
                continue
            if "Measure/" in entry and "Measure$" not in entry and "Derived" not in entry:
                if measure_type_idx is None:
                    measure_type_idx = idx + 1

        if measure_type_idx is None:
            return result

        # Tokenize data section — preserve floats
        data_section = raw[5:st_open].rstrip(",")
        if not data_section:
            return result

        tokens: list = []
        for part in data_section.split(","):
            part = part.strip()
            if not part:
                continue
            # Handle quoted strings (e.g. serving_id in Food metadata)
            if part.startswith('"') and part.endswith('"'):
                tokens.append(part)
                continue
            try:
                tokens.append(float(part) if "." in part else int(part))
            except ValueError:
                tokens.append(None)

        # Scan for Measure type-index occurrences and extract fields.
        measures = []
        for i, token in enumerate(tokens):
            if token != measure_type_idx:
                continue
            if i < 6:
                continue

            # Description ref is at i-6 for standard Measure layout, but
            # CRDB foods with a boxed Double field shift it to i-7 or i-8.
            # Scan multiple offsets to find a valid description string.
            description = ""
            description_offset: int | None = None
            for offset in (6, 7, 8):
                if i < offset:
                    continue
                ref = tokens[i - offset]
                if isinstance(ref, int) and 1 <= ref <= len(string_table):
                    candidate = string_table[ref - 1]
                    if (candidate
                            and not candidate.startswith("com.")
                            and not candidate.startswith("java.")
                            and not candidate.startswith("[")):
                        description = candidate
                        description_offset = offset
                        break

            # MODIFIED (8): upstream read the id from the fixed offset i-4, which is
            # a zero field in every response observed, so every measure came back
            # with measure_id 0. add_serving reads 0 as "use the universal gram
            # measure", so logging worked but recorded a gram weight instead of the
            # measure chosen — "1.01 fl oz" where the user asked for "1 fl oz".
            #
            # A measure record is a fixed ten-token block:
            #
            #   weight, -9, description, 0, measure_id, 0, food_source_id, 0, 1.0, marker
            #
            # so the id sits two positions after the description ref, not one. Taken
            # relative to wherever the description was found rather than from a fixed
            # offset, because the whole block shifts for CRDB foods — which is why the
            # description is already scanned across three offsets.
            measure_id_val = 0
            if description_offset is not None:
                candidate_id = tokens[i - (description_offset - 2)]
                # A real id is a large positive integer. Anything else means the
                # layout moved again; fall back to 0, which still logs correctly by
                # gram weight rather than logging against the wrong measure.
                if isinstance(candidate_id, int) and candidate_id > len(string_table):
                    measure_id_val = candidate_id

            # Find weight_grams: it's the float that appears before the
            # Measure$Type ref/back-ref, which is at i-7 or i-8.
            # Scan backwards from i-7 to find the first float.
            weight_grams = 0.0
            for j in range(i - 7, max(i - 12, -1), -1):
                if isinstance(tokens[j], float):
                    weight_grams = tokens[j]
                    break

            measures.append({
                "measure_id": measure_id_val,
                "description": description or "",
                "weight_grams": round(weight_grams, 2),
            })

        result["measures"] = measures
        return result

    def add_serving(
        self,
        food_id: int,
        food_source_id: int,
        measure_id: int,
        quantity: float,
        weight_grams: float,
        day: date,
        diary_group: int = 1,
    ) -> dict:
        """Add a food serving to the Cronometer diary.

        Args:
            food_id: Numeric food ID from Cronometer's food database.
            food_source_id: Food source ID (identifies the database the food
                           comes from, e.g. USDA, custom).
            measure_id: Measure/unit ID. Pass 0 to auto-select
                        UNIVERSAL_MEASURE_ID (124399). The diary_group is
                        encoded into the high 16 bits automatically.
            quantity: Serving quantity. When using UNIVERSAL_MEASURE_ID, set
                      this equal to weight_grams (since the measure is g-based).
            weight_grams: Weight of the serving in grams.
            day: Calendar date to log the entry against.
            diary_group: Meal slot — 1=Breakfast, 2=Lunch, 3=Dinner, 4=Snacks.

        Returns:
            Dict with keys:
                - serving_id (str): Opaque diary entry identifier (e.g. "D80lp$").
                - food_id (int): Echo of the food_id argument.
                - food_source_id (int): Echo of the food_source_id argument.
        """
        self.authenticate()

        if measure_id == 0:
            measure_id = UNIVERSAL_MEASURE_ID

        # Encode diary_group into the measure_id's high 16 bits.
        # The Cronometer server reads the diary group from this encoding:
        #   1=Breakfast, 2=Lunch, 3=Dinner, 4=Snacks.
        # Strip any existing group from the high bits, then apply the requested one.
        measure_base = measure_id & 0xFFFF
        encoded_measure = (diary_group << 16) | measure_base

        # Cronometer sends integer quantities without a decimal point
        quantity_str = _gwt_number(quantity)
        weight_str = _gwt_number(weight_grams)

        body = (
            GWT_UPDATE_DIARY
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{day}", str(day.day))
            .replace("{month}", str(day.month))
            .replace("{year}", str(day.year))
            .replace("{quantity}", quantity_str)
            .replace("{diary_group}", str(diary_group))
            .replace("{measure_id}", str(encoded_measure))
            .replace("{weight_grams}", weight_str)
            .replace("{food_source_id}", str(food_source_id))
            .replace("{food_id}", str(food_id))
        )

        raw = self._gwt_post(body)

        # Response format (example):
        # //OK[0,0,1072101,"D80lp$",464674,50.0,2107848,0,65541,0,1,1,2026,3,4,
        #      4,3,2,1,1,["java.util.ArrayList/...","com.cronometer..."],0,7]
        # Positional layout (0-indexed from the inner array start):
        #   index 3 → serving_id (quoted string)
        #   index 2 → food_id
        #   index 4 → food_source_id
        inner_match = re.search(r"//OK\[(.+),\d+,7\]$", raw, re.DOTALL)
        if not inner_match:
            raise RuntimeError(
                f"Unexpected updateDiary response format: {raw[:300]}"
            )

        inner = inner_match.group(1)
        # The response layout is:
        #   0,0,{food_id},"{serving_id}",{food_source_id},{weight},... ,[string_table],0,7
        # Match the first five meaningful fields directly from the full inner string.
        fields_match = re.match(
            r"\d+,\d+,(\d+),\"([^\"]+)\",(\d+),",
            inner,
        )
        if not fields_match:
            raise RuntimeError(
                f"Could not parse updateDiary response fields: {inner[:200]}"
            )

        return {
            "serving_id": fields_match.group(2),
            "food_id": int(fields_match.group(1)),
            "food_source_id": int(fields_match.group(3)),
        }

    def remove_serving(self, serving_id: str) -> bool:
        """Remove a serving entry from the Cronometer diary.

        Args:
            serving_id: Opaque diary entry identifier returned by add_serving
                        (e.g. "D80lp$").

        Returns:
            True on success.

        Raises:
            RuntimeError: If the server returns an error or an unexpected
                          response format.
        """
        self.authenticate()
        body = (
            GWT_REMOVE_SERVING
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{serving_id}", serving_id)
        )
        raw = self._gwt_post(body)
        # Success response: //OK[[],0,7]
        if "//OK" not in raw:
            raise RuntimeError(f"removeServing returned unexpected response: {raw[:200]}")
        logger.info("Removed serving %s", serving_id)
        return True

    def get_food_log(
        self,
        start: date | None = None,
        end: date | None = None,
    ) -> list[dict]:
        """Get detailed food log (servings) for a date range."""
        return self.export_parsed("servings", start, end)

    def get_daily_summary(
        self,
        start: date | None = None,
        end: date | None = None,
    ) -> list[dict]:
        """Get daily nutrition summary for a date range."""
        return self.export_parsed("daily_summary", start, end)

    # ── Macro target methods ──────────────────────────────────────────

    @staticmethod
    def _extract_gwt_string_table(raw: str) -> list[str]:
        """Extract the string table from a GWT-RPC //OK[...] response."""
        closing = ",0,7]"
        st_close = len(raw) - len(closing) - 1
        depth, pos, in_str = 1, st_close - 1, False
        while pos >= 0 and depth > 0:
            ch = raw[pos]
            if ch == '"' and (pos == 0 or raw[pos - 1] != "\\"):
                in_str = not in_str
            elif not in_str:
                if ch == "]":
                    depth += 1
                elif ch == "[":
                    depth -= 1
            pos -= 1
        st_open = pos + 1
        return json.loads(raw[st_open : st_close + 1])

    @staticmethod
    def _tokenize_gwt_data(raw: str, string_table: list[str]) -> list:
        """Tokenize the data section of a GWT-RPC response.

        Returns a list of int, float, or str tokens.
        """
        # Find the string table position to extract data before it
        closing = ",0,7]"
        st_close = len(raw) - len(closing) - 1
        depth, pos, in_str = 1, st_close - 1, False
        while pos >= 0 and depth > 0:
            ch = raw[pos]
            if ch == '"' and (pos == 0 or raw[pos - 1] != "\\"):
                in_str = not in_str
            elif not in_str:
                if ch == "]":
                    depth += 1
                elif ch == "[":
                    depth -= 1
            pos -= 1
        st_open = pos + 1

        data_section = raw[5:st_open].rstrip(",")
        if not data_section:
            return []

        tokens: list = []
        for part in data_section.split(","):
            part = part.strip()
            if not part:
                continue
            if part.startswith('"') and part.endswith('"'):
                tokens.append(part.strip('"'))
                continue
            try:
                tokens.append(float(part) if "." in part else int(part))
            except ValueError:
                tokens.append(None)
        return tokens

    @staticmethod
    def _parse_macro_target_template(raw: str) -> dict:
        """Parse a GWT-RPC response containing a single MacroTargetTemplate.

        Works for both getDailyMacroTargetTemplate and getMacroTargetTemplate
        responses. Extracts macro values by finding float tokens in the data.

        The float values appear in a fixed order (left to right):
        protein, fat, calories, carbs.

        Returns:
            Dict with keys: protein_g, fat_g, calories, carbs_g, template_name.
        """
        result = {
            "protein_g": 0.0,
            "fat_g": 0.0,
            "calories": 0.0,
            "carbs_g": 0.0,
            "template_name": "",
        }

        if not raw.startswith("//OK[") or not raw.endswith(",0,7]"):
            return result

        string_table = CronometerClient._extract_gwt_string_table(raw)

        # Template name = last non-class string in the string table
        for entry in reversed(string_table):
            if (
                not entry.startswith("com.")
                and not entry.startswith("java.")
                and not entry.startswith("[")
            ):
                result["template_name"] = entry
                break

        # Tokenize and extract float values
        tokens = CronometerClient._tokenize_gwt_data(raw, string_table)
        floats = [t for t in tokens if isinstance(t, float)]

        # In MacroTargetTemplate responses, floats appear in order:
        # protein, fat, calories, carbs
        if len(floats) >= 4:
            result["protein_g"] = floats[0]
            result["fat_g"] = floats[1]
            result["calories"] = floats[2]
            result["carbs_g"] = floats[3]

        return result

    @staticmethod
    def _parse_all_macro_schedules(raw: str) -> list[dict]:
        """Parse a GWT-RPC getAllMacroSchedules response.

        Returns a list of 7 dicts (one per day of week), each with:
        day_of_week (0=Sun..6=Sat), protein_g, fat_g, calories, carbs_g,
        template_name, template_id.

        GWT encoding note: The response contains 7 MacroSchedule objects
        in fixed-size blocks. Only the first block uses full type refs;
        subsequent blocks use GWT back-references (-N). The block size
        is determined by finding the first MacroSchedule type ref.
        Within each block, floats appear in order: protein, fat, calories,
        carbs. The day ordinal is the last token in each block (for block 0,
        the MacroSchedule type ref occupies that slot, so day 0 = Sunday
        is inferred).
        """
        _DOW_NAMES = [
            "Sunday", "Monday", "Tuesday", "Wednesday",
            "Thursday", "Friday", "Saturday",
        ]

        if not raw.startswith("//OK[") or not raw.endswith(",0,7]"):
            # MODIFIED (3): malformed or an error response; not an empty record.
            raise CronometerResponseError(
                f"Cronometer did not return a readable response: {raw[:200]}"
            )

        string_table = CronometerClient._extract_gwt_string_table(raw)
        tokens = CronometerClient._tokenize_gwt_data(raw, string_table)

        # Find MacroSchedule type index (1-based) in string table
        schedule_type_idx = None
        for idx, entry in enumerate(string_table):
            if "MacroSchedule/" in entry:
                schedule_type_idx = idx + 1
                break

        if schedule_type_idx is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        # Find the first occurrence of the MacroSchedule type ref to
        # determine block size. It appears at the END of the first block.
        first_sched_pos = None
        for i, token in enumerate(tokens):
            if token == schedule_type_idx:
                first_sched_pos = i
                break

        if first_sched_pos is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        block_size = first_sched_pos + 1  # block 0 spans tokens 0..first_sched_pos

        # Template name(s) — non-class strings in the string table.
        # Also handle negative back-refs (e.g., -6 → string_table[5]).
        template_names = {}
        for idx, entry in enumerate(string_table):
            if (
                not entry.startswith("com.")
                and not entry.startswith("java.")
                and not entry.startswith("[")
            ):
                template_names[idx + 1] = entry      # positive ref
                template_names[-(idx + 1)] = entry    # negative back-ref

        # Extract 7 blocks and determine day ordinals.
        # GWT serialization varies between Cronometer versions:
        # - Some versions put the ordinal at block[-4] (before type refs)
        # - Others put it at block[-1] (after back-refs)
        # Strategy: try block[-4] first; if values aren't unique 0-6, try block[-1].
        blocks = []
        for block_idx in range(7):
            start = block_idx * block_size
            end = start + block_size
            if end > len(tokens):
                break
            blocks.append(tokens[start:end])

        # Try block[-4] for day ordinals
        ordinals_m4 = [b[-4] if len(b) >= 4 and isinstance(b[-4], int) else -1 for b in blocks]
        ordinals_m1 = [b[-1] if len(b) >= 1 and isinstance(b[-1], int) else -1 for b in blocks]

        if set(ordinals_m4) == set(range(7)):
            ordinals = ordinals_m4
        else:
            # block[-1] has ordinals for blocks 1-6; block 0's [-1] is
            # the MacroSchedule type ref (a duplicate value). Detect the
            # duplicate and replace it with the missing ordinal.
            ordinals = list(ordinals_m1)
            seen: dict[int, list[int]] = {}
            for i, v in enumerate(ordinals):
                seen.setdefault(v, []).append(i)
            missing = set(range(7)) - set(ordinals)
            if missing:
                missing_val = missing.pop()
                # Find the duplicate value — the one that appears twice
                for val, indices in seen.items():
                    if len(indices) > 1:
                        # The first occurrence (block 0) is the bogus one
                        ordinals[indices[0]] = missing_val
                        break
            # Fallback: if still not unique, assign sequentially
            if set(ordinals) != set(range(7)):
                ordinals = list(range(7))

        schedules = []
        for block_idx, block in enumerate(blocks):
            dow_ordinal = ordinals[block_idx]

            template_data = {
                "day_of_week": dow_ordinal,
                "day_name": _DOW_NAMES[dow_ordinal] if 0 <= dow_ordinal < 7 else f"Day {dow_ordinal}",
                "protein_g": 0.0,
                "fat_g": 0.0,
                "calories": 0.0,
                "carbs_g": 0.0,
                "template_name": "",
                "template_id": 0,
            }

            # Extract floats from this block → [protein, fat, calories, carbs]
            floats = [t for t in block if isinstance(t, float)]
            if len(floats) >= 4:
                template_data["protein_g"] = floats[0]
                template_data["fat_g"] = floats[1]
                template_data["calories"] = floats[2]
                template_data["carbs_g"] = floats[3]

            # Template name: look for string refs (positive or negative)
            for t in block:
                if isinstance(t, int) and t in template_names:
                    template_data["template_name"] = template_names[t]

            # Template ID: large integer (> string table size) in the block
            for t in block:
                if isinstance(t, int) and t > len(string_table):
                    template_data["template_id"] = t
                    break

            schedules.append(template_data)

        # Sort by day_of_week
        schedules.sort(key=lambda x: x["day_of_week"])
        return schedules

    def get_all_macro_schedules(self) -> list[dict]:
        """Get the weekly macro target schedule (all 7 days).

        Returns:
            List of 7 dicts, one per day of week, each containing:
            - day_of_week (int): 0=Sunday through 6=Saturday
            - day_name (str): Human-readable day name
            - protein_g (float): Protein target in grams
            - fat_g (float): Fat target in grams
            - calories (float): Calorie target
            - carbs_g (float): Net carbs target in grams
            - template_name (str): Name of the assigned template
            - template_id (int): Template ID (0 for custom)
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_ALL_MACRO_SCHEDULES
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
        ))
        return self._parse_all_macro_schedules(raw)

    def get_daily_macro_targets(self, day: date | None = None) -> dict:
        """Get the effective macro targets for a specific date.

        Args:
            day: Target date (defaults to today).

        Returns:
            Dict with keys: protein_g, fat_g, calories, carbs_g,
            template_name.
        """
        self.authenticate()
        if day is None:
            day = date.today()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_DAILY_MACRO_TARGET_TEMPLATE
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{day}", str(day.day))
            .replace("{month}", str(day.month))
            .replace("{year}", str(day.year))
        ))
        return self._parse_macro_target_template(raw)

    def update_daily_targets(
        self,
        day: date,
        protein_g: float,
        fat_g: float,
        carbs_g: float,
        calories: float,
        template_name: str = "Custom Targets",
    ) -> bool:
        """Update macro targets for a specific date.

        Args:
            day: Target date.
            protein_g: Protein target in grams.
            fat_g: Fat target in grams.
            carbs_g: Net carbs target in grams.
            calories: Calorie target.
            template_name: Template name (default "Custom Targets").

        Returns:
            True on success.
        """
        self.authenticate()

        body = (
            GWT_UPDATE_DAILY_TARGET_TEMPLATE
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{template_name}", template_name)
            .replace("{day}", str(day.day))
            .replace("{month}", str(day.month))
            .replace("{year}", str(day.year))
            .replace("{protein}", _gwt_number(protein_g))
            .replace("{fat}", _gwt_number(fat_g))
            .replace("{carbs}", _gwt_number(carbs_g))
            .replace("{calories}", _gwt_number(calories))
        )
        raw = self._gwt_post(body)
        # Success: //OK[1,2,1,["...ResponseEvent...","Success"],0,7]
        if "Success" in raw:
            logger.info(
                "Updated daily targets for %s: protein=%.1fg, fat=%.1fg, "
                "carbs=%.1fg, calories=%.0f",
                day, protein_g, fat_g, carbs_g, calories,
            )
            return True
        raise RuntimeError(
            f"updateDailyTargetTemplate failed: {raw[:300]}"
        )

    def get_macro_target_templates(self) -> list[dict]:
        """Get all saved macro target templates.

        Returns:
            List of dicts with keys: template_id, template_name,
            protein_g, fat_g, calories, carbs_g.
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_MACRO_TARGET_TEMPLATES
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
        ))
        return self._parse_macro_target_templates(raw)

    @staticmethod
    def _parse_macro_target_templates(raw: str) -> list[dict]:
        """Parse getMacroTargetTemplates GWT response.

        Returns list of template dicts with id, name, and macro values.
        """
        if not raw.startswith("//OK["):
            # MODIFIED (3): not an //OK response, so this is an error or a GWT
            # exception. Upstream returned [] here, which is how a failed call
            # came back as "you have no data".
            raise CronometerResponseError(
                f"Cronometer did not return a readable response: {raw[:200]}"
            )

        string_table = CronometerClient._extract_gwt_string_table(raw)
        tokens = CronometerClient._tokenize_gwt_data(raw, string_table)

        # Find MacroTargetTemplate type index
        template_type_idx = None
        for idx, entry in enumerate(string_table):
            if "MacroTargetTemplate/" in entry:
                template_type_idx = idx + 1
                break

        if template_type_idx is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        # Find block boundaries by locating each template type ref
        # or back-reference. First occurrence is the type ref,
        # subsequent are back-refs (negative).
        first_pos = None
        for i, token in enumerate(tokens):
            if token == template_type_idx:
                first_pos = i
                break

        if first_pos is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        block_size = first_pos + 1

        # Extract template names from string table
        template_name_map = {}
        for idx, entry in enumerate(string_table):
            if (
                not entry.startswith("com.")
                and not entry.startswith("java.")
                and not entry.startswith("[")
            ):
                template_name_map[idx + 1] = entry
                template_name_map[-(idx + 1)] = entry

        templates = []
        block_idx = 0
        while True:
            start = block_idx * block_size
            end = start + block_size
            if end > len(tokens):
                break

            block = tokens[start:end]

            # Extract floats: [protein, fat, calories, carbs]
            floats = [t for t in block if isinstance(t, float)]

            # Extract template name
            name = ""
            for t in block:
                if isinstance(t, int) and t in template_name_map:
                    name = template_name_map[t]

            # Extract template ID: large int > string table size
            template_id = 0
            for t in block:
                if isinstance(t, int) and t > len(string_table):
                    template_id = t
                    break

            if len(floats) >= 4:
                templates.append({
                    "template_id": template_id,
                    "template_name": name,
                    "protein_g": floats[0],
                    "fat_g": floats[1],
                    "calories": floats[2],
                    "carbs_g": floats[3],
                })

            block_idx += 1

        return templates

    def save_macro_schedule(
        self,
        day_of_week_us: int,
        template_id: int,
    ) -> bool:
        """Assign a macro template to a day of the week in the schedule.

        Args:
            day_of_week_us: Day of week in US ordering (0=Sunday, 6=Saturday).
            template_id: Template ID from get_macro_target_templates().
                         Use 0 for the default profile targets.

        Returns:
            True on success.
        """
        self.authenticate()

        # Convert US ordering (0=Sun) to ISO ordering (0=Mon) for the API
        iso_dow = _US_TO_ISO_DOW[day_of_week_us]

        body = (
            GWT_SAVE_MACRO_SCHEDULE
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{day_of_week}", str(iso_dow))
            .replace("{template_id}", str(template_id))
        )
        raw = self._gwt_post(body)
        if "//OK" in raw:
            logger.info(
                "Set macro schedule: day_of_week=%d (US) -> %d (ISO), "
                "template_id=%d",
                day_of_week_us, iso_dow, template_id,
            )
            return True
        raise RuntimeError(
            f"saveMacroSchedule failed: {raw[:300]}"
        )

    def save_macro_target_template(
        self,
        template_name: str,
        protein_g: float,
        fat_g: float,
        carbs_g: float,
        calories: float,
    ) -> int:
        """Create a new saved macro target template.

        Args:
            template_name: Name for the template.
            protein_g: Protein target in grams.
            fat_g: Fat target in grams.
            carbs_g: Net carbs target in grams.
            calories: Calorie target.

        Returns:
            The template_id assigned by the server.
        """
        self.authenticate()


        # Build the GWT-RPC payload dynamically because the fat field
        # uses object back-references when fat == carbs (GWT optimization).
        # String table positions (1-indexed):
        #  1=module, 2=gwt_header, 3=service, 4=method, 5=String type,
        #  6=I type, 7=MacroTargetTemplate type, 8=nonce, 9=Boolean type,
        #  10=Double type, 11=Integer type, 12=Rigorous, 13=template_name
        carbs_str = _gwt_number(carbs_g)
        fat_str = _gwt_number(fat_g)
        cal_str = _gwt_number(calories)
        protein_str = _gwt_number(protein_g)

        if fat_g == carbs_g:
            # Fat equals carbs: use back-reference -3 (refers to
            # the Double object at position 3 in the object stream)
            fat_token = "-3"
        else:
            # Fat differs: encode explicitly
            fat_token = f"10|{fat_str}"

        # The data section encodes the MacroTargetTemplate fields.
        # Field order: boolean, carbs, fat, null, calories,
        #   [extra fields], template_id(0=new), program("Rigorous"),
        #   null, template_name, protein, [trailing ref]
        #
        # When fat==carbs, trailing back-refs like -6 refer to
        # Double(calories). When fat!=carbs, the object positions
        # shift so we use explicit values instead.
        if fat_g == carbs_g:
            data = (
                f"8|{self.user_id}|"
                f"7|9|0|10|{carbs_str}|-3|0|10|{cal_str}|-3|-3|0|"
                f"11|0|12|0|13|10|{protein_str}|-6|"
            )
        else:
            data = (
                f"8|{self.user_id}|"
                f"7|9|0|10|{carbs_str}|10|{fat_str}|0|10|{cal_str}|"
                f"10|{fat_str}|10|{fat_str}|0|"
                f"11|0|12|0|13|10|{protein_str}|10|{cal_str}|"
            )

        header = (
            "7|0|13|https://cronometer.com/cronometer/|"
            f"{self.gwt_header}|"
            "com.cronometer.shared.rpc.CronometerService|"
            "saveMacroTargetTemplate|java.lang.String/2004016611|"
            "I|com.cronometer.shared.targets.models.MacroTargetTemplate/"
            "3691130822|"
            f"{self.nonce or ''}|"
            "java.lang.Boolean/476441737|"
            "java.lang.Double/858496421|"
            "java.lang.Integer/3438268394|"
            "Rigorous|"
            f"{template_name}|"
            "1|2|3|4|3|5|6|7|"
        )

        body = header + data
        raw = self._gwt_post(body)

        if "//OK" not in raw:
            raise RuntimeError(
                f"saveMacroTargetTemplate failed: {raw[:300]}"
            )

        logger.info(
            "Created macro target template '%s': protein=%.1fg, "
            "fat=%.1fg, carbs=%.1fg, calories=%.0f",
            template_name, protein_g, fat_g, carbs_g, calories,
        )

        # Fetch templates to get the server-assigned template_id
        templates = self.get_macro_target_templates()
        for t in templates:
            if t["template_name"] == template_name:
                return t["template_id"]

        # Template was created but not found — return 0 as fallback
        logger.warning(
            "Template '%s' created but not found in template list",
            template_name,
        )
        return 0

    def delete_macro_target_template(self, template_id: int) -> bool:
        """Delete a saved macro target template.

        Args:
            template_id: Template ID to delete.

        Returns:
            True on success.
        """
        self.authenticate()
        body = (
            GWT_DELETE_MACRO_TARGET_TEMPLATE
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{template_id}", str(template_id))
        )
        raw = self._gwt_post(body)
        if "//OK" in raw:
            logger.info("Deleted macro target template: id=%d", template_id)
            return True
        raise RuntimeError(
            f"deleteMacroTargetTemplate failed: {raw[:300]}"
        )

    # --- Fasting methods ---

    def get_user_fasts(self) -> list[dict]:
        """Get all fasting history.

        Returns:
            List of fast dicts with keys: fast_id, recurrence_id, name,
            recurrence_rule, start_ts, end_ts, notes, is_active.
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_USER_FASTS
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
        ))
        return self._parse_fasts(raw)

    def get_user_fasts_for_range(
        self, start: date, end: date,
    ) -> list[dict]:
        """Get fasts for a specific date range.

        Args:
            start: Start date.
            end: End date.

        Returns:
            List of fast dicts.
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_USER_FASTS_FOR_RANGE
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{start_day}", str(start.day))
            .replace("{start_month}", str(start.month))
            .replace("{start_year}", str(start.year))
            .replace("{end_day}", str(end.day))
            .replace("{end_month}", str(end.month))
            .replace("{end_year}", str(end.year))
        ))
        return self._parse_fasts(raw)

    def get_fasting_stats(self) -> dict:
        """Get aggregate fasting statistics.

        Returns:
            Dict with keys: total_hours, longest_fast_hours,
            seven_fast_avg_hours, completed_count.
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_FASTING_STATS
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
        ))
        return self._parse_fasting_stats(raw)

    def delete_fast(self, fast_id: int) -> bool:
        """Delete a fast entry.

        Args:
            fast_id: Fast ID to delete.

        Returns:
            True on success.
        """
        self.authenticate()
        body = (
            GWT_DELETE_FAST
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{fast_id}", str(fast_id))
        )
        raw = self._gwt_post(body)
        if "//OK" in raw:
            logger.info("Deleted fast: id=%d", fast_id)
            return True
        raise RuntimeError(f"deleteFast failed: {raw[:300]}")

    def cancel_fast_keep_series(self, fast_id: int) -> bool:
        """Cancel an active fast while preserving the recurring schedule.

        Args:
            fast_id: The recurrence/fast ID of the active fast.

        Returns:
            True on success.
        """
        self.authenticate()
        body = (
            GWT_CANCEL_FAST_KEEP_SERIES
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{fast_id}", str(fast_id))
        )
        raw = self._gwt_post(body)
        if "//OK" in raw:
            logger.info("Cancelled fast (kept series): id=%d", fast_id)
            return True
        raise RuntimeError(
            f"cancelFastAndKeepSeries failed: {raw[:300]}"
        )

    @staticmethod
    def _parse_fasting_stats(raw: str) -> dict:
        """Parse getFastingStats GWT response.

        Response format:
        //OK[{totalHours},{longestFast},{sevenFastAvg},{completedCount},
             1,[...string table...],0,7]
        """
        if not raw.startswith("//OK["):
            # MODIFIED (3): see above; upstream returned {} here.
            raise CronometerResponseError(
                f"Cronometer did not return a readable response: {raw[:200]}"
            )

        string_table = CronometerClient._extract_gwt_string_table(raw)
        tokens = CronometerClient._tokenize_gwt_data(raw, string_table)

        floats = [t for t in tokens if isinstance(t, float)]
        ints = [t for t in tokens if isinstance(t, int)]

        result = {
            "total_hours": 0.0,
            "longest_fast_hours": 0.0,
            "seven_fast_avg_hours": 0.0,
            "completed_count": 0,
        }

        if len(floats) >= 3:
            result["total_hours"] = round(floats[0], 1)
            result["longest_fast_hours"] = round(floats[1], 1)
            result["seven_fast_avg_hours"] = round(floats[2], 1)

        # completed_count is typically the first large-ish int
        # (after string table refs which are small)
        for val in ints:
            if val > len(string_table) and val < 100000:
                result["completed_count"] = val
                break

        return result

    @staticmethod
    def _parse_fasts(raw: str) -> list[dict]:
        """Parse getUserFasts or getUserFastsForRange GWT response.

        Extracts Fast objects from the GWT-RPC response. Each Fast has:
        - fast_id (int)
        - recurrence_id (int)
        - name (str)
        - recurrence_rule (str, e.g. "FREQ=WEEKLY")
        - start_ts (str, base62 timestamp)
        - end_ts (str, base62 timestamp or "0")
        - is_active (bool, True if end_ts is "0" or empty)
        """
        if not raw.startswith("//OK["):
            # MODIFIED (3): not an //OK response, so this is an error or a GWT
            # exception. Upstream returned [] here, which is how a failed call
            # came back as "you have no data".
            raise CronometerResponseError(
                f"Cronometer did not return a readable response: {raw[:200]}"
            )

        string_table = CronometerClient._extract_gwt_string_table(raw)
        tokens = CronometerClient._tokenize_gwt_data(raw, string_table)

        # Find the Fast type in string table
        fast_type_idx = None
        for idx, entry in enumerate(string_table):
            if "fasting.Fast/" in entry and "[L" not in entry:
                fast_type_idx = idx + 1
                break

        if fast_type_idx is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        # Find FastingRecurrance type
        recurrence_type_idx = None
        for idx, entry in enumerate(string_table):
            if "FastingRecurrance/" in entry:
                recurrence_type_idx = idx + 1
                break

        # Extract meaningful strings (fast names, recurrence rules, notes)
        meaningful_strings = {}
        for idx, entry in enumerate(string_table):
            if (
                not entry.startswith("com.")
                and not entry.startswith("java.")
                and not entry.startswith("[")
            ):
                meaningful_strings[idx + 1] = entry
                meaningful_strings[-(idx + 1)] = entry

        # Find the first Fast type ref to determine block size
        first_fast_pos = None
        for i, token in enumerate(tokens):
            if token == fast_type_idx:
                first_fast_pos = i
                break

        if first_fast_pos is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        block_size = first_fast_pos + 1

        # Extract blocks
        fasts = []
        block_idx = 0
        while True:
            start = block_idx * block_size
            end = start + block_size
            if end > len(tokens):
                break

            block = tokens[start:end]

            # Extract strings from this block (fast name, recurrence rule,
            # notes). Strings are referenced by string table index.
            block_strings = []
            for t in block:
                if isinstance(t, str):
                    block_strings.append(t)
                elif isinstance(t, int) and t in meaningful_strings:
                    block_strings.append(meaningful_strings[t])
                elif isinstance(t, int) and t < 0 and t in meaningful_strings:
                    block_strings.append(meaningful_strings[t])

            # Extract large ints (fast_id, recurrence_id)
            large_ints = [
                t for t in block
                if isinstance(t, int)
                and abs(t) > len(string_table)
                and abs(t) < 10**9
            ]

            # Extract quoted strings (base62 timestamps)
            quoted_strings = [t for t in block if isinstance(t, str)]

            # Build fast dict
            fast = {
                "fast_id": large_ints[0] if len(large_ints) >= 1 else 0,
                "recurrence_id": large_ints[1] if len(large_ints) >= 2 else 0,
                "name": "",
                "recurrence_rule": "",
                "start_ts": "",
                "end_ts": "",
                "is_active": False,
            }

            # Assign strings heuristically
            for s in block_strings:
                if s.startswith("FREQ="):
                    fast["recurrence_rule"] = s
                elif any(c.isalpha() and c.isupper() for c in s) and len(s) < 10 and s != "0":
                    # Likely a base62 timestamp
                    if not fast["start_ts"]:
                        fast["start_ts"] = s
                    else:
                        fast["end_ts"] = s
                elif len(s) > 3:
                    # Likely a name or note
                    if not fast["name"]:
                        fast["name"] = s
                    # Additional strings could be notes

            # Timestamps from quoted strings in the block
            for s in quoted_strings:
                if s and s != "0" and len(s) >= 5:
                    if not fast["start_ts"]:
                        fast["start_ts"] = s
                    elif not fast["end_ts"]:
                        fast["end_ts"] = s

            fast["is_active"] = fast["end_ts"] in ("", "0")

            if fast["fast_id"] or fast["name"]:
                fasts.append(fast)

            block_idx += 1

        return fasts

    # --- Biometric methods ---

    def get_recent_biometrics(self) -> list[dict]:
        """Get the most recently logged biometric entries.

        Returns:
            List of dicts with keys: biometric_id, metric_id, value,
            date, metric_name (if available).
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_RECENT_BIOMETRICS
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
        ))
        return self._parse_recent_biometrics(raw)

    def add_biometric(
        self,
        metric_type: str,
        value: float,
        day: date,
    ) -> str:
        """Add a biometric entry.

        Args:
            metric_type: One of 'weight', 'blood_glucose', 'heart_rate',
                         'body_fat'.
            value: The value in display units (lbs, mg/dL, bpm, %).
            day: Date for the entry.

        Returns:
            The biometric entry ID (string).
        """
        self.authenticate()

        # MODIFIED (9): refuse the metrics whose encoding is known to mis-file,
        # rather than writing them to the wrong place and reporting success.
        if metric_type not in _SUPPORTED_BIOMETRICS:
            raise ValueError(
                f"'{metric_type}' cannot be written correctly. Cronometer's metric "
                f"encoding for it is unverified, and testing showed such entries are "
                f"filed under the wrong metric — a heart rate of 60 was recorded as a "
                f"weight of 60 lbs. Only {sorted(_SUPPORTED_BIOMETRICS)} is supported; "
                f"record anything else in the Cronometer app."
            )

        info = _BIOMETRIC_TYPES[metric_type]


        body = (
            GWT_ADD_BIOMETRIC
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{value}", _gwt_number(value))
            .replace("{day}", str(day.day))
            .replace("{month}", str(day.month))
            .replace("{year}", str(day.year))
            .replace("{flags}", str(info["flags"]))
            .replace("{metric_position}", str(info["metric_position"]))
        )
        raw = self._gwt_post(body)

        if "//OK" not in raw:
            raise RuntimeError(f"addBiometric failed: {raw[:300]}")

        # Extract biometric ID from response: //OK["BXW0DA",[],0,7]
        biometric_id = ""
        if raw.startswith("//OK["):
            import re
            match = re.search(r'"([A-Za-z0-9]+)"', raw)
            if match:
                biometric_id = match.group(1)

        logger.info(
            "Added biometric: type=%s, value=%.1f, date=%s, id=%s",
            metric_type, value, day, biometric_id,
        )
        return biometric_id

    def remove_biometric(self, biometric_id: str) -> bool:
        """Remove a biometric entry.

        Args:
            biometric_id: The biometric entry ID (e.g. "BXW0DA").

        Returns:
            True on success.
        """
        self.authenticate()
        body = (
            GWT_REMOVE_MEASUREMENT
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{biometric_id}", biometric_id)
        )
        raw = self._gwt_post(body)
        if "//OK" in raw:
            logger.info("Removed biometric: id=%s", biometric_id)
            return True
        raise RuntimeError(f"removeMeasurement failed: {raw[:300]}")

    def _parse_recent_biometrics(self, raw: str) -> list[dict]:
        """Parse getRecentBiometrics GWT response.

        Returns list of biometric entries with id, metric_id, value, date.
        """
        if not raw.startswith("//OK["):
            # MODIFIED (3): not an //OK response, so this is an error or a GWT
            # exception. Upstream returned [] here, which is how a failed call
            # came back as "you have no data".
            raise CronometerResponseError(
                f"Cronometer did not return a readable response: {raw[:200]}"
            )

        string_table = CronometerClient._extract_gwt_string_table(raw)
        tokens = CronometerClient._tokenize_gwt_data(raw, string_table)

        # Find the Biometric type in string table
        bio_type_idx = None
        for idx, entry in enumerate(string_table):
            if "biometrics.Biometric/" in entry and "[L" not in entry:
                bio_type_idx = idx + 1
                break

        if bio_type_idx is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        # Find Day type
        day_type_idx = None
        for idx, entry in enumerate(string_table):
            if "models.Day/" in entry:
                day_type_idx = idx + 1
                break

        # Find first Biometric type ref to determine block size
        first_bio_pos = None
        for i, token in enumerate(tokens):
            if token == bio_type_idx:
                first_bio_pos = i
                break

        if first_bio_pos is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        block_size = first_bio_pos + 1

        # Extract meaningful strings (biometric IDs, composite JSON, etc.)
        meaningful_strings = {}
        for idx, entry in enumerate(string_table):
            if (
                not entry.startswith("com.")
                and not entry.startswith("java.")
                and not entry.startswith("[")
            ):
                meaningful_strings[idx + 1] = entry
                meaningful_strings[-(idx + 1)] = entry

        biometrics = []
        block_idx = 0
        while True:
            start = block_idx * block_size
            end = start + block_size
            if end > len(tokens):
                break

            block = tokens[start:end]

            # Extract floats (biometric value)
            floats = [t for t in block if isinstance(t, float)]

            # Extract strings (biometric ID, composite JSON)
            block_strings = []
            for t in block:
                if isinstance(t, str):
                    block_strings.append(t)
                elif isinstance(t, int) and t in meaningful_strings:
                    block_strings.append(meaningful_strings[t])

            # Extract large ints (metric_id, user_id, flags)
            large_ints = [
                t for t in block
                if isinstance(t, int)
                and abs(t) > len(string_table)
            ]

            # Build entry
            entry = {
                "biometric_id": "",
                "value": floats[0] if floats else 0.0,
                "metric_id": 0,
                "date": "",
            }

            # Biometric IDs are short alphanumeric strings (6-8 chars)
            for s in block_strings:
                if (
                    len(s) >= 4 and len(s) <= 12
                    and s.isalnum()
                    and not s.startswith("com")
                ):
                    entry["biometric_id"] = s
                elif s.startswith("{"):
                    # Composite JSON (blood pressure, etc.)
                    entry["composite"] = s

            # Extract date: look for 3 consecutive small ints that
            # could be day/month/year
            for i in range(len(block) - 2):
                if (
                    isinstance(block[i], int)
                    and isinstance(block[i + 1], int)
                    and isinstance(block[i + 2], int)
                    and 1 <= block[i] <= 31
                    and 1 <= block[i + 1] <= 12
                    and 2020 <= block[i + 2] <= 2030
                ):
                    entry["date"] = (
                        f"{block[i + 2]:04d}-{block[i + 1]:02d}-"
                        f"{block[i]:02d}"
                    )
                    break

            # metric_id is typically in the large_ints
            for val in large_ints:
                if val < 100000 and val != int(self.user_id or 0):
                    entry["metric_id"] = val
                    break

            if entry["biometric_id"] or entry["value"]:
                biometrics.append(entry)

            block_idx += 1

        return biometrics

    # ── Diary operations ──────────────────────────────────────────────

    def copy_day(self, src: date, dst: date) -> bool:
        """Copy all diary entries from one date to another.

        This is a server-side operation that copies ALL entries
        (food, exercise, notes, biometrics) from src to dst. It is
        additive — existing entries on dst are not removed.

        Args:
            src: Source date to copy from.
            dst: Destination date to copy to.

        Returns:
            True on success.
        """
        self.authenticate()
        body = (
            GWT_COPY_DAY
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{src_day}", str(src.day))
            .replace("{src_month}", str(src.month))
            .replace("{src_year}", str(src.year))
            .replace("{dst_day}", str(dst.day))
            .replace("{dst_month}", str(dst.month))
            .replace("{dst_year}", str(dst.year))
        )
        raw = self._gwt_post(body)
        if not raw.startswith("//OK"):
            raise RuntimeError(f"copyDay failed: {raw[:300]}")
        return True

    def set_day_complete(self, day: date, complete: bool = True) -> bool:
        """Mark a diary day as complete or incomplete.

        Args:
            day: The date to mark.
            complete: True to mark complete, False to mark incomplete.

        Returns:
            True on success.
        """
        self.authenticate()
        body = (
            GWT_SET_DAY_COMPLETE
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{day}", str(day.day))
            .replace("{month}", str(day.month))
            .replace("{year}", str(day.year))
            .replace("{complete}", "1" if complete else "0")
        )
        raw = self._gwt_post(body)
        if not raw.startswith("//OK"):
            raise RuntimeError(f"setDayComplete failed: {raw[:300]}")
        return True

    # ── Repeat item methods ───────────────────────────────────────────

    def get_repeated_items(self) -> list[dict]:
        """Get all recurring food entries.

        Returns:
            List of repeat item dicts with keys: repeat_item_id,
            food_name, food_source_id, measure_id, quantity,
            diary_group, days_of_week.
        """
        self.authenticate()
        # Built lazily: after a re-login the retry needs the new nonce.
        raw = self._gwt_read(lambda: (
            GWT_GET_REPEATED_ITEMS
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
        ))
        return self._parse_repeated_items(raw)

    def add_repeat_item(
        self,
        food_source_id: int,
        food_id: int,
        quantity: float,
        food_name: str,
        diary_group: int = 1,
        days_of_week: list[int] | None = None,
    ) -> bool:
        """Add a recurring food entry.

        Args:
            food_source_id: Food source ID from search_foods.
            food_id: Food ID from search_foods.
            quantity: Number of default servings (e.g., 12 cups of coffee).
            food_name: Display name for the food.
            diary_group: Meal slot — 1=Breakfast, 2=Lunch, 3=Dinner, 4=Snacks.
            days_of_week: List of days (0=Sun, 1=Mon, ..., 6=Sat).
                          Defaults to all 7 days.

        Returns:
            True on success.
        """
        self.authenticate()

        if days_of_week is None:
            days_of_week = [0, 1, 2, 3, 4, 5, 6]

        # Build day entries: "10|{day}" for each day, joined by "|"
        day_entries = "|".join(f"10|{d}" for d in days_of_week)

        # Format quantity as float-like string for GWT
        qty_str = _gwt_number(quantity)

        body = (
            GWT_ADD_REPEAT_ITEM
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{food_name}", food_name)
            .replace("{diary_group}", str(diary_group))
            .replace("{day_count}", str(len(days_of_week)))
            .replace("{day_entries}", day_entries)
            .replace("{quantity}", qty_str)
            .replace("{food_source_id}", str(food_source_id))
            .replace("{food_id}", str(food_id))
        )
        raw = self._gwt_post(body)
        if not raw.startswith("//OK"):
            raise RuntimeError(f"addRepeatItem failed: {raw[:300]}")
        return True

    def delete_repeat_item(self, repeat_item_id: int) -> bool:
        """Delete a recurring food entry.

        Args:
            repeat_item_id: The ID of the repeat item to delete.

        Returns:
            True on success.
        """
        self.authenticate()
        body = (
            GWT_DELETE_REPEAT_ITEM
            .replace("{gwt_header}", self.gwt_header)
            .replace("{nonce}", self.nonce or "")
            .replace("{user_id}", self.user_id or "")
            .replace("{repeat_item_id}", str(repeat_item_id))
        )
        raw = self._gwt_post(body)
        if not raw.startswith("//OK"):
            raise RuntimeError(f"deleteRepeatItem failed: {raw[:300]}")
        return True

    @staticmethod
    def _parse_repeated_items(raw: str) -> list[dict]:
        """Parse a GWT-RPC getRepeatedItems response.

        GWT writes its data section in reverse: the last number in the text is the
        first value of the stream. Read that way, a response is a list header
        followed by one block per record:

            <ArrayList ref> <record count>
            per record:
                <RepeatItem ref>
                quantity                                    (float)
                <ArrayList ref> <weekday count>
                    <Integer ref> <weekday>                 repeated, 0-6
                0                                           reserved
                <string-table ref for the food's name>
                1                                           reserved
                repeat_item_id  food_source_id  measure_id
                0                                           reserved

        Confirmed against two records written with distinct values, and the walk
        consumes the stream exactly. The diary group is *not* in the response.
        """
        if not raw.startswith("//OK"):
            # MODIFIED (3): a definite failure, not an ambiguous one — this is
            # an error or exception response, so it says nothing about the record.
            raise CronometerResponseError(
                f"Cronometer did not return a readable response: {raw[:200]}"
            )

        # Extract string table
        closing = ",0,7]"
        st_close = len(raw) - len(closing) - 1
        depth, pos, in_str = 1, st_close - 1, False
        while pos >= 0 and depth > 0:
            ch = raw[pos]
            if ch == '"' and (pos == 0 or raw[pos - 1] != "\\"):
                in_str = not in_str
            elif not in_str:
                if ch == "]":
                    depth += 1
                elif ch == "[":
                    depth -= 1
            pos -= 1
        st_open = pos + 1
        string_table = json.loads(raw[st_open:st_close + 1])

        # Extract data tokens before string table
        data_section = raw[5:st_open].rstrip(",")
        if not data_section:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        tokens: list = []
        for part in data_section.split(","):
            part = part.strip()
            if not part:
                continue
            if part.startswith('"') and part.endswith('"'):
                tokens.append(part.strip('"'))
                continue
            try:
                tokens.append(float(part) if "." in part else int(part))
            except ValueError:
                tokens.append(None)

        # MODIFIED (11): this replaced a heuristic that collected "large ints" in
        # textual order and named the first one food_source_id. GWT writes its stream
        # in reverse of the textual order, so the first large int is actually the
        # measure id: every result had food_source_id and measure_id transposed, and
        # the weekday list was always empty. Two probe items written with deliberately
        # distinct values pinned the real layout, so the walk below follows the
        # structure and asserts it consumed the stream exactly, rather than guessing.
        repeat_type_ref = None
        list_type_ref = None
        int_type_ref = None
        for i, entry in enumerate(string_table):
            if "RepeatItem/" in entry:
                repeat_type_ref = i + 1
            elif entry.startswith("java.util.ArrayList/"):
                list_type_ref = i + 1
            elif entry.startswith("java.lang.Integer/"):
                int_type_ref = i + 1

        if repeat_type_ref is None or list_type_ref is None:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        stream = list(reversed(tokens))
        cursor = 0

        def take(what: str) -> object:
            nonlocal cursor
            if cursor >= len(stream):
                raise CronometerResponseError(
                    f"Repeated-items response ended while reading {what}. "
                    "Refusing to report a partly-read record."
                )
            value = stream[cursor]
            cursor += 1
            return value

        if take("the list type") != list_type_ref:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        item_count = take("the item count")
        if not isinstance(item_count, int) or item_count < 0:
            raise CronometerResponseError(
                f"Repeated-items response gave an unreadable item count: {item_count!r}"
            )
        if item_count == 0:
            return CronometerClient._empty_or_unverified(raw)  # MODIFIED (6)

        items: list[dict] = []
        for index in range(item_count):
            if take("a record marker") != repeat_type_ref:
                raise CronometerResponseError(
                    f"Repeated item {index + 1} did not begin where expected; "
                    "the response layout has changed."
                )

            quantity = take("a quantity")
            if not isinstance(quantity, (int, float)):
                raise CronometerResponseError(
                    f"Repeated item {index + 1} had an unreadable quantity: {quantity!r}"
                )

            if take("a weekday list") != list_type_ref:
                raise CronometerResponseError(
                    f"Repeated item {index + 1} had no weekday list where one was expected."
                )
            day_count = take("a weekday count")
            if not isinstance(day_count, int) or not 0 <= day_count <= 7:
                raise CronometerResponseError(
                    f"Repeated item {index + 1} gave an impossible weekday count: {day_count!r}"
                )
            days_of_week: list[int] = []
            for _ in range(day_count):
                marker = take("a weekday marker")
                if int_type_ref is not None and marker != int_type_ref:
                    raise CronometerResponseError(
                        f"Repeated item {index + 1} had an unexpected weekday marker."
                    )
                day = take("a weekday")
                # 0-6, matching what add_repeat_item sends. Which day is 0 is not
                # asserted here: this file already documents that Cronometer's macro
                # endpoints disagree with each other about where the week starts.
                if not isinstance(day, int) or not 0 <= day <= 6:
                    raise CronometerResponseError(
                        f"Repeated item {index + 1} gave an impossible weekday: {day!r}"
                    )
                days_of_week.append(day)

            take("a reserved field")
            name_ref = take("a food name")
            take("a reserved field")
            repeat_item_id = take("a repeat-item id")
            food_source_id = take("a food source id")
            measure_id = take("a measure id")
            take("a reserved field")

            food_name = ""
            if isinstance(name_ref, int) and 1 <= name_ref <= len(string_table):
                candidate = string_table[name_ref - 1]
                # Both probes came back naming the food itself, not the label sent
                # when the rule was created, so a type reference here means the
                # layout moved rather than that the food is genuinely unnamed.
                if not candidate.startswith(("java.", "com.cronometer.")):
                    food_name = candidate

            items.append({
                "repeat_item_id": repeat_item_id,
                "food_name": food_name,
                "food_source_id": food_source_id,
                "measure_id": measure_id,
                "quantity": float(quantity),
                "days_of_week": days_of_week,
                # Cronometer does not send this back. Two probes written to different
                # groups produced byte-identical responses apart from their ids, days
                # and quantity, so reporting 0 here would have been an invention.
                "diary_group": None,
            })

        if cursor != len(stream):
            raise CronometerResponseError(
                f"Repeated-items response had {len(stream) - cursor} token(s) left over "
                f"after {item_count} record(s); the layout has changed and the values "
                "already read cannot be trusted."
            )

        return items
