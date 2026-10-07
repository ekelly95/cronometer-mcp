from __future__ import annotations

import json
import logging
import math
import os
import re
import stat
import sys
import tempfile
import traceback
from datetime import date
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, quote_plus, urlsplit

import requests

# Vendored rather than installed. Upstream stopped at 2026-03-08 with food search
# already broken by a Cronometer change and four unmerged fixes waiting; a pinned
# dependency cannot be patched. See the header of the vendored file for the full
# list of deliberate differences from the original.
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))
from cronometer_client import (  # noqa: E402
    CronometerClient,
    CronometerResponseError,
    SessionExpiredError,
    UnverifiedEmpty,
    UnverifiedEmptyMapping,
)


_ALLOWED_HOST = "cronometer.com"
_MAX_RESPONSE_BYTES = 25 * 1024 * 1024
_MAX_REQUEST_BYTES = 1024 * 1024
_MAX_DATE_RANGE_DAYS = 366
_HASH = re.compile(r"^[A-F0-9]{32}$")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9$._-]{1,64}$")
_TRUTHY = {"1", "true", "yes", "on"}
# A logged amount of zero is a mistake, not a serving. Mirrors `amount` in
# src/mcp/registry.ts.
_SMALLEST_AMOUNT = 0.001
# Requests puts the full URL in an HTTPError message, query string and all, and the
# export URL's query carries a short-lived auth token. The token is not one of the
# known secrets `_redact` can match, so the query is dropped wholesale instead.
_URL_QUERY = re.compile(r"(https?://[^\s?#'\"]+)\?[^\s'\"]*")
# Mirrors BIOMETRIC_RANGES in src/mcp/registry.ts. Wide enough for any unit
# Cronometer can display, narrow enough to catch a transposed digit.
_BIOMETRIC_RANGES = {
    "weight": (1.0, 1_000.0),
    "body_fat": (0.1, 100.0),
    "heart_rate": (20.0, 300.0),
    "blood_glucose": (0.1, 1_000.0),
}
ALLOWED_METHODS = frozenset(
    {
        "check_connection",
        "export_raw",
        "search_foods",
        "get_food_details",
        "add_food_entry",
        "remove_food_entry",
        "get_macro_targets",
        "set_macro_targets",
        "list_macro_templates",
        "create_macro_template",
        "delete_macro_template",
        "set_macro_schedule_day",
        "get_fasting_history",
        "get_fasting_stats",
        "delete_fast",
        "cancel_active_fast",
        "get_recent_biometrics",
        "add_biometric",
        "remove_biometric",
        "copy_day",
        "get_repeated_items",
        "add_repeat_item",
        "delete_repeat_item",
    }
)


class RestrictedSession(requests.Session):
    """A requests session that cannot be redirected away from Cronometer."""

    @staticmethod
    def _check_url(url: str) -> None:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != _ALLOWED_HOST:
            raise RuntimeError("live connector refused a request outside https://cronometer.com")

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        self._check_url(url)
        if "timeout" not in kwargs:
            kwargs["timeout"] = (10, 45)
        # A response hook runs before Requests follows redirects or buffers the body.
        kwargs["hooks"] = {"response": [self._limit_response]}
        return super().request(method, url, **kwargs)

    @staticmethod
    def _limit_response(
        response: requests.Response, *args: Any, **kwargs: Any
    ) -> requests.Response:
        declared = response.headers.get("Content-Length")
        if declared is not None:
            try:
                if int(declared) > _MAX_RESPONSE_BYTES:
                    response.close()
                    raise RuntimeError("Cronometer response exceeded the 25 MB safety limit")
            except ValueError:
                pass

        content = bytearray()
        for chunk in response.iter_content(chunk_size=64 * 1024):
            content.extend(chunk)
            if len(content) > _MAX_RESPONSE_BYTES:
                response.close()
                raise RuntimeError("Cronometer response exceeded the 25 MB safety limit")
        response._content = bytes(content)
        response._content_consumed = True
        return response

    def send(self, request: requests.PreparedRequest, **kwargs: Any) -> requests.Response:
        if request.url is None:
            raise RuntimeError("live connector received a request without a URL")
        self._check_url(request.url)
        return super().send(request, **kwargs)


def _data_dir() -> Path | None:
    configured = os.environ.get("CRONOMETER_DATA_DIR", "").strip()
    return Path(configured) if configured else None


def _required_data_dir() -> Path:
    """The session cookie is a credential, and on Windows its only real protection
    is the ACL the setup script puts on this directory — `os.chmod` sets no ACL
    there. Falling back to a home-directory default would silently write the
    cookie somewhere SYSTEM and Administrators inherit, so there is no fallback."""
    directory = _data_dir()
    if directory is None:
        raise RuntimeError(
            "CRONOMETER_DATA_DIR is not set; start the connector through the "
            "launcher so the session cache lands in the permission-protected directory"
        )
    return directory


class SafeCronometerClient(CronometerClient):
    """The pinned client with bounded networking and non-executable session storage."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # Before anything else: the parent constructor picks a home-directory
        # default for its own cookie path, and there is no point getting that far
        # if the protected directory this class needs was never configured.
        cookie_path = _required_data_dir() / ".session.json"
        super().__init__(*args, **kwargs)
        headers = dict(self.session.headers)
        self.session = RestrictedSession()
        self.session.headers.update(headers)
        self._cookie_path = cookie_path

    def _save_session(self) -> None:
        self._cookie_path.parent.mkdir(parents=True, exist_ok=True)
        if self._cookie_path.is_symlink():
            raise RuntimeError("refusing to replace a session-cache symlink")

        payload = {
            "version": 1,
            "cookies": self.session.cookies.get_dict(),
            "nonce": self.nonce,
            "user_id": self.user_id,
            "gwt_permutation": self.gwt_permutation,
            "gwt_header": self.gwt_header,
        }
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".session-",
            suffix=".tmp",
            dir=self._cookie_path.parent,
            text=True,
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self._cookie_path)
        finally:
            temporary.unlink(missing_ok=True)

    def _restore_session(self) -> bool:
        if not self._cookie_path.exists():
            return False
        try:
            metadata = self._cookie_path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise ValueError("session cache is not a regular file")
            if metadata.st_size > 256 * 1024:
                raise ValueError("session cache is unexpectedly large")

            payload = json.loads(self._cookie_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("version") != 1:
                raise ValueError("session cache version is invalid")

            cookies = payload.get("cookies")
            if not isinstance(cookies, dict) or len(cookies) > 100:
                raise ValueError("session cookies are invalid")
            for name, value in cookies.items():
                if not isinstance(name, str) or not isinstance(value, str):
                    raise ValueError("session cookie is not text")
                if len(name) > 256 or len(value) > 8192:
                    raise ValueError("session cookie is unexpectedly large")
                self.session.cookies.set(name, value, domain=_ALLOWED_HOST, path="/")

            nonce = payload.get("nonce")
            user_id = payload.get("user_id")
            permutation = payload.get("gwt_permutation")
            header = payload.get("gwt_header")
            if not isinstance(nonce, str) or len(nonce) > 1024:
                raise ValueError("session nonce is invalid")
            if not isinstance(user_id, str) or not user_id.isdigit():
                raise ValueError("session user ID is invalid")
            if not isinstance(permutation, str) or _HASH.fullmatch(permutation) is None:
                raise ValueError("GWT permutation is invalid")
            if not isinstance(header, str) or _HASH.fullmatch(header) is None:
                raise ValueError("GWT header is invalid")

            self.nonce = nonce
            self.user_id = user_id
            self.gwt_permutation = permutation
            self.gwt_header = header
            self._discover_gwt_hashes()
            if self._generate_auth_token():
                return True
        except Exception:
            logging.getLogger(__name__).warning("Saved Cronometer session was invalid; signing in again")

        self._cookie_path.unlink(missing_ok=True)
        return False


def _enabled() -> bool:
    return os.environ.get("CRONOMETER_LIVE_ENABLED", "").strip().lower() in _TRUTHY


def _requests_version() -> str:
    try:
        return version("requests")
    except PackageNotFoundError:
        return "not-installed"


def status() -> dict[str, Any]:
    data_dir = _data_dir()
    return {
        "live_enabled": _enabled(),
        "credentials_configured": bool(os.environ.get("CRONOMETER_USERNAME"))
        and bool(os.environ.get("CRONOMETER_PASSWORD")),
        "data_directory_configured": data_dir is not None,
        "session_cached": data_dir is not None and (data_dir / ".session.json").is_file(),
        # The protocol client is vendored, not installed, so there is no package
        # version to report — only the origin it was forked from and the fact that
        # it has since diverged.
        "protocol_client": "vendored from cronometer-mcp 2.0.3, modified",
        "requests_version": _requests_version(),
        "network_host": _ALLOWED_HOST,
    }


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("params must be an object")
    return value


def _string(
    params: dict[str, Any],
    name: str,
    *,
    maximum: int = 200,
    protocol_text: bool = False,
) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty text")
    if len(value) > maximum:
        raise ValueError(f"{name} is too long")
    if protocol_text and (
        any(character in value for character in "|\\{}")
        or any(ord(character) < 32 for character in value)
    ):
        raise ValueError(f"{name} contains characters the Cronometer protocol cannot encode safely")
    return value


def _identifier(params: dict[str, Any], name: str) -> str:
    value = _string(params, name, maximum=64)
    if _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(f"{name} is not a valid Cronometer identifier")
    return value


def _integer(
    params: dict[str, Any],
    name: str,
    *,
    minimum: int = 0,
    maximum: int = 2_147_483_647,
) -> int:
    value = params.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} is outside the supported range")
    return value


def _number(
    params: dict[str, Any],
    name: str,
    *,
    minimum: float = 0,
    maximum: float = 100_000,
) -> float:
    value = params.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or result < minimum or result > maximum:
        raise ValueError(f"{name} is outside the supported range")
    return result


def _date(params: dict[str, Any], name: str) -> date:
    value = _string(params, name, maximum=10)
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a real date in YYYY-MM-DD form") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{name} must use YYYY-MM-DD form")
    return parsed


def _date_range(params: dict[str, Any]) -> tuple[date, date]:
    # Both dates are required rather than defaulted to today. `date.today()` reads
    # the machine's timezone, which is not necessarily the diary's — the caller
    # resolves "today" against the configured diary timezone and passes it here.
    start = _date(params, "start_date")
    end = _date(params, "end_date")
    if end < start:
        raise ValueError("end_date must not be before start_date")
    if (end - start).days + 1 > _MAX_DATE_RANGE_DAYS:
        raise ValueError("live date ranges are limited to 366 days per call")
    return start, end


def _days_of_week(params: dict[str, Any]) -> list[int]:
    value = params.get("days_of_week")
    if not isinstance(value, list) or not value:
        raise ValueError("days_of_week must be a non-empty list")
    if any(isinstance(day, bool) or not isinstance(day, int) or day < 0 or day > 6 for day in value):
        raise ValueError("days_of_week values must be integers from 0 through 6")
    if len(set(value)) != len(value):
        raise ValueError("days_of_week must not contain duplicates")
    return value


def dispatch(client: CronometerClient, method: str, raw_params: Any) -> Any:
    params = _mapping(raw_params)

    if method == "check_connection":
        client.authenticate()
        return {"connected": True}
    if method == "export_raw":
        export_type = _string(params, "export_type", maximum=32)
        if export_type not in {"servings", "daily_summary", "exercises", "biometrics", "notes"}:
            raise ValueError("export_type is not supported")
        start, end = _date_range(params)
        return client.export_raw(export_type, start, end)
    if method == "search_foods":
        query = _string(params, "query", protocol_text=True)
        maximum = _integer(params, "max_results", minimum=1, maximum=50)
        return client.find_foods(query, maximum)
    if method == "get_food_details":
        result = client.get_food(_integer(params, "food_source_id", minimum=1))
        if isinstance(result, dict):
            result = dict(result)
            result.pop("raw_response", None)
        return result
    if method == "add_food_entry":
        # Only the universal gram measure (0) is accepted. The client packs the
        # diary group into a measure id's high 16 bits and keeps only the low 16 of
        # what it was given, so a real measure id such as 1072101 would be sent as
        # a different number. Nobody has verified what Cronometer does with that.
        if _integer(params, "measure_id") != 0:
            raise ValueError(
                "measure_id must be 0 (the universal gram measure); other measure ids "
                "are not encoded correctly yet"
            )
        return client.add_serving(
            food_id=_integer(params, "food_id", minimum=1),
            food_source_id=_integer(params, "food_source_id", minimum=1),
            measure_id=0,
            quantity=_number(params, "quantity", minimum=_SMALLEST_AMOUNT, maximum=100_000),
            weight_grams=_number(params, "weight_grams", minimum=_SMALLEST_AMOUNT, maximum=100_000),
            day=_date(params, "date"),
            diary_group=_integer(params, "diary_group", minimum=1, maximum=4),
        )
    if method == "remove_food_entry":
        return client.remove_serving(_identifier(params, "serving_id"))
    if method == "get_macro_targets":
        if params.get("all_days") is True:
            return client.get_all_macro_schedules()
        return client.get_daily_macro_targets(_date(params, "date"))
    if method == "set_macro_targets":
        return client.update_daily_targets(
            day=_date(params, "date"),
            protein_g=_number(params, "protein_g", maximum=2_000),
            fat_g=_number(params, "fat_g", maximum=2_000),
            carbs_g=_number(params, "carbs_g", maximum=5_000),
            calories=_number(params, "calories", maximum=20_000),
            template_name=_string(params, "template_name", maximum=100, protocol_text=True),
        )
    if method == "list_macro_templates":
        return client.get_macro_target_templates()
    if method == "create_macro_template":
        return client.save_macro_target_template(
            template_name=_string(params, "template_name", maximum=100, protocol_text=True),
            protein_g=_number(params, "protein_g", maximum=2_000),
            fat_g=_number(params, "fat_g", maximum=2_000),
            carbs_g=_number(params, "carbs_g", maximum=5_000),
            calories=_number(params, "calories", maximum=20_000),
        )
    if method == "delete_macro_template":
        return client.delete_macro_target_template(_integer(params, "template_id", minimum=1))
    if method == "set_macro_schedule_day":
        return client.save_macro_schedule(
            _integer(params, "day_of_week", minimum=0, maximum=6),
            _integer(params, "template_id"),
        )
    if method == "get_fasting_history":
        has_start = "start_date" in params
        has_end = "end_date" in params
        if has_start != has_end:
            raise ValueError("start_date and end_date must be supplied together")
        if has_start:
            start, end = _date_range(params)
            return client.get_user_fasts_for_range(start, end)
        return client.get_user_fasts()
    if method == "get_fasting_stats":
        return client.get_fasting_stats()
    if method == "delete_fast":
        return client.delete_fast(_integer(params, "fast_id", minimum=1))
    if method == "cancel_active_fast":
        return client.cancel_fast_keep_series(_integer(params, "fast_id", minimum=1))
    if method == "get_recent_biometrics":
        return client.get_recent_biometrics()
    if method == "add_biometric":
        metric_type = _string(params, "metric_type", maximum=32)
        # Only weight writes to the right metric; see MODIFIED (9) in the vendored
        # client. The range table still covers all four, ready for whenever the
        # other encodings are worked out.
        if metric_type not in _BIOMETRIC_RANGES or metric_type != "weight":
            raise ValueError(
                "only 'weight' can be written correctly; Cronometer's encoding for "
                "the other metrics is unverified and files entries under the wrong "
                "metric, so they are refused rather than mis-recorded"
            )
        low, high = _BIOMETRIC_RANGES[metric_type]
        value = _number(params, "value", minimum=low, maximum=high)
        return client.add_biometric(metric_type, value, _date(params, "date"))
    if method == "remove_biometric":
        return client.remove_biometric(_identifier(params, "biometric_id"))
    if method == "copy_day":
        source = _date(params, "source_date")
        destination = _date(params, "destination_date")
        if source == destination:
            raise ValueError("source_date and destination_date must be different")
        return client.copy_day(source, destination)
    if method == "get_repeated_items":
        return client.get_repeated_items()
    if method == "add_repeat_item":
        return client.add_repeat_item(
            food_source_id=_integer(params, "food_source_id", minimum=1),
            food_id=_integer(params, "food_id", minimum=1),
            quantity=_number(params, "quantity", minimum=_SMALLEST_AMOUNT, maximum=100_000),
            food_name=_string(params, "food_name", maximum=500, protocol_text=True),
            diary_group=_integer(params, "diary_group", minimum=1, maximum=4),
            days_of_week=_days_of_week(params),
        )
    if method == "delete_repeat_item":
        return client.delete_repeat_item(_integer(params, "repeat_item_id", minimum=1))

    raise ValueError(f"unknown live method: {method}")


_client: SafeCronometerClient | None = None


def _get_client() -> SafeCronometerClient:
    global _client
    if not _enabled():
        raise RuntimeError("live access is disabled; set CRONOMETER_LIVE_ENABLED=1 deliberately")
    if _client is None:
        _client = SafeCronometerClient()
    return _client


def _secret_forms(secret: str) -> set[str]:
    """A secret does not always reach an exception in the form it was typed. It can
    arrive JSON-escaped inside a response body or percent-encoded inside a URL, and
    plain substring replacement misses both."""
    forms = {secret, json.dumps(secret)[1:-1], quote(secret, safe=""), quote_plus(secret)}
    return {form for form in forms if form}


def _known_secrets() -> list[str]:
    secrets = [
        os.environ.get("CRONOMETER_USERNAME", ""),
        os.environ.get("CRONOMETER_PASSWORD", ""),
    ]
    if _client is not None:
        secrets.extend(_client.session.cookies.get_dict().values())
        # The nonce authenticates every GWT call, so it is as sensitive as a cookie.
        if isinstance(_client.nonce, str):
            secrets.append(_client.nonce)
    return [secret for secret in secrets if secret]


def _redact(text: str) -> str:
    for secret in _known_secrets():
        # Longest form first, so a short secret that is a substring of a longer
        # encoding cannot blank out part of it and leave the remainder readable.
        for form in sorted(_secret_forms(secret), key=len, reverse=True):
            text = text.replace(form, "[redacted]")
    return text


def _redacted_error(error: Exception) -> str:
    text = _URL_QUERY.sub(r"\1?[query removed]", f"{type(error).__name__}: {error}")
    return _redact(text)[:1000]


class _RedactingFilter(logging.Filter):
    """Standard error is not a private channel.

    The parent copies it into the MCP host's log, which is a file on disk that
    outlives the session. `_redacted_error` guards only the reply channel, so
    without this a warning from `requests` or this module could put a cookie
    somewhere permanent. Cookies and the nonce are visible only here, which is why
    the scrubbing has to happen at source rather than in the parent.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact(record.getMessage())
        record.args = ()
        if record.exc_info is not None:
            record.exc_text = _redact("".join(traceback.format_exception(*record.exc_info)))
            record.exc_info = None
        return True


def _redacting_excepthook(
    kind: type[BaseException], value: BaseException, trace: Any
) -> None:
    """A crash outside the request loop bypasses logging entirely and would print
    an unscrubbed traceback straight to stderr."""
    sys.stderr.write(_redact("".join(traceback.format_exception(kind, value, trace))))
    sys.stderr.flush()


def _install_stderr_redaction() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    redaction = _RedactingFilter()
    for handler in logging.getLogger().handlers:
        handler.addFilter(redaction)
    sys.excepthook = _redacting_excepthook


def _is_unverified(result: Any) -> bool:
    """Did the client return an empty answer it could not confirm was empty?

    The vendored parsers answer an unrecognised-but-well-formed response with
    UnverifiedEmpty rather than a bare list, because an empty record and a changed
    wire format look identical at that point. Passing the doubt up the chain is the
    whole point — silently dropping it here would restore the behaviour that
    reported a logged weight as "no biometrics".
    """
    return isinstance(result, (UnverifiedEmpty, UnverifiedEmptyMapping))


def _reply(
    identifier: Any,
    ok: bool,
    *,
    result: Any = None,
    error: str | None = None,
    unverified: bool = False,
) -> None:
    payload: dict[str, Any] = {"id": identifier, "ok": ok}
    if unverified:
        payload["unverified"] = True
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def main() -> int:
    _install_stderr_redaction()
    while True:
        # `for line in stream` would buffer an unterminated line in full before any
        # length check could run. readline(n) reads at most n bytes, so the limit is
        # enforced on the way in rather than after the fact.
        raw = sys.stdin.buffer.readline(_MAX_REQUEST_BYTES + 1)
        if not raw:
            break
        if not raw.endswith(b"\n") and len(raw) > _MAX_REQUEST_BYTES:
            # The stream is now mid-record and cannot be resynchronised. The parent
            # treats a stopped child as a failed call and starts a fresh one.
            _reply(None, False, error="bridge request exceeded the 1 MB safety limit")
            return 1

        identifier: Any = None
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("bridge request must be an object")
            identifier = request.get("id")
            method = request.get("method")
            if not isinstance(method, str):
                raise ValueError("bridge method must be text")
            if method == "status":
                result = status()
            elif method not in ALLOWED_METHODS:
                raise ValueError("bridge method is not allowed")
            else:
                result = dispatch(_get_client(), method, request.get("params", {}))
            _reply(identifier, True, result=result, unverified=_is_unverified(result))
        except Exception as error:
            _reply(identifier, False, error=_redacted_error(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
