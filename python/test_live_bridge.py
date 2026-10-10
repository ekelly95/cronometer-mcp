from __future__ import annotations

import io
import json
import logging
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import create_autospec, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))
from cronometer_client import (  # noqa: E402
    CronometerClient,
    _gwt_number,
    CronometerResponseError,
    SessionExpiredError,
    UnrecognisedResponse,
    UnverifiedEmpty,
)

import live_bridge  # noqa: E402
from live_bridge import (  # noqa: E402
    ALLOWED_METHODS,
    RestrictedSession,
    SafeCronometerClient,
    dispatch,
)


def _client() -> Any:
    """A mock built from the real vendored class.

    An autospec fails on a method the client does not have, and on a keyword it
    does not accept. A hand-written stub with `__getattr__` cannot: it answers to
    any name, so a rename would leave every test green and break only against the
    live account.
    """
    mock = create_autospec(CronometerClient, instance=True, spec_set=True)
    mock.get_food.return_value = {"food": "Egg", "raw_response": "internal protocol text"}
    mock.find_foods.return_value = [{"name": "Egg"}]
    mock.add_serving.return_value = {"serving_id": "D80lp$"}
    return mock


class ValidationTests(unittest.TestCase):
    def test_every_allowed_method_dispatches_to_the_expected_client_method(self) -> None:
        date_range = {"start_date": "2026-08-14", "end_date": "2026-08-15"}
        cases: list[tuple[str, dict[str, Any], str]] = [
            ("check_connection", {}, "authenticate"),
            ("export_raw", {**date_range, "export_type": "daily_summary"}, "export_raw"),
            ("search_foods", {"query": "egg", "max_results": 10}, "find_foods"),
            ("get_food_details", {"food_source_id": 101}, "get_food"),
            (
                "add_food_entry",
                {
                    "food_id": 202,
                    "food_source_id": 101,
                    "measure_id": 0,
                    "quantity": 1,
                    "weight_grams": 50,
                    "date": "2026-08-15",
                    "diary_group": 2,
                },
                "add_serving",
            ),
            ("remove_food_entry", {"serving_id": "D80lp$"}, "remove_serving"),
            ("get_macro_targets", {"all_days": True}, "get_all_macro_schedules"),
            ("get_macro_targets", {"date": "2026-08-15"}, "get_daily_macro_targets"),
            (
                "set_macro_targets",
                {
                    "date": "2026-08-15",
                    "protein_g": 160,
                    "fat_g": 70,
                    "carbs_g": 240,
                    "calories": 2230,
                    "template_name": "Training",
                },
                "update_daily_targets",
            ),
            ("list_macro_templates", {}, "get_macro_target_templates"),
            (
                "create_macro_template",
                {
                    "template_name": "Rest day",
                    "protein_g": 160,
                    "fat_g": 80,
                    "carbs_g": 180,
                    "calories": 2080,
                },
                "save_macro_target_template",
            ),
            ("delete_macro_template", {"template_id": 3}, "delete_macro_target_template"),
            (
                "set_macro_schedule_day",
                {"day_of_week": 1, "template_id": 3},
                "save_macro_schedule",
            ),
            ("get_fasting_history", {}, "get_user_fasts"),
            ("get_fasting_history", date_range, "get_user_fasts_for_range"),
            ("get_fasting_stats", {}, "get_fasting_stats"),
            ("delete_fast", {"fast_id": 7}, "delete_fast"),
            ("cancel_active_fast", {"fast_id": 8}, "cancel_fast_keep_series"),
            ("get_recent_biometrics", {}, "get_recent_biometrics"),
            (
                "add_biometric",
                {"metric_type": "weight", "value": 80, "date": "2026-08-15"},
                "add_biometric",
            ),
            ("remove_biometric", {"biometric_id": "bio_10"}, "remove_biometric"),
            (
                "copy_day",
                {"source_date": "2026-08-14", "destination_date": "2026-08-15"},
                "copy_day",
            ),
            ("get_repeated_items", {}, "get_repeated_items"),
            (
                "add_repeat_item",
                {
                    "food_source_id": 101,
                    "food_id": 202,
                    "quantity": 1,
                    "food_name": "Egg",
                    "diary_group": 1,
                    "days_of_week": [1, 3, 5],
                },
                "add_repeat_item",
            ),
            ("delete_repeat_item", {"repeat_item_id": 9}, "delete_repeat_item"),
        ]

        self.assertEqual({method for method, _, _ in cases}, ALLOWED_METHODS)
        for method, params, expected_client_method in cases:
            with self.subTest(method=method, expected=expected_client_method):
                client = _client()
                result = dispatch(client, method, params)
                getattr(client, expected_client_method).assert_called_once()
                self.assertEqual(len(client.method_calls), 1)
                if method == "get_food_details":
                    self.assertNotIn("raw_response", result)

    def test_search_is_bounded_and_dispatched(self) -> None:
        client = _client()
        result = dispatch(client, "search_foods", {"query": "eggs", "max_results": 10})
        self.assertEqual(result, [{"name": "Egg"}])
        client.find_foods.assert_called_once_with("eggs", 10)

    def test_protocol_delimiters_are_rejected(self) -> None:
        for query in ("egg|injected", r"egg\!injected", "egg{max_results}", "egg\x00null"):
            with self.subTest(query=query):
                client = _client()
                with self.assertRaisesRegex(ValueError, "cannot encode safely"):
                    dispatch(client, "search_foods", {"query": query, "max_results": 10})
                self.assertEqual(client.method_calls, [])

    def test_food_write_uses_validated_dates_and_numbers(self) -> None:
        client = _client()
        result = dispatch(
            client,
            "add_food_entry",
            {
                "food_id": 123,
                "food_source_id": 456,
                "measure_id": 0,
                "quantity": 100,
                "weight_grams": 100,
                "date": "2026-08-16",
                "diary_group": 2,
            },
        )
        self.assertEqual(result, {"serving_id": "D80lp$"})
        client.add_serving.assert_called_once()
        self.assertEqual(client.add_serving.call_args.kwargs["day"], date(2026, 8, 16))

    def test_food_write_refuses_a_measure_it_cannot_encode(self) -> None:
        """add_serving keeps only the low 16 bits of a measure id, so a real one
        such as 1072101 would be sent as a different number. Only the universal
        gram measure, 0, goes through until that encoding is verified."""
        client = _client()
        with self.assertRaisesRegex(ValueError, "measure_id must be 0"):
            dispatch(
                client,
                "add_food_entry",
                {
                    "food_id": 123,
                    "food_source_id": 456,
                    "measure_id": 1072101,
                    "quantity": 2,
                    "weight_grams": 100,
                    "date": "2026-08-16",
                    "diary_group": 1,
                },
            )
        self.assertEqual(client.method_calls, [])

    def test_a_zero_amount_is_not_a_serving(self) -> None:
        for field in ("quantity", "weight_grams"):
            with self.subTest(field=field):
                client = _client()
                params = {
                    "food_id": 123,
                    "food_source_id": 456,
                    "measure_id": 0,
                    "quantity": 1,
                    "weight_grams": 50,
                    "date": "2026-08-16",
                    "diary_group": 1,
                    field: 0,
                }
                with self.assertRaisesRegex(ValueError, "outside the supported range"):
                    dispatch(client, "add_food_entry", params)
                self.assertEqual(client.method_calls, [])

    def test_set_day_complete_is_not_reachable(self) -> None:
        """Cronometer removed setDayComplete. A tool that asks for approval and
        then always fails is worse than no tool, so it is off the allowlist."""
        self.assertNotIn("set_day_complete", ALLOWED_METHODS)
        client = _client()
        with self.assertRaisesRegex(ValueError, "unknown live method"):
            dispatch(client, "set_day_complete", {"date": "2026-08-15", "complete": True})
        self.assertEqual(client.method_calls, [])

    def test_copying_onto_the_same_day_is_refused(self) -> None:
        client = _client()
        with self.assertRaisesRegex(ValueError, "must be different"):
            dispatch(
                client,
                "copy_day",
                {"source_date": "2026-08-16", "destination_date": "2026-08-16"},
            )
        self.assertEqual(client.method_calls, [])

    def test_malformed_dates_and_identifiers_are_refused_before_dispatch(self) -> None:
        client = _client()
        with self.assertRaisesRegex(ValueError, "real date"):
            dispatch(
                client,
                "export_raw",
                {"export_type": "servings", "start_date": "2026-02-30", "end_date": "2026-03-01"},
            )
        with self.assertRaisesRegex(ValueError, "valid Cronometer identifier"):
            dispatch(client, "remove_food_entry", {"serving_id": "bad|id"})
        self.assertEqual(client.method_calls, [])

    def test_the_upstream_csv_parsers_are_not_reachable(self) -> None:
        """`get_food_log` and `get_daily_summary` are upstream's `csv.DictReader`
        path: untyped strings, no issue reporting, ragged rows silently mangled.
        Every diary read now fetches the raw export and parses it in TypeScript, so
        these are off the allowlist rather than merely unused — being unreachable by
        construction is worth more than being unreferenced."""
        for method in ("get_food_log", "get_daily_summary", "export_parsed"):
            with self.subTest(method=method):
                self.assertNotIn(method, ALLOWED_METHODS)
                client = _client()
                with self.assertRaisesRegex(ValueError, "unknown live method"):
                    dispatch(client, method, {"start_date": "2026-08-14", "end_date": "2026-08-15"})
                self.assertEqual(client.method_calls, [])

    def test_date_ranges_must_be_given_explicitly(self) -> None:
        """`date.today()` reads the machine's timezone, not the diary's. A default
        here would silently pick the wrong day whenever the two differ."""
        for method, params in (
            ("export_raw", {"export_type": "notes"}),
            ("export_raw", {"export_type": "notes", "start_date": "2026-08-14"}),
            ("export_raw", {"export_type": "notes", "end_date": "2026-08-14"}),
            ("get_macro_targets", {}),
        ):
            with self.subTest(method=method, params=params):
                client = _client()
                with self.assertRaises(ValueError):
                    dispatch(client, method, params)
                self.assertEqual(client.method_calls, [])

    def test_date_range_length_is_capped(self) -> None:
        client = _client()
        with self.assertRaisesRegex(ValueError, "366 days"):
            dispatch(
                client,
                "export_raw",
                {"export_type": "servings", "start_date": "2024-01-01", "end_date": "2026-01-01"},
            )
        self.assertEqual(client.method_calls, [])

    def test_biometric_values_are_bounded_per_metric(self) -> None:
        """One shared 0-100,000 range accepted a body-fat percentage of 100,000.
        The realistic failure is a transposed digit, not a hostile caller."""
        for metric, value in (
            ("weight", 100_000),
            ("weight", 0.5),
        ):
            with self.subTest(metric=metric, value=value):
                client = _client()
                with self.assertRaisesRegex(ValueError, "outside the supported range"):
                    dispatch(
                        client,
                        "add_biometric",
                        {"metric_type": metric, "value": value, "date": "2026-08-15"},
                    )
                self.assertEqual(client.method_calls, [])

        for metric, value in (("weight", 82.4), ("weight", 180.0)):
            with self.subTest(metric=metric, value=value, accepted=True):
                client = _client()
                dispatch(
                    client,
                    "add_biometric",
                    {"metric_type": metric, "value": value, "date": "2026-08-15"},
                )
                client.add_biometric.assert_called_once()

    def test_biometrics_that_would_be_mis_filed_are_refused(self) -> None:
        """The bug a live write found. Asking for heart_rate 60 created a Weight
        entry of 60 lbs, and body_fat shares weight's encoding byte for byte. A
        write that silently files data under the wrong metric corrupts a trend the
        user reads later, so the unverified metrics are refused outright."""
        for metric in ("heart_rate", "body_fat", "blood_glucose"):
            with self.subTest(metric=metric):
                client = _client()
                with self.assertRaisesRegex(ValueError, "only 'weight'"):
                    dispatch(
                        client,
                        "add_biometric",
                        {"metric_type": metric, "value": 60, "date": "2026-08-17"},
                    )
                self.assertEqual(client.method_calls, [])

    def test_unknown_and_unsupported_values_are_refused(self) -> None:
        client = _client()
        with self.assertRaisesRegex(ValueError, "unknown live method"):
            dispatch(client, "drop_all_data", {})
        with self.assertRaisesRegex(ValueError, "export_type is not supported"):
            dispatch(
                client,
                "export_raw",
                {"export_type": "everything", "start_date": "2026-08-14", "end_date": "2026-08-15"},
            )
        with self.assertRaisesRegex(ValueError, "only 'weight'"):
            dispatch(
                client,
                "add_biometric",
                {"metric_type": "mood", "value": 5, "date": "2026-08-15"},
            )
        self.assertEqual(client.method_calls, [])


class VendoredClientTests(unittest.TestCase):
    """The behaviour that made vendoring worth doing.

    Upstream answered a failed call with `return []`. On a live account that meant
    `get_recent_biometrics` reporting no biometrics while the CSV export for the
    same period showed a weight logged that morning. These tests exist so that
    cannot come back.
    """

    #: A real GWT exception response — this is what Cronometer sends when a call
    #: fails or a session has expired, and what upstream swallowed as "no data".
    EXCEPTION = (
        '//EX[2,1,["com.google.gwt.user.client.rpc.IncompatibleRemoteServiceException'
        '/3936916533","This application is out of date, please click the refresh '
        'button on your browser."],0,7]'
    )

    def _parsers(self) -> list[Any]:
        """Every read parser, bound. `_parse_recent_biometrics` takes self and reads
        `user_id`; the rest are static, so they are collected here rather than
        assumed alike."""
        blank = CronometerClient.__new__(CronometerClient)
        blank.user_id = "12345"
        return [
            blank._parse_recent_biometrics,
            CronometerClient._parse_repeated_items,
            CronometerClient._parse_fasts,
            CronometerClient._parse_fasting_stats,
            CronometerClient._parse_macro_target_templates,
            CronometerClient._parse_all_macro_schedules,
        ]

    def test_a_failed_call_raises_instead_of_reporting_no_data(self) -> None:
        for parser in self._parsers():
            with self.subTest(parser=parser.__name__):
                with self.assertRaises(CronometerResponseError):
                    parser(self.EXCEPTION)

    def test_an_unreadable_response_is_never_mistaken_for_an_empty_record(self) -> None:
        """The distinction the whole exercise is about."""
        blank = CronometerClient.__new__(CronometerClient)
        for bad in ("", "not a gwt response at all", "//EX[1]", "<html>502</html>"):
            with self.subTest(response=bad[:20]):
                with self.assertRaises(CronometerResponseError):
                    blank._parse_recent_biometrics(bad)

    #: What Cronometer actually returns for "you have none of these". Captured
    #: from a live account: getAllMacroSchedules, getRecentBiometrics and
    #: getRepeatedItems all answered with exactly this, and all three were right.
    EMPTY_COLLECTION = '//OK[0,1,["java.util.ArrayList/4159755760"],0,7]'

    def test_a_genuinely_empty_account_is_reported_as_confirmed_empty(self) -> None:
        """The correction to an earlier over-cautious pass.

        An empty collection has no element type, because it has no elements — so
        "the element type is missing" is not evidence of a format change. Flagging
        these as unverified fired the warning on every correct answer, which is how
        a warning stops being read.
        """
        for parser in self._parsers():
            # _parse_fasting_stats returns a fixed four-key summary rather than a
            # collection, so "empty" means zeros, not no keys. Covered separately.
            if parser.__name__ == "_parse_fasting_stats":
                continue
            with self.subTest(parser=parser.__name__):
                result = parser(self.EMPTY_COLLECTION)
                self.assertEqual(len(result), 0)
                self.assertFalse(
                    live_bridge._is_unverified(result),
                    "a confirmed empty must not carry doubt",
                )
        self.assertTrue(CronometerClient._is_confirmed_empty(self.EMPTY_COLLECTION))
        # getDailyMacroTargets answers an unset target with no string table at all.
        self.assertTrue(CronometerClient._is_confirmed_empty("//OK[0,[],0,7]"))

    def test_fasting_stats_reports_real_zeros_without_doubt(self) -> None:
        """Verified live: an account with no fasts returns parsed zeros, not an
        empty collection, and carries no flag because nothing failed to parse."""
        stats = CronometerClient._parse_fasting_stats(self.EMPTY_COLLECTION)
        self.assertFalse(live_bridge._is_unverified(stats))
        self.assertEqual(set(stats), {
            "total_hours", "longest_fast_hours", "seven_fast_avg_hours", "completed_count",
        })

    def test_a_response_with_content_the_parser_cannot_read_keeps_its_doubt(self) -> None:
        """The case the flag is actually for: the response names a domain type, so
        there IS something there, and coming back empty means we failed to read it."""
        # The string table names a Biometric, so the account has one. The data
        # section never references that type, so the parser cannot locate it — the
        # shape a wire-format change would actually take.
        with_content = (
            '//OK[1,1,1,1,["java.util.ArrayList/4159755760",'
            '"com.cronometer.shared.biometrics.Biometric/2989635787"],0,7]'
        )
        self.assertFalse(CronometerClient._is_confirmed_empty(with_content))

        blank = CronometerClient.__new__(CronometerClient)
        blank.user_id = "12345"
        result = blank._parse_recent_biometrics(with_content)
        self.assertEqual(list(result), [])
        self.assertIsInstance(result, UnverifiedEmpty)
        self.assertTrue(live_bridge._is_unverified(result))

    def test_a_confirmed_empty_result_carries_no_doubt(self) -> None:
        self.assertFalse(live_bridge._is_unverified([]))
        self.assertFalse(live_bridge._is_unverified({}))
        self.assertFalse(live_bridge._is_unverified([{"metric": "Weight"}]))

    def test_no_write_can_reach_the_retrying_path(self) -> None:
        """The line that upstream PR #1 crossed.

        Reads may re-authenticate and try once more. Writes must not: a write whose
        outcome is unknown could be applied twice. `_gwt_read` retries, `_gwt_post`
        does not, so this asserts on which methods use which.
        """
        source = Path(__file__).resolve().parent / "vendor" / "cronometer_client.py"
        writes = {
            "add_serving", "remove_serving", "update_daily_targets",
            "save_macro_target_template", "delete_macro_target_template",
            "save_macro_schedule", "delete_fast", "cancel_fast_keep_series",
            "add_biometric", "remove_biometric", "copy_day", "set_day_complete",
            "add_repeat_item", "delete_repeat_item",
        }
        current = None
        retrying: set[str] = set()
        for line in source.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("def "):
                current = stripped.split("(")[0][4:]
            if "_gwt_read(" in line and current not in (None, "_gwt_read"):
                retrying.add(current)

        self.assertEqual(writes & retrying, set(), "a write reached the retrying path")
        self.assertTrue(retrying, "no read uses the retrying path, so the split is not real")

    def test_food_search_maps_the_current_json_shape(self) -> None:
        hits = [
            {
                "id": 464674,
                "measureId": 1072101,
                "name": "Eggs, Cooked",
                "measureDisplayName": "1 large - 50g",
                "score": 42,
            }
        ]
        # The mapping upstream PR #6 verified against the old GWT parser's output
        # for this exact food, which is what makes add_serving() safe to leave alone.
        self.assertEqual(
            CronometerClient._parse_food_search_hits(hits),
            [
                {
                    "food_id": 1072101,
                    "food_source_id": 464674,
                    "name": "Eggs, Cooked",
                    "measure_desc": "1 large - 50g",
                    "score": 42,
                }
            ],
        )

    def test_food_search_skips_hits_it_cannot_trust(self) -> None:
        """A half-understood hit would log a serving against the wrong food."""
        hits = [
            {"id": 1, "measureId": 2, "name": ""},                       # no name
            {"id": 1, "measureId": "2", "name": "String id"},            # id is text
            {"id": True, "measureId": 2, "name": "Boolean id"},          # bool as int
            {"id": 1, "measureId": True, "name": "Boolean measure"},
            {"id": 1, "name": "No measure at all"},
            "not even an object",
            {"id": 9, "measureId": 8, "name": "Good one"},
        ]
        parsed = CronometerClient._parse_food_search_hits(hits)
        self.assertEqual([food["name"] for food in parsed], ["Good one"])

    def test_food_search_refuses_a_response_that_is_not_a_list(self) -> None:
        for bad in ({"error": "nope"}, "a string", 42, None):
            with self.subTest(response=bad):
                with self.assertRaises(CronometerResponseError):
                    CronometerClient._parse_food_search_hits(bad)

    # Two repeat rules were written to the live account with deliberately distinct
    # values so each field could be told apart, these responses captured, then the
    # rules deleted. #1: quantity 3, weekdays [1, 3], diary group 2.
    #                #2: quantity 5, weekdays [6],    diary group 4.
    REPEATED_TWO = (
        '//OK[0,1072101,464674,849382,1,4,0,6,3,1,1,5.0,2,0,1072101,464674,849371,1,4,'
        '0,3,3,1,3,2,1,3.0,2,2,1,["java.util.ArrayList/4159755760","com.cronometer.sha'
        'red.repeatitems.RepeatItem/477684891","java.lang.Integer/3438268394","Eggs, Co'
        'oked"],0,7]'
    )
    REPEATED_ONE = (
        '//OK[0,1072101,464674,849371,1,4,0,3,3,1,3,2,1,3.0,2,1,1,["java.util.ArrayList'
        '/4159755760","com.cronometer.shared.repeatitems.RepeatItem/477684891","java.la'
        'ng.Integer/3438268394","Eggs, Cooked"],0,7]'
    )

    def test_repeated_items_reads_the_fields_that_were_actually_written(self) -> None:
        """The values below are not guesses about the format: they are what was sent
        to Cronometer when these two rules were created. Upstream's parser reported
        the ids the other way round, because GWT writes its data section in reverse
        of the textual order and the heuristic read it forwards."""
        first, second = CronometerClient._parse_repeated_items(self.REPEATED_TWO)

        self.assertEqual(first["food_source_id"], 464674)
        self.assertEqual(first["measure_id"], 1072101)
        self.assertEqual(first["repeat_item_id"], 849371)
        self.assertEqual(first["quantity"], 3.0)
        self.assertEqual(first["days_of_week"], [1, 3])
        self.assertEqual(first["food_name"], "Eggs, Cooked")

        self.assertEqual(second["food_source_id"], 464674)
        self.assertEqual(second["measure_id"], 1072101)
        self.assertEqual(second["repeat_item_id"], 849382)
        self.assertEqual(second["quantity"], 5.0)
        self.assertEqual(second["days_of_week"], [6])
        # Each record carries its own name reference. Reading names as a separate
        # list left every record after the first with an empty name, because both
        # of these point at the same string-table entry.
        self.assertEqual(second["food_name"], "Eggs, Cooked")

    def test_repeated_items_does_not_invent_a_diary_group(self) -> None:
        """These two rules were written to different groups and came back byte for
        byte identical apart from ids, quantity and weekdays, so the group is simply
        not in the response. Upstream reported 0, which reads as a real group."""
        for item in CronometerClient._parse_repeated_items(self.REPEATED_TWO):
            self.assertIsNone(item["diary_group"])

    def test_repeated_items_reads_a_single_record(self) -> None:
        """Captured before the second rule existed: the one-record path is not just
        the two-record path with a smaller count, it has a different token layout."""
        items = CronometerClient._parse_repeated_items(self.REPEATED_ONE)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["food_source_id"], 464674)
        self.assertEqual(items[0]["measure_id"], 1072101)
        self.assertEqual(items[0]["days_of_week"], [1, 3])

    def test_repeated_items_refuses_a_response_it_cannot_fully_read(self) -> None:
        """A leftover token means the layout moved. The values read before it may
        look plausible, so returning them is worse than failing."""
        cases = {
            "one record too many": self.REPEATED_TWO.replace(",2,2,1,[", ",2,3,1,["),
            "an impossible weekday": self.REPEATED_TWO.replace(
                ",1,4,0,6,3,1,1,5.0", ",1,4,0,9,3,1,1,5.0"
            ),
            "an extra token inside a record": self.REPEATED_TWO.replace(
                "1,4,0,6,3,1,1,5.0", "1,4,0,6,3,1,1,5.0,7"
            ),
        }
        for label, mutated in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(CronometerResponseError):
                    CronometerClient._parse_repeated_items(mutated)

    def test_repeated_items_flags_an_unreadable_opening_as_unverified(self) -> None:
        """Distinct from the account that genuinely has no repeat rules: this one
        has content the parser could not read, and must not report a bare empty."""
        mutated = self.REPEATED_TWO.replace("2,2,1,[", "2,2,1,99,[")
        result = CronometerClient._parse_repeated_items(mutated)
        self.assertEqual(list(result), [])
        self.assertTrue(getattr(result, "unverified", False))

    # MODIFIED (14) guards. Unlike REPEATED_TWO above, these responses are
    # synthetic: no capture pins the layout of these reads, so they are built to
    # the shape each heuristic assumes. They prove the guards fire and that a
    # readable record still parses — not that the heuristics match Cronometer.
    BIO_TABLE = (
        '["java.util.ArrayList/4159755760",'
        '"com.cronometer.shared.biometrics.Biometric/2989635787",'
        '"com.cronometer.shared.models.Day/1","BXW0DA"]'
    )

    def _biometrics(self, data: str) -> list[dict]:
        blank = CronometerClient.__new__(CronometerClient)
        blank.user_id = "12345"
        return blank._parse_recent_biometrics(f"//OK[{data},{self.BIO_TABLE},0,7]")

    def test_recent_biometrics_reads_a_complete_record(self) -> None:
        [entry] = self._biometrics("4,180.5,5001,3,17,8,2026,2,1,1")
        self.assertEqual(entry["biometric_id"], "BXW0DA")
        self.assertEqual(entry["value"], 180.5)
        self.assertEqual(entry["date"], "2026-08-17")

    def test_recent_biometrics_keeps_dates_outside_the_old_window(self) -> None:
        """Upstream accepted only 2020-2030 and dropped any other date."""
        [entry] = self._biometrics("4,180.5,5001,3,5,1,2031,2,1,1")
        self.assertEqual(entry["date"], "2031-01-05")

    def test_recent_biometrics_reads_a_composite_record_without_a_single_value(self) -> None:
        """Blood pressure arrives as JSON, not one number. Requiring a float would
        make one such entry fail the whole read."""
        table = self.BIO_TABLE[:-1] + ',"{\\"systolic\\":120,\\"diastolic\\":80}"]'
        blank = CronometerClient.__new__(CronometerClient)
        blank.user_id = "12345"
        [entry] = blank._parse_recent_biometrics(
            f"//OK[4,5,5001,3,17,8,2026,2,1,1,{table},0,7]"
        )
        self.assertIsNone(entry["value"])
        self.assertIn("systolic", entry["composite"])
        self.assertEqual(entry["date"], "2026-08-17")

    def test_recent_biometrics_refuses_a_partly_read_record(self) -> None:
        """Upstream filled the gap with 0.0, 0 or "" and reported the record."""
        cases = {
            "no value": "4,5001,3,17,8,2026,2,1,1",
            "no id": "5001,180.5,3,17,8,2026,2,1,1",
            "no date": "4,180.5,5001,3,2,1,1",
        }
        for label, data in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(UnrecognisedResponse):
                    self._biometrics(data)

    FAST_TABLE = (
        '["java.util.ArrayList/4159755760",'
        '"com.cronometer.shared.fasting.Fast/1","overnight fast"]'
    )

    def test_fasts_read_an_open_fast(self) -> None:
        [fast] = CronometerClient._parse_fasts(
            f'//OK[3,"AbCdE12","0",123456,2,1,1,{self.FAST_TABLE},0,7]'
        )
        self.assertEqual(fast["fast_id"], 123456)
        self.assertEqual(fast["start_ts"], "AbCdE12")
        self.assertEqual(fast["name"], "overnight fast")
        self.assertIs(fast["is_active"], True)
        self.assertIsNone(fast["recurrence_id"], "an id that was not sent is not 0")

    def test_fasts_do_not_call_an_unknown_end_active(self) -> None:
        """Upstream read a missing end as an open fast."""
        [fast] = CronometerClient._parse_fasts(
            f'//OK[3,"AbCdE12",123456,2,1,1,{self.FAST_TABLE},0,7]'
        )
        self.assertIsNone(fast["end_ts"])
        self.assertIsNone(fast["is_active"])

    def test_fasts_refuse_a_record_without_an_id(self) -> None:
        """Upstream reported fast_id 0 — a record delete_fast cannot act on."""
        with self.assertRaises(UnrecognisedResponse):
            CronometerClient._parse_fasts(
                f'//OK[3,"AbCdE12","0",1,2,1,1,{self.FAST_TABLE},0,7]'
            )

    STATS_TABLE = (
        '["java.util.ArrayList/4159755760",'
        '"com.cronometer.shared.fasting.FastingStats/1"]'
    )

    def test_fasting_stats_read_their_figures(self) -> None:
        stats = CronometerClient._parse_fasting_stats(
            f"//OK[12.5,30.25,10.0,7,2,1,{self.STATS_TABLE},0,7]"
        )
        self.assertEqual(
            stats,
            {
                "total_hours": 12.5,
                "longest_fast_hours": 30.2,
                "seven_fast_avg_hours": 10.0,
                "completed_count": 7,
            },
        )

    def test_fasting_stats_do_not_report_zeros_they_could_not_read(self) -> None:
        with self.assertRaises(UnrecognisedResponse):
            CronometerClient._parse_fasting_stats(f"//OK[5,2,1,{self.STATS_TABLE},0,7]")

    MACRO_TABLE = '["com.cronometer.shared.MacroTargetTemplate/1","Custom Targets"]'

    def test_daily_macro_targets_read_their_values(self) -> None:
        targets = CronometerClient._parse_macro_target_template(
            f"//OK[150.0,70.0,2200.0,250.0,1,{self.MACRO_TABLE},0,7]"
        )
        self.assertEqual(targets["calories"], 2200.0)
        self.assertEqual(targets["template_name"], "Custom Targets")

    def test_daily_macro_targets_never_answer_with_zero_targets(self) -> None:
        """Upstream answered an error, an unset day and an unreadable response all
        with four zero targets."""
        self.assertEqual(CronometerClient._parse_macro_target_template("//OK[0,[],0,7]"), {})
        with self.assertRaises(CronometerResponseError):
            CronometerClient._parse_macro_target_template(self.EXCEPTION)
        with self.assertRaises(UnrecognisedResponse):
            CronometerClient._parse_macro_target_template(
                f"//OK[150.0,1,{self.MACRO_TABLE},0,7]"
            )

    def test_macro_templates_and_schedules_refuse_a_block_without_four_values(self) -> None:
        """Upstream dropped such a template silently, and reported such a schedule
        day as 0 kcal targets."""
        with self.assertRaises(UnrecognisedResponse):
            CronometerClient._parse_macro_target_templates(
                f"//OK[150.0,70.0,99999,1,1,1,{self.MACRO_TABLE},0,7]"
            )
        with self.assertRaises(UnrecognisedResponse):
            CronometerClient._parse_all_macro_schedules(
                '//OK[150.0,2,1,1,["java.util.ArrayList/4159755760",'
                '"com.cronometer.shared.MacroSchedule/1"],0,7]'
            )

    def test_a_biometric_without_a_readable_id_is_not_reported_as_added(self) -> None:
        """Upstream returned "" and the tool said success; that id is the only
        handle remove_biometric takes. The message must stop a retry."""
        client, sent = self._session_client(["//OK[[],0,7]"])
        with self.assertRaisesRegex(CronometerResponseError, "Do not add it again"):
            client.add_biometric("weight", 180.5, date(2026, 8, 17))
        self.assertEqual(len(sent), 1, "the write must not be re-sent")

    def test_writes_require_ok_at_the_start_of_the_response(self) -> None:
        """A response merely containing //OK is not a success."""
        for method, args in (
            ("remove_serving", ("D80lp$",)),
            ("remove_biometric", ("BXW0DA",)),
            ("add_biometric", ("weight", 180.5, date(2026, 8, 17))),
        ):
            client = CronometerClient.__new__(CronometerClient)
            client.gwt_header = "B" * 32
            client.nonce = "n"
            client.user_id = "42"
            client.authenticate = lambda: None
            client._gwt_post = lambda _body: 'error: expected //OK["X"],0,7]'
            with self.subTest(method=method):
                with self.assertRaises(RuntimeError):
                    getattr(client, method)(*args)

    def test_exports_are_decoded_as_utf8_whatever_the_server_declares(self) -> None:
        """Cronometer sends `text/csv` with no charset, so requests falls back to
        ISO-8859-1 and turns the micro sign into 'Âµ'. Five nutrient headers carry
        U+00B5, so left alone those five match nothing and read as missing on every
        live export — silently, because a missing column is not an error."""
        csv_bytes = "Date,B12 (Cobalamin) (µg),Completed\n2026-08-16,1.77,false\n".encode("utf-8")

        class FakeResponse:
            status_code = 200
            content = csv_bytes
            encoding = "ISO-8859-1"  # what requests guesses for an undeclared text/csv

            @property
            def text(self) -> str:
                return self.content.decode(self.encoding)

            def raise_for_status(self) -> None:
                return None

        client = CronometerClient.__new__(CronometerClient)
        client.session = SimpleNamespace(get=lambda *a, **k: FakeResponse())
        client._generate_auth_token = lambda: "token"

        text = CronometerClient._export_request(client, "daily_summary", date(2026, 8, 16), date(2026, 8, 16))
        self.assertIn("(µg)", text)
        self.assertNotIn("Âµ", text)
        # The exact codepoint matters: U+00B5 MICRO SIGN, not U+03BC GREEK SMALL MU.
        self.assertIn("µg", text)
        self.assertNotIn("μg", text)

    def test_a_removed_method_is_not_reported_as_an_expired_session(self) -> None:
        """Both arrive as //EX, and only one is worth retrying. Cronometer has
        removed findFoods and setDayComplete; calling those "session expired" cost a
        pointless re-authentication and named the wrong cause."""
        removed = (
            '//EX[2,1,["com.google.gwt.user.client.rpc.IncompatibleRemoteServiceException'
            '/3936916533","This application is out of date ... Could not locate requested '
            'method \'setDayComplete(...)\'"],0,7]'
        )
        expired = (
            '//EX[2,1,["com.cronometer.shared.user.exceptions.NotLoggedInException'
            '/844385496","Invalid or expired session"],0,7]'
        )

        class FakeResponse:
            def __init__(self, text: str) -> None:
                self.text = text

            def raise_for_status(self) -> None:
                return None

        client = CronometerClient.__new__(CronometerClient)
        client.gwt_permutation = "A" * 32
        client._cookie_path = Path(tempfile.gettempdir()) / "cronometer-test-no-such-session"
        for text, expected in ((removed, CronometerResponseError), (expired, SessionExpiredError)):
            client.session = SimpleNamespace(
                post=lambda *a, _t=text, **k: FakeResponse(_t),
                cookies=requests.cookies.RequestsCookieJar(),
            )
            with self.subTest(text=text[:40]):
                with self.assertRaises(expected) as caught:
                    CronometerClient._gwt_post(client, "body")
                # The permanent failure must not be a SessionExpiredError, because
                # that is precisely what _gwt_read retries on.
                if expected is CronometerResponseError:
                    self.assertNotIsInstance(caught.exception, SessionExpiredError)

    def _session_client(self, responses: list[str]) -> tuple[Any, list[str]]:
        """A bare client whose POSTs answer from `responses` in order and whose
        re-login hands out a new nonce. Returns the client and the bodies sent."""

        class FakeResponse:
            def __init__(self, text: str) -> None:
                self.text = text

            def raise_for_status(self) -> None:
                return None

        sent: list[str] = []
        replies = iter(responses)

        def post(*_args: Any, data: str, **_kwargs: Any) -> FakeResponse:
            sent.append(data)
            return FakeResponse(next(replies))

        client = CronometerClient.__new__(CronometerClient)
        client.gwt_permutation = "A" * 32
        client.gwt_header = "B" * 32
        client.nonce = "old-nonce"
        client.user_id = "42"
        client._authenticated = True
        client._cookie_path = Path(tempfile.gettempdir()) / "cronometer-test-no-such-session"
        client.session = SimpleNamespace(post=post, cookies=requests.cookies.RequestsCookieJar())

        def sign_in() -> None:
            client.nonce = "new-nonce"
            client.user_id = "42"
            client._authenticated = True

        client.authenticate = sign_in
        return client, sent

    def test_a_read_retry_carries_the_new_nonce(self) -> None:
        """The body embeds the nonce. Built once, the retry re-sent the dead one
        and could never succeed; built per attempt, it carries the fresh one."""
        expired = '//EX[2,1,["NotLoggedInException/1","Invalid or expired session"],0,7]'
        client, sent = self._session_client([expired, "//OK[0,7]"])

        raw = CronometerClient._gwt_read(client, lambda: f"body|{client.nonce}")

        self.assertEqual(raw, "//OK[0,7]")
        self.assertEqual(sent, ["body|old-nonce", "body|new-nonce"])

    def test_a_rejected_write_discards_the_session_and_is_not_resent(self) -> None:
        """A write that meets an expired session fails, once. Before, the dead
        session stayed marked as signed in and every later write failed the same
        way; now the next call signs in again."""
        expired = '//EX[2,1,["NotLoggedInException/1","Invalid or expired session"],0,7]'
        client, sent = self._session_client([expired])

        with self.assertRaisesRegex(SessionExpiredError, "session was discarded"):
            CronometerClient._gwt_post(client, "write-body")

        self.assertEqual(sent, ["write-body"])
        self.assertFalse(client._authenticated)
        self.assertIsNone(client.nonce)

    def test_numbers_are_written_without_exponents(self) -> None:
        self.assertEqual(_gwt_number(100.0), "100")
        self.assertEqual(_gwt_number(0.5), "0.5")
        self.assertEqual(_gwt_number(0.00001), "0.00001")
        self.assertEqual(_gwt_number(0.001), "0.001")
        self.assertEqual(_gwt_number(1234.25), "1234.25")
        for value in (0.00001, 0.0001234, 99999.125):
            self.assertNotIn("e", _gwt_number(value).lower())

    def test_measure_ids_are_read_from_the_right_place(self) -> None:
        """Upstream read the id from a fixed offset that is a zero field, so every
        measure reported id 0 and add_serving silently fell back to the universal
        gram measure — logging "1.01 fl oz" where the user asked for "1 fl oz".

        The fixture is a real getFood response for a public database food, checked
        to carry no account identifiers before it was saved.
        """
        raw = (
            Path(__file__).resolve().parent.parent
            / "test" / "fixtures" / "gwt" / "get-food-eggs.txt"
        ).read_text(encoding="utf-8")
        parsed = CronometerClient._parse_get_food(raw, 464674)
        measures = {m["description"]: m for m in parsed["measures"]}

        self.assertEqual(len(parsed["measures"]), 12)
        ids = [m["measure_id"] for m in parsed["measures"]]
        self.assertNotIn(0, ids, "a zero id means the offset drifted again")
        self.assertEqual(len(set(ids)), len(ids), "ids must be distinct per measure")

        # Corroborated against the food-search endpoint, which independently
        # reports food_id 1072101 as "1 large - 50g" for this food. Two endpoints
        # agreeing is what makes this the right field rather than a plausible one.
        self.assertEqual(measures["large"]["measure_id"], 1072101)
        self.assertEqual(measures["large"]["weight_grams"], 50.0)
        self.assertEqual(measures["g"]["weight_grams"], 1.0)
        self.assertEqual(measures["cup, chopped"]["weight_grams"], 136.0)

    def test_the_pickle_session_store_is_gone(self) -> None:
        """Unpickling executes arbitrary code; a cookie jar should not."""
        source = (Path(__file__).resolve().parent / "vendor" / "cronometer_client.py").read_text(
            encoding="utf-8"
        )
        for forbidden in ("import pickle", "pickle.loads(", "pickle.dumps("):
            self.assertNotIn(forbidden, source, f"live pickle usage remains: {forbidden}")

        # And the removed methods fail loudly rather than silently doing nothing,
        # so a future change that stops overriding them cannot quietly reintroduce
        # an executable session file.
        blank = CronometerClient.__new__(CronometerClient)
        with self.assertRaises(NotImplementedError):
            blank._save_session()
        with self.assertRaises(NotImplementedError):
            blank._restore_session()


class NetworkBoundaryTests(unittest.TestCase):
    def test_only_https_cronometer_urls_are_allowed(self) -> None:
        for refused in (
            "http://cronometer.com/login",
            "https://example.com/",
            "https://cronometer.com.evil.example/",
            "https://evil.example/?next=https://cronometer.com",
            "ftp://cronometer.com/",
        ):
            with self.subTest(url=refused):
                with self.assertRaises(RuntimeError):
                    RestrictedSession._check_url(refused)

        RestrictedSession._check_url("https://cronometer.com/login")
        # urlsplit lower-cases the host, so case is not a way around the rule.
        RestrictedSession._check_url("https://CRONOMETER.COM/login")

    def test_send_refuses_a_url_off_the_allowed_host(self) -> None:
        """`send` is the method requests re-enters for every redirect hop, so the
        redirect boundary lives or dies here rather than in `request`."""
        session = RestrictedSession()
        prepared = requests.Request("GET", "https://evil.example/").prepare()
        with self.assertRaises(RuntimeError):
            session.send(prepared)

    def test_response_body_is_stopped_at_the_size_limit_while_streaming(self) -> None:
        class FakeResponse:
            def __init__(self) -> None:
                self.headers: dict[str, str] = {}
                self.closed = False
                self._content: bytes | bool = False
                self._content_consumed = False

            def iter_content(self, chunk_size: int) -> Any:
                self.assert_chunk_size = chunk_size
                yield b"123"
                yield b"45"
                yield b"unreachable"

            def close(self) -> None:
                self.closed = True

        response = FakeResponse()
        with patch.object(live_bridge, "_MAX_RESPONSE_BYTES", 4), self.assertRaisesRegex(
            RuntimeError, "25 MB safety limit"
        ):
            RestrictedSession._limit_response(response)
        self.assertTrue(response.closed)

    def test_a_declared_oversize_is_refused_before_the_body_is_read(self) -> None:
        class FakeResponse:
            def __init__(self) -> None:
                self.headers = {"Content-Length": "99999999"}
                self.closed = False

            def iter_content(self, chunk_size: int) -> Any:
                raise AssertionError("the body must not be read once the header is over the limit")

            def close(self) -> None:
                self.closed = True

        response = FakeResponse()
        with self.assertRaisesRegex(RuntimeError, "25 MB safety limit"):
            RestrictedSession._limit_response(response)
        self.assertTrue(response.closed)


class SessionPersistenceTests(unittest.TestCase):
    def _environment(self, directory: str) -> dict[str, str]:
        return {
            "CRONOMETER_USERNAME": "student@example.com",
            "CRONOMETER_PASSWORD": "secret",
            "CRONOMETER_DATA_DIR": directory,
        }

    def test_session_cache_is_json_and_can_be_restored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, self._environment(directory), clear=False):
                client = SafeCronometerClient()
                client.session.cookies.set("sesnonce", "cookie-value")
                client.nonce = "nonce"
                client.user_id = "12345"
                client.gwt_permutation = "A" * 32
                client.gwt_header = "B" * 32
                client._save_session()

                cache = Path(directory) / ".session.json"
                payload = json.loads(cache.read_text(encoding="utf-8"))
                self.assertEqual(payload["cookies"], {"sesnonce": "cookie-value"})
                # The upstream client pickles its session; this one must not.
                self.assertFalse((Path(directory) / ".session_cookies").exists())

                restored = SafeCronometerClient()
                restored._discover_gwt_hashes = lambda: None
                restored._generate_auth_token = lambda: "valid"
                self.assertTrue(restored._restore_session())
                self.assertEqual(restored.user_id, "12345")
                self.assertEqual(restored.session.cookies.get("sesnonce"), "cookie-value")

    def test_a_malformed_session_cache_is_rejected_and_deleted(self) -> None:
        """Every validation branch, because a cache that fails open is a cache that
        lets whatever is on disk become session state."""
        valid = {
            "version": 1,
            "cookies": {"sesnonce": "cookie-value"},
            "nonce": "nonce",
            "user_id": "12345",
            "gwt_permutation": "A" * 32,
            "gwt_header": "B" * 32,
        }
        rejections: list[tuple[str, Any]] = [
            ("not an object", ["not", "a", "dict"]),
            ("wrong version", {**valid, "version": 2}),
            ("no version", {k: v for k, v in valid.items() if k != "version"}),
            ("cookies not an object", {**valid, "cookies": "sesnonce=value"}),
            ("too many cookies", {**valid, "cookies": {str(n): "v" for n in range(101)}}),
            ("cookie value not text", {**valid, "cookies": {"sesnonce": 12345}}),
            ("cookie value oversized", {**valid, "cookies": {"sesnonce": "x" * 8193}}),
            ("nonce not text", {**valid, "nonce": 42}),
            ("nonce oversized", {**valid, "nonce": "x" * 1025}),
            ("user id not digits", {**valid, "user_id": "12345; DROP"}),
            ("user id not text", {**valid, "user_id": 12345}),
            ("permutation not a hash", {**valid, "gwt_permutation": "not-a-hash"}),
            ("permutation lower case", {**valid, "gwt_permutation": "a" * 32}),
            ("header wrong length", {**valid, "gwt_header": "B" * 31}),
        ]

        for label, payload in rejections:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as directory:
                    with patch.dict(os.environ, self._environment(directory), clear=False):
                        cache = Path(directory) / ".session.json"
                        cache.write_text(json.dumps(payload), encoding="utf-8")

                        client = SafeCronometerClient()
                        client._discover_gwt_hashes = lambda: None
                        client._generate_auth_token = lambda: "valid"
                        with self.assertLogs(level="WARNING"):
                            self.assertFalse(client._restore_session())
                        self.assertFalse(cache.exists(), "an invalid cache must not be left behind")

    def test_an_oversized_session_cache_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, self._environment(directory), clear=False):
                cache = Path(directory) / ".session.json"
                cache.write_text("x" * (256 * 1024 + 1), encoding="utf-8")

                client = SafeCronometerClient()
                with self.assertLogs(level="WARNING"):
                    self.assertFalse(client._restore_session())
                self.assertFalse(cache.exists())

    def test_the_data_directory_must_be_configured(self) -> None:
        """Without it the session cookie would land in a home-directory default that
        SYSTEM and Administrators inherit, instead of the ACL-protected directory."""
        environment = {
            "CRONOMETER_USERNAME": "student@example.com",
            "CRONOMETER_PASSWORD": "secret",
        }
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "CRONOMETER_DATA_DIR"):
                SafeCronometerClient()

    def test_status_reports_the_directory_without_reading_it(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            report = live_bridge.status()
        self.assertFalse(report["live_enabled"])
        self.assertFalse(report["credentials_configured"])
        self.assertFalse(report["data_directory_configured"])
        self.assertFalse(report["session_cached"])
        self.assertEqual(report["network_host"], "cronometer.com")


class ErrorRedactionTests(unittest.TestCase):
    def test_credentials_and_cookie_values_are_removed_from_errors(self) -> None:
        session = RestrictedSession()
        session.cookies.set("session", "cookie-secret")
        client = SimpleNamespace(session=session, nonce="nonce-secret")
        environment = {
            "CRONOMETER_USERNAME": "student@example.com",
            "CRONOMETER_PASSWORD": "password-secret",
        }
        error = RuntimeError(
            "student@example.com password-secret cookie-secret nonce-secret"
        )
        with patch.dict(os.environ, environment, clear=False), patch.object(
            live_bridge, "_client", client
        ):
            message = live_bridge._redacted_error(error)

        for secret in ("student@example.com", "password-secret", "cookie-secret", "nonce-secret"):
            self.assertNotIn(secret, message)
        self.assertEqual(message.count("[redacted]"), 4)

    def test_secrets_are_removed_even_when_the_error_re_encoded_them(self) -> None:
        """A secret does not always come back in the form it was sent. Plain
        substring replacement misses a JSON-escaped or percent-encoded copy."""
        password = 'se"cret\\one'
        username = "student@example.com"
        session = RestrictedSession()
        client = SimpleNamespace(session=session, nonce=None)
        environment = {
            "CRONOMETER_USERNAME": username,
            "CRONOMETER_PASSWORD": password,
        }
        json_escaped = json.dumps(password)[1:-1]
        percent_encoded = "student%40example.com"
        error = RuntimeError(f"login body {json_escaped} and query {percent_encoded}")

        with patch.dict(os.environ, environment, clear=False), patch.object(
            live_bridge, "_client", client
        ):
            message = live_bridge._redacted_error(error)

        self.assertNotIn(json_escaped, message)
        self.assertNotIn(percent_encoded, message)
        self.assertIn("[redacted]", message)

    def test_log_records_are_redacted_before_they_reach_stderr(self) -> None:
        """The parent copies stderr into the MCP host's log file, so a warning that
        names a cookie writes it somewhere permanent. Cookies and the nonce are
        visible only in this process, so the scrubbing has to happen here."""
        session = RestrictedSession()
        session.cookies.set("sesnonce", "cookie-secret")
        client = SimpleNamespace(session=session, nonce="nonce-secret")
        environment = {
            "CRONOMETER_USERNAME": "student@example.com",
            "CRONOMETER_PASSWORD": "password-secret",
        }
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(live_bridge._RedactingFilter())
        logger = logging.getLogger("redaction-test")
        logger.addHandler(handler)
        logger.propagate = False
        logger.setLevel(logging.WARNING)

        try:
            with patch.dict(os.environ, environment, clear=False), patch.object(
                live_bridge, "_client", client
            ):
                logger.warning(
                    "sign-in failed for %s using %s (cookie-secret / nonce-secret)",
                    "student@example.com",
                    "password-secret",
                )
        finally:
            logger.removeHandler(handler)

        written = stream.getvalue()
        for secret in ("student@example.com", "password-secret", "cookie-secret", "nonce-secret"):
            self.assertNotIn(secret, written)
        self.assertIn("[redacted]", written)
        self.assertIn("sign-in failed", written)

    def test_an_uncaught_traceback_is_redacted_before_stderr(self) -> None:
        environment = {
            "CRONOMETER_USERNAME": "student@example.com",
            "CRONOMETER_PASSWORD": "password-secret",
        }
        stream = io.StringIO()
        try:
            raise RuntimeError("crashed while sending password-secret")
        except RuntimeError as error:
            with patch.dict(os.environ, environment, clear=False), patch.object(
                live_bridge, "_client", None
            ), patch.object(sys, "stderr", stream):
                live_bridge._redacting_excepthook(type(error), error, error.__traceback__)

        written = stream.getvalue()
        self.assertNotIn("password-secret", written)
        self.assertIn("[redacted]", written)
        self.assertIn("RuntimeError", written)

    def test_a_url_query_string_never_reaches_an_error(self) -> None:
        """Requests puts the whole URL in an HTTPError, and the export URL's query
        carries a short-lived auth token that is not one of the known secrets."""
        error = requests.HTTPError(
            "500 Server Error: oops for url: "
            "https://cronometer.com/export?nonce=tok3n&generate=servings"
        )
        with patch.dict(os.environ, {}, clear=True), patch.object(live_bridge, "_client", None):
            message = live_bridge._redacted_error(error)
        self.assertNotIn("tok3n", message)
        self.assertIn("https://cronometer.com/export?[query removed]", message)

    def test_an_error_message_is_bounded(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch.object(live_bridge, "_client", None):
            message = live_bridge._redacted_error(RuntimeError("x" * 5000))
        self.assertEqual(len(message), 1000)


if __name__ == "__main__":
    unittest.main()
