"""statusline.pyのテスト"""

# テストではプライベートメンバーへのアクセスが必要である
# pyright: reportPrivateUsage=false

import json
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Never

if TYPE_CHECKING:
    from collections.abc import Iterator
from unittest.mock import MagicMock, patch
from urllib.error import URLError

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".claude" / "scripts"))
import statusline

# autouse fixture が _spawn_usage_refresh を差し替えるため、実体の検証用に import 時点の関数を保持する
_SPAWN_USAGE_REFRESH = statusline._spawn_usage_refresh


def _mock_http_response(body: bytes) -> MagicMock:
    """モックHTTPレスポンスを生成する"""
    mock_resp = MagicMock()
    mock_resp.read.return_value = body
    mock_resp.__enter__ = MagicMock(return_value=mock_resp)
    mock_resp.__exit__ = MagicMock(return_value=None)
    return mock_resp


@pytest.fixture(autouse=True)
def _isolate_model_usage(  # pyright: ignore[reportUnusedFunction]
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[None]:
    """モデル別使用量を実キャッシュと子プロセスから隔離する

    既定では未取得の状態にし、必要なテストが個別に上書きする
    """
    absent = tmp_path_factory.mktemp("model-usage") / "absent.json"
    with (
        patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", absent),
        patch.object(statusline, "_spawn_usage_refresh"),
    ):
        yield


_FULL_STDIN_SAMPLE: dict[str, Any] = {
    "cwd": "/fallback/cwd/directory",
    "session_id": "abc123...",
    "transcript_path": "/path/to/transcript.jsonl",
    "model": {
        "id": "claude-opus-4-6",
        "display_name": "Opus",
    },
    "workspace": {
        "current_dir": "/current/working/myproject",
        "project_dir": "/original/project/directory",
    },
    "version": "1.0.80",
    "output_style": {
        "name": "default",
    },
    "cost": {
        "total_cost_usd": 0.01234,
        "total_duration_ms": 45000,
        "total_api_duration_ms": 2300,
        "total_lines_added": 156,
        "total_lines_removed": 23,
    },
    "context_window": {
        "total_input_tokens": 15234,
        "total_output_tokens": 4521,
        "context_window_size": 200000,
        "used_percentage": 8,
        "remaining_percentage": 92,
        "current_usage": {
            "input_tokens": 8500,
            "output_tokens": 1200,
            "cache_creation_input_tokens": 5000,
            "cache_read_input_tokens": 2000,
        },
    },
    "exceeds_200k_tokens": False,
    "vim": {
        "mode": "NORMAL",
    },
    "agent": {
        "name": "security-reviewer",
    },
    "worktree": {
        "name": "my-feature",
        "path": "/path/to/.claude/worktrees/my-feature",
        "branch": "worktree-my-feature",
        "original_cwd": "/path/to/project",
        "original_branch": "main",
    },
    "rate_limits": {
        "five_hour": {
            "used_percentage": 42,
            "resets_at": 1736949000,
        },
        "seven_day": {
            "used_percentage": 66,
            "resets_at": 1737331200,
        },
    },
}


class TestGetCurrencyFromLocale:
    """_get_currency_from_locale のテスト"""

    def test_japanese_locale(self) -> None:
        """日本語ロケールの場合はJPYを返す"""
        with patch("statusline.locale.getlocale", return_value=("ja_JP", "utf-8")):
            assert statusline._get_currency_from_locale() == "JPY"

    def test_us_locale(self) -> None:
        """USロケールの場合はUSDを返す"""
        with patch("statusline.locale.getlocale", return_value=("en_US", "utf-8")):
            assert statusline._get_currency_from_locale() == "USD"

    def test_uk_locale(self) -> None:
        """UKロケールの場合はGBPを返す"""
        with patch("statusline.locale.getlocale", return_value=("en_GB", "utf-8")):
            assert statusline._get_currency_from_locale() == "GBP"

    def test_german_locale(self) -> None:
        """ドイツ語ロケールの場合はEURを返す"""
        with patch("statusline.locale.getlocale", return_value=("de_DE", "utf-8")):
            assert statusline._get_currency_from_locale() == "EUR"

    def test_unknown_locale_falls_back_to_usd(self) -> None:
        """未知のロケールの場合はUSDにフォールバックする"""
        with patch("statusline.locale.getlocale", return_value=("xx_XX", "utf-8")):
            assert statusline._get_currency_from_locale() == "USD"

    def test_none_locale_falls_back_to_usd(self) -> None:
        """ロケールがNoneの場合はUSDにフォールバックする"""
        with patch("statusline.locale.getlocale", return_value=(None, None)):
            assert statusline._get_currency_from_locale() == "USD"

    def test_value_error_falls_back_to_usd(self) -> None:
        """ValueError時はUSDにフォールバックする"""
        with patch("statusline.locale.getlocale", side_effect=ValueError):
            assert statusline._get_currency_from_locale() == "USD"

    def test_windows_japanese_locale(self) -> None:
        """Windowsのフルネーム形式でもJPYを返す"""
        with patch(
            "statusline.locale.getlocale", return_value=("Japanese_Japan", "932")
        ):
            assert statusline._get_currency_from_locale() == "JPY"

    def test_windows_german_locale(self) -> None:
        """Windowsのドイツ語ロケールでもEURを返す"""
        with patch(
            "statusline.locale.getlocale", return_value=("German_Germany", "1252")
        ):
            assert statusline._get_currency_from_locale() == "EUR"

    def test_windows_korean_locale(self) -> None:
        """Windowsの韓国語ロケールでもKRWを返す"""
        with patch("statusline.locale.getlocale", return_value=("Korean_Korea", "949")):
            assert statusline._get_currency_from_locale() == "KRW"

    def test_locale_without_country(self) -> None:
        """国コードなしのロケールはUSDにフォールバックする"""
        with patch("statusline.locale.getlocale", return_value=("ja", "utf-8")):
            assert statusline._get_currency_from_locale() == "USD"


class TestCurrencyData:
    """通貨データのテスト"""

    def test_currencies_has_usd(self) -> None:
        """USDが通貨辞書に含まれている"""
        assert "USD" in statusline._CURRENCIES

    def test_currencies_has_jpy(self) -> None:
        """JPYの通貨情報が正しく設定されている"""
        info = statusline._CURRENCIES["JPY"]
        assert info.symbol == "\u00a5"
        assert info.decimals == 0

    def test_currencies_has_thb(self) -> None:
        """新規追加通貨THBのテスト"""
        info = statusline._CURRENCIES["THB"]
        assert info.symbol == "\u0e3f"
        assert info.decimals == 2

    def test_currencies_has_try(self) -> None:
        """新規追加通貨TRYのテスト"""
        info = statusline._CURRENCIES["TRY"]
        assert info.symbol == "\u20ba"
        assert info.decimals == 2

    def test_twd_removed(self) -> None:
        """TWDはAPI非対応のため削除されている"""
        assert "TWD" not in statusline._CURRENCIES

    def test_locale_to_currency_has_jp(self) -> None:
        """JPロケールがJPY通貨に対応している"""
        assert statusline._LOCALE_TO_CURRENCY["JP"] == "JPY"

    def test_locale_to_currency_has_us(self) -> None:
        """USロケールがUSD通貨に対応している"""
        assert statusline._LOCALE_TO_CURRENCY["US"] == "USD"

    def test_locale_to_currency_tw_removed(self) -> None:
        """TWはAPI非対応のため削除されている"""
        assert "TW" not in statusline._LOCALE_TO_CURRENCY


class TestGetExchangeRate:
    """_get_exchange_rate のテスト"""

    def test_usd_returns_none(self) -> None:
        """USDの場合は変換不要なのでNoneを返す"""
        assert statusline._get_exchange_rate("USD") is None

    def test_fetches_rate_from_api(self, tmp_path: Path) -> None:
        """APIからレートを取得できる"""
        # 存在しないキャッシュファイルを指定してキャッシュミスを発生させる
        cache_file = tmp_path / "nonexistent-cache.json"

        mock_resp = _mock_http_response(b'{"rates":{"JPY":150.5}}')

        with (
            patch.object(statusline, "_EXCHANGE_CACHE_PATH", cache_file),
            patch("statusline.urlopen", return_value=mock_resp),
        ):
            rate = statusline._get_exchange_rate("JPY")
        assert rate == 150.5

    def test_returns_cached_rate(self, tmp_path: Path) -> None:
        """有効なキャッシュからレートを返す"""
        cache_file = tmp_path / "exchange-cache.json"
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        cache_data = {
            "_cached_at": time.time(),
            "data": 149.0,
            "currency": "JPY",
            "date": today,
        }
        cache_file.write_text(json.dumps(cache_data))

        with patch.object(statusline, "_EXCHANGE_CACHE_PATH", cache_file):
            rate = statusline._get_exchange_rate("JPY")
        assert rate == 149.0

    def test_api_failure_returns_expired_cache(self, tmp_path: Path) -> None:
        """API失敗時は期限切れキャッシュを返す"""
        cache_file = tmp_path / "exchange-cache.json"
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        cache_data = {
            "_cached_at": 0,
            "data": 148.0,
            "currency": "JPY",
            "date": today,
        }
        cache_file.write_text(json.dumps(cache_data))

        with (
            patch.object(statusline, "_EXCHANGE_CACHE_PATH", cache_file),
            patch("statusline.urlopen", side_effect=URLError("fail")),
        ):
            rate = statusline._get_exchange_rate("JPY")
        assert rate == 148.0

    def test_api_failure_no_cache_returns_none(self, tmp_path: Path) -> None:
        """API失敗かつキャッシュなしの場合はNoneを返す"""
        # 存在しないキャッシュファイルを指定する
        cache_file = tmp_path / "nonexistent-cache.json"

        with (
            patch.object(statusline, "_EXCHANGE_CACHE_PATH", cache_file),
            patch("statusline.urlopen", side_effect=URLError("fail")),
        ):
            rate = statusline._get_exchange_rate("JPY")
        assert rate is None

    def test_rate_not_found_returns_none(self, tmp_path: Path) -> None:
        """APIレスポンスにrateが含まれない場合はNoneを返す"""
        cache_file = tmp_path / "nonexistent-cache.json"

        mock_resp = _mock_http_response(b'{"rates":{}}')

        with (
            patch.object(statusline, "_EXCHANGE_CACHE_PATH", cache_file),
            patch("statusline.urlopen", return_value=mock_resp),
        ):
            rate = statusline._get_exchange_rate("JPY")
        assert rate is None

    def test_different_currency_invalidates_cache(self, tmp_path: Path) -> None:
        """キャッシュの通貨が異なる場合はAPIから取得する"""
        cache_file = tmp_path / "exchange-cache.json"
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        cache_data = {
            "_cached_at": time.time(),
            "data": 0.92,
            "currency": "EUR",
            "date": today,
        }
        cache_file.write_text(json.dumps(cache_data))

        mock_resp = _mock_http_response(b'{"rates":{"JPY":150.0}}')

        with (
            patch.object(statusline, "_EXCHANGE_CACHE_PATH", cache_file),
            patch("statusline.urlopen", return_value=mock_resp),
        ):
            rate = statusline._get_exchange_rate("JPY")
        assert rate == 150.0


class TestFormatCost:
    """_format_cost のテスト"""

    def test_usd_display(self) -> None:
        """USDの場合は$表示"""
        with patch.object(statusline, "_currency", "USD"):
            assert statusline._format_cost(1.23) == "$1.23"

    def test_jpy_display(self) -> None:
        """JPYの場合は¥表示(小数なし)"""
        with (
            patch.object(statusline, "_currency", "JPY"),
            patch("statusline._get_exchange_rate", return_value=150.0),
        ):
            # 1.23 * 150.0 = 184.5 -> :.0fの偶数丸めで184
            assert statusline._format_cost(1.23) == "¥184"

    def test_eur_display(self) -> None:
        """EURの場合はユーロ表示(小数2桁)"""
        with (
            patch.object(statusline, "_currency", "EUR"),
            patch("statusline._get_exchange_rate", return_value=0.92),
        ):
            assert statusline._format_cost(1.00) == "€0.92"

    def test_exchange_rate_failure_falls_back_to_usd(self) -> None:
        """為替レート取得失敗時はUSDフォールバック"""
        with (
            patch.object(statusline, "_currency", "JPY"),
            patch("statusline._get_exchange_rate", return_value=None),
        ):
            assert statusline._format_cost(1.23) == "$1.23"

    def test_unknown_currency_falls_back_to_usd(self) -> None:
        """_CURRENCIESに存在しない通貨はUSDフォールバック"""
        with (
            patch.object(statusline, "_currency", "XYZ"),
            patch("statusline._get_exchange_rate", return_value=1.5),
        ):
            assert statusline._format_cost(1.23) == "$1.23"

    def test_usd_large_value_comma_separated(self) -> None:
        """USDの大きい値はカンマ区切りになる"""
        with patch.object(statusline, "_currency", "USD"):
            assert statusline._format_cost(1234.56) == "$1,234.56"

    def test_jpy_large_value_comma_separated(self) -> None:
        """JPYの大きい値はカンマ区切りになる"""
        with (
            patch.object(statusline, "_currency", "JPY"),
            patch("statusline._get_exchange_rate", return_value=150.0),
        ):
            # 10.0 * 150.0 = 1500
            assert statusline._format_cost(10.0) == "¥1,500"

    def test_eur_large_value_comma_separated(self) -> None:
        """EURの大きい値はカンマ区切りになる"""
        with (
            patch.object(statusline, "_currency", "EUR"),
            patch("statusline._get_exchange_rate", return_value=0.92),
        ):
            # 2000.0 * 0.92 = 1840.0
            assert statusline._format_cost(2000.0) == "€1,840.00"


class TestSegCost:
    """_seg_session_cost のテスト"""

    def test_returns_segment_with_cost(self) -> None:
        """コストデータがある場合はSegmentを返す"""
        with patch.object(statusline, "_currency", "USD"):
            data = {"cost": {"total_cost_usd": 1.23}}
            seg = statusline._seg_session_cost(data)
            assert seg is not None
            assert "$1.23" in seg.text

    def test_jpy_cost_display(self) -> None:
        """JPYの場合は¥表示"""
        with (
            patch.object(statusline, "_currency", "JPY"),
            patch("statusline._get_exchange_rate", return_value=150.0),
        ):
            data = {"cost": {"total_cost_usd": 1.23}}
            seg = statusline._seg_session_cost(data)
            assert seg is not None
            # 1.23 * 150.0 = 184.5 -> :.0fの偶数丸めで184
            assert "¥184" in seg.text

    def test_no_cost_data_returns_none(self) -> None:
        """コストデータがない場合はNone"""
        seg = statusline._seg_session_cost({})
        assert seg is None

    def test_no_total_cost_returns_none(self) -> None:
        """total_cost_usdがない場合はNone"""
        seg = statusline._seg_session_cost({"cost": {}})
        assert seg is None

    def test_non_numeric_cost_returns_none(self) -> None:
        """数値変換できないtotal_cost_usdの場合はNone"""
        seg = statusline._seg_session_cost({"cost": {"total_cost_usd": "abc"}})
        assert seg is None


class TestGetSessionCost:
    """_get_session_cost のテスト"""

    def test_no_cost_data_returns_none(self) -> None:
        """costキーがない場合はNone"""
        assert statusline._get_session_cost({}) is None

    def test_no_total_cost_returns_none(self) -> None:
        """total_cost_usdがない場合はNone"""
        assert statusline._get_session_cost({"cost": {}}) is None

    def test_non_numeric_cost_returns_none(self) -> None:
        """数値変換できないtotal_cost_usdはNone"""
        assert statusline._get_session_cost({"cost": {"total_cost_usd": "abc"}}) is None

    def test_no_session_id_returns_total_cost(self) -> None:
        """session_idがない場合はtotal_cost_usdをそのまま返す"""
        result = statusline._get_session_cost({"cost": {"total_cost_usd": 1.23}})
        assert result == 1.23

    def test_new_session_returns_zero(self, tmp_path: Path) -> None:
        """新しいセッションではベースラインを記録し0.0を返す"""
        cache_path = tmp_path / "session-cost.json"
        with patch.object(statusline, "_SESSION_COST_CACHE_PATH", cache_path):
            data = {
                "session_id": "session-1",
                "cost": {"total_cost_usd": 5.00},
            }
            result = statusline._get_session_cost(data)
        assert result == 0.0
        # キャッシュにベースラインが記録されている
        cache_obj = json.loads(cache_path.read_text(encoding="utf-8"))
        assert cache_obj["sessions"]["session-1"] == 5.00

    def test_same_session_returns_delta(self, tmp_path: Path) -> None:
        """同一セッションでは累積コストとの差分を返す"""
        cache_path = tmp_path / "session-cost.json"
        cache_path.write_text(json.dumps({"sessions": {"session-1": 5.00}}))
        with patch.object(statusline, "_SESSION_COST_CACHE_PATH", cache_path):
            data = {
                "session_id": "session-1",
                "cost": {"total_cost_usd": 6.50},
            }
            result = statusline._get_session_cost(data)
        assert result == 1.50

    def test_session_change_preserves_other_sessions(self, tmp_path: Path) -> None:
        """別セッションが追加されても既存セッションのベースラインは保持される"""
        cache_path = tmp_path / "session-cost.json"
        cache_path.write_text(json.dumps({"sessions": {"session-1": 5.00}}))
        with patch.object(statusline, "_SESSION_COST_CACHE_PATH", cache_path):
            data = {
                "session_id": "session-2",
                "cost": {"total_cost_usd": 10.00},
            }
            result = statusline._get_session_cost(data)
        assert result == 0.0
        # 両セッションのベースラインが保持されている
        cache_obj = json.loads(cache_path.read_text(encoding="utf-8"))
        assert cache_obj["sessions"]["session-1"] == 5.00
        assert cache_obj["sessions"]["session-2"] == 10.00

    def test_cost_not_dict_returns_none(self) -> None:
        """costがdictでない場合はNone"""
        assert statusline._get_session_cost({"cost": "not-a-dict"}) is None


class TestCachedFetch:
    """_cached_fetch のテスト"""

    def test_returns_fresh_data_on_cache_miss(self, tmp_path: Path) -> None:
        """キャッシュミス時はfetch_fnからデータを取得する"""
        cache_file = tmp_path / "test-cache.json"
        result = statusline._cached_fetch(cache_file, 60, lambda: {"key": "value"})
        assert result == {"key": "value"}

    def test_returns_cached_data_within_ttl(self, tmp_path: Path) -> None:
        """TTL内のキャッシュを返す"""
        cache_file = tmp_path / "test-cache.json"
        cache_data = {"_cached_at": time.time(), "data": {"cached": True}}
        cache_file.write_text(json.dumps(cache_data))
        result = statusline._cached_fetch(cache_file, 60, lambda: {"fresh": True})
        assert result == {"cached": True}

    def test_refetches_on_expired_cache(self, tmp_path: Path) -> None:
        """TTL切れキャッシュは再取得する"""
        cache_file = tmp_path / "test-cache.json"
        cache_data = {"_cached_at": 0, "data": {"old": True}}
        cache_file.write_text(json.dumps(cache_data))
        result = statusline._cached_fetch(cache_file, 60, lambda: {"new": True})
        assert result == {"new": True}

    def test_returns_expired_cache_on_fetch_failure(self, tmp_path: Path) -> None:
        """fetch失敗時は期限切れキャッシュを返す"""
        cache_file = tmp_path / "test-cache.json"
        cache_data = {"_cached_at": 0, "data": {"expired": True}}
        cache_file.write_text(json.dumps(cache_data))

        def failing_fetch() -> Never:
            raise URLError("fail")

        result = statusline._cached_fetch(cache_file, 60, failing_fetch)
        assert result == {"expired": True}

    def test_returns_none_on_fetch_failure_no_cache(self, tmp_path: Path) -> None:
        """fetch失敗かつキャッシュなしの場合はNoneを返す"""
        cache_file = tmp_path / "nonexistent.json"

        def failing_fetch() -> Never:
            raise URLError("fail")

        result = statusline._cached_fetch(cache_file, 60, failing_fetch)
        assert result is None

    def test_cache_key_mismatch_refetches(self, tmp_path: Path) -> None:
        """cache_keyが異なる場合は再取得する"""
        cache_file = tmp_path / "test-cache.json"
        cache_data = {
            "_cached_at": time.time(),
            "data": {"old": True},
            "currency": "EUR",
        }
        cache_file.write_text(json.dumps(cache_data))
        result = statusline._cached_fetch(
            cache_file, 60, lambda: {"new": True}, cache_key={"currency": "JPY"}
        )
        assert result == {"new": True}

    def test_cache_key_match_returns_cache(self, tmp_path: Path) -> None:
        """cache_keyが一致する場合はキャッシュを返す"""
        cache_file = tmp_path / "test-cache.json"
        cache_data = {
            "_cached_at": time.time(),
            "data": {"cached": True},
            "currency": "JPY",
        }
        cache_file.write_text(json.dumps(cache_data))
        result = statusline._cached_fetch(
            cache_file, 60, lambda: {"fresh": True}, cache_key={"currency": "JPY"}
        )
        assert result == {"cached": True}

    def test_writes_cache_file(self, tmp_path: Path) -> None:
        """取得後にキャッシュファイルが書き込まれる"""
        cache_file = tmp_path / "test-cache.json"
        statusline._cached_fetch(cache_file, 60, lambda: {"written": True})
        assert cache_file.exists()
        data = json.loads(cache_file.read_text())
        assert data["data"] == {"written": True}
        assert "_cached_at" in data

    def test_fetch_returning_none_returns_expired(self, tmp_path: Path) -> None:
        """fetch_fnがNoneを返した場合は期限切れキャッシュを返す"""
        cache_file = tmp_path / "test-cache.json"
        cache_data = {"_cached_at": 0, "data": {"expired": True}}
        cache_file.write_text(json.dumps(cache_data))
        result = statusline._cached_fetch(cache_file, 60, lambda: None)
        assert result == {"expired": True}


class TestWriteCache:
    """_write_cache のテスト"""

    def test_cleans_tmp_on_replace_failure(self, tmp_path: Path) -> None:
        """replace()失敗時にtmpファイルを削除する"""
        cache_file = tmp_path / "test-cache.json"

        with patch.object(Path, "replace", side_effect=OSError("mock failure")):
            statusline._write_cache(cache_file, {"key": "value"})

        # tmpファイルが残っていないことを確認する
        tmp_files = list(tmp_path.glob("claude-cache-*.tmp"))
        assert tmp_files == []


class TestParseArgs:
    """_parse_args のテスト"""

    def test_no_args(self) -> None:
        """引数なしの場合はデフォルト値"""
        args = statusline._parse_args([])
        assert args.icons is None
        assert args.currency is None

    def test_icons_nerd(self) -> None:
        """--icons nerd"""
        args = statusline._parse_args(["--icons", "nerd"])
        assert args.icons == "nerd"

    def test_icons_invalid(self) -> None:
        """--icons xxx は無効だがエラーにはならない"""
        args = statusline._parse_args(["--icons", "xxx"])
        assert args.icons == "xxx"

    def test_currency_jpy(self) -> None:
        """--currency jpy は大文字化される"""
        args = statusline._parse_args(["--currency", "jpy"])
        assert args.currency == "JPY"

    def test_currency_and_icons(self) -> None:
        """両方指定"""
        args = statusline._parse_args(["--icons", "nerd", "--currency", "EUR"])
        assert args.icons == "nerd"
        assert args.currency == "EUR"

    def test_segments_default(self) -> None:
        """引数なしの場合はデフォルトのセグメント構成"""
        args = statusline._parse_args([])
        assert args.segments == statusline._DEFAULT_SEGMENTS

    def test_segments_custom(self) -> None:
        """--segments でカスタム構成を指定"""
        args = statusline._parse_args(["--segments", "project,model|rate_5h"])
        assert args.segments == "project,model|rate_5h"

    def test_segments_with_other_args(self) -> None:
        """--segments と他の引数を組み合わせ"""
        args = statusline._parse_args([
            "--icons",
            "nerd",
            "--segments",
            "model",
            "--currency",
            "JPY",
        ])
        assert args.icons == "nerd"
        assert args.segments == "model"
        assert args.currency == "JPY"


class TestResolveCurrency:
    """_resolve_currency のテスト"""

    def test_valid_currency_from_arg(self) -> None:
        """CLI引数の通貨がローカル定義にあれば採用"""
        assert statusline._resolve_currency("JPY") == "JPY"

    def test_invalid_currency_from_arg_falls_back_to_locale(self) -> None:
        """CLI引数の通貨がローカル定義にないならロケール判定"""
        with patch("statusline._get_currency_from_locale", return_value="JPY"):
            assert statusline._resolve_currency("XYZ") == "JPY"

    def test_none_currency_uses_locale(self) -> None:
        """通貨未指定ならロケール判定"""
        with patch("statusline._get_currency_from_locale", return_value="JPY"):
            assert statusline._resolve_currency(None) == "JPY"

    def test_locale_currency_not_supported_falls_back_to_usd(self) -> None:
        """ロケール通貨がローカル定義にないならUSD"""
        with patch("statusline._get_currency_from_locale", return_value="XYZ"):
            assert statusline._resolve_currency(None) == "USD"


class TestExtractVersion:
    """_extract_version のテスト"""

    @pytest.mark.parametrize(
        "model_id, expected",
        [
            ("claude-opus-4-6", "4.6"),
            ("claude-sonnet-4-5-20250514", "4.5"),
            ("claude-haiku-3-5-20241022", "3.5"),
            ("", ""),
            ("unknown", ""),
            ("claude-opus-4", "4"),
            ("claude-opus-20250514", ""),
            ("claude-opus-4-beta", "4"),
            ("claude-opus-abc", ""),
        ],
    )
    def test_extract_version(self, model_id: str, expected: str) -> None:
        """モデルIDからバージョン文字列を正しく抽出する"""
        assert statusline._extract_version(model_id) == expected


class TestRemoteToHttps:
    """_remote_to_https のテスト"""

    @pytest.mark.parametrize(
        "input_url, expected",
        [
            ("git@github.com:user/repo.git", "https://github.com/user/repo"),
            ("https://github.com/user/repo.git", "https://github.com/user/repo"),
            ("https://github.com/user/repo", "https://github.com/user/repo"),
            ("svn://example.com/repo", None),
            ("  https://github.com/user/repo  ", "https://github.com/user/repo"),
        ],
    )
    def test_remote_to_https(self, input_url: str, expected: str | None) -> None:
        """GitリモートURLをHTTPS URLに正しく変換する"""
        assert statusline._remote_to_https(input_url) == expected


class TestColorForUtilization:
    """_color_for_utilization のテスト"""

    @pytest.mark.parametrize(
        "pct, expected_color",
        [
            (0, statusline._Color.GREEN),
            (59, statusline._Color.GREEN),
            (60, statusline._Color.YELLOW),
            (79, statusline._Color.YELLOW),
            (80, statusline._Color.RED),
            (100, statusline._Color.RED),
        ],
    )
    def test_color_for_utilization(
        self, pct: float, expected_color: statusline._Color
    ) -> None:
        """利用率に応じた正しいカラーを返す"""
        assert statusline._color_for_utilization(pct) == expected_color


class TestColorize:
    """_colorize のテスト"""

    @pytest.mark.parametrize(
        "text, color, expected",
        [
            ("hello", statusline._Color.RED, "\033[31mhello\033[0m"),
            ("ok", statusline._Color.GREEN, "\033[32mok\033[0m"),
            ("", statusline._Color.BLUE, "\033[34m\033[0m"),
        ],
    )
    def test_colorize(self, text: str, color: statusline._Color, expected: str) -> None:
        """ANSIカラーエスケープシーケンスを正しく生成する"""
        assert statusline._colorize(text, color) == expected


class TestGetCwd:
    """_get_cwd のテスト"""

    def test_workspace_current_dir(self) -> None:
        """workspace.current_dirを優先する"""
        data = {"workspace": {"current_dir": "/home/user/project"}, "cwd": "/var/data"}
        assert statusline._get_cwd(data) == "/home/user/project"

    def test_falls_back_to_cwd(self) -> None:
        """workspaceがない場合はcwdにフォールバック"""
        data = {"cwd": "/var/data/work"}
        assert statusline._get_cwd(data) == "/var/data/work"

    def test_workspace_without_current_dir(self) -> None:
        """workspace内にcurrent_dirがない場合はcwdにフォールバック"""
        data: dict[str, Any] = {"workspace": {}, "cwd": "/fallback"}
        assert statusline._get_cwd(data) == "/fallback"

    def test_empty_dict(self) -> None:
        """空のdictは空文字列を返す"""
        assert statusline._get_cwd({}) == ""

    def test_workspace_not_dict(self) -> None:
        """workspaceがdictでない場合はcwdにフォールバック"""
        data = {"workspace": "not-a-dict", "cwd": "/correct"}
        assert statusline._get_cwd(data) == "/correct"


class TestOsc8Link:
    """_osc8_link のテスト"""

    def test_generates_osc8_sequence(self) -> None:
        """OSC 8エスケープシーケンスを正しく生成する"""
        result = statusline._osc8_link("https://example.com", "click me")
        assert result == "\033]8;;https://example.com\aclick me\033]8;;\a"

    def test_empty_text(self) -> None:
        """空テキストでもシーケンスは生成される"""
        result = statusline._osc8_link("https://example.com", "")
        assert result == "\033]8;;https://example.com\a\033]8;;\a"


class TestFormatResetTimeShort:
    """_format_reset_time_short のテスト"""

    def test_formats_as_h_mm(self) -> None:
        """H:MM形式でフォーマットされる"""
        ts = datetime(2025, 1, 15, 14, 30, tzinfo=UTC).timestamp()
        with patch("statusline.datetime") as mock_dt:
            mock_dt.fromtimestamp.return_value.astimezone.return_value = datetime(
                2025, 1, 15, 14, 30, tzinfo=UTC
            )
            result = statusline._format_reset_time_short(ts)
        assert result == "14:30"

    def test_no_zero_padding_hour(self) -> None:
        """時間は0埋めされない"""
        ts = datetime(2025, 1, 15, 9, 5, tzinfo=UTC).timestamp()
        with patch("statusline.datetime") as mock_dt:
            mock_dt.fromtimestamp.return_value.astimezone.return_value = datetime(
                2025, 1, 15, 9, 5, tzinfo=UTC
            )
            result = statusline._format_reset_time_short(ts)
        assert result == "9:05"

    def test_midnight(self) -> None:
        """0時の表示"""
        ts = datetime(2025, 1, 15, 0, 0, tzinfo=UTC).timestamp()
        with patch("statusline.datetime") as mock_dt:
            mock_dt.fromtimestamp.return_value.astimezone.return_value = datetime(
                2025, 1, 15, 0, 0, tzinfo=UTC
            )
            result = statusline._format_reset_time_short(ts)
        assert result == "0:00"


class TestFormatResetDate:
    """_format_reset_date のテスト"""

    def test_formats_as_m_d_h_mm(self) -> None:
        """M/D H:MM形式でフォーマットされる"""
        ts = datetime(2025, 1, 15, 14, 30, tzinfo=UTC).timestamp()
        with patch("statusline.datetime") as mock_dt:
            mock_dt.fromtimestamp.return_value.astimezone.return_value = datetime(
                2025, 1, 15, 14, 30, tzinfo=UTC
            )
            result = statusline._format_reset_date(ts)
        assert result == "1/15 14:30"

    def test_no_zero_padding(self) -> None:
        """月・日・時は0埋めされない"""
        ts = datetime(2025, 3, 5, 9, 5, tzinfo=UTC).timestamp()
        with patch("statusline.datetime") as mock_dt:
            mock_dt.fromtimestamp.return_value.astimezone.return_value = datetime(
                2025, 3, 5, 9, 5, tzinfo=UTC
            )
            result = statusline._format_reset_date(ts)
        assert result == "3/5 9:05"


class TestCacheKeyMatches:
    """_cache_key_matches のテスト"""

    def test_none_key_always_matches(self) -> None:
        """cache_keyがNoneなら常にTrue"""
        assert statusline._cache_key_matches({"any": "data"}, None) is True

    def test_matching_key(self) -> None:
        """キーが一致する場合はTrue"""
        cache_obj = {"currency": "JPY", "data": 150}
        assert statusline._cache_key_matches(cache_obj, {"currency": "JPY"}) is True

    def test_non_matching_key(self) -> None:
        """キーが不一致の場合はFalse"""
        cache_obj = {"currency": "EUR", "data": 0.92}
        assert statusline._cache_key_matches(cache_obj, {"currency": "JPY"}) is False

    def test_missing_key_in_cache(self) -> None:
        """キャッシュにキーが存在しない場合はFalse"""
        cache_obj = {"data": 150}
        assert statusline._cache_key_matches(cache_obj, {"currency": "JPY"}) is False

    def test_empty_cache_key(self) -> None:
        """空のcache_keyはTrueを返す(falsyなので)"""
        assert statusline._cache_key_matches({"data": 1}, {}) is True


class TestRenderLine:
    """_render_line のテスト"""

    def test_multiple_segments(self) -> None:
        """複数セグメントをセパレータで結合する"""
        segs = [statusline.Segment(text="A"), statusline.Segment(text="B")]
        result = statusline._render_line(segs)
        assert result == "A \u2502 B"

    def test_single_segment(self) -> None:
        """単一セグメントはそのまま返す"""
        segs = [statusline.Segment(text="only")]
        assert statusline._render_line(segs) == "only"

    def test_empty_list(self) -> None:
        """空リストは空文字列を返す"""
        assert statusline._render_line([]) == ""

    def test_three_segments(self) -> None:
        """3セグメントの結合"""
        segs = [
            statusline.Segment(text="X"),
            statusline.Segment(text="Y"),
            statusline.Segment(text="Z"),
        ]
        result = statusline._render_line(segs)
        assert result == "X \u2502 Y \u2502 Z"


class TestSegProject:
    """_seg_project のテスト"""

    @staticmethod
    def _abs_cwd(name: str = "myproject") -> str:
        """テスト用のクロスプラットフォーム絶対パスを返す"""
        return str(Path(tempfile.gettempdir()) / name)

    def test_displays_project_name(self) -> None:
        """cwdからプロジェクト名を表示する"""
        data = {"cwd": self._abs_cwd()}
        seg = statusline._seg_project(data)
        assert seg is not None
        assert "myproject" in seg.text

    def test_absolute_cwd_creates_file_uri_link(self) -> None:
        """絶対パスのcwdの場合は resolve().as_uri() と完全一致するOSC 8リンクを含む"""
        data = {"cwd": self._abs_cwd()}
        seg = statusline._seg_project(data)
        assert seg is not None
        assert "myproject" in seg.text
        expected_uri = Path(data["cwd"]).resolve().as_uri()
        assert expected_uri in seg.text

    def test_relative_cwd_resolved_to_file_uri(self) -> None:
        """相対パスのcwdは resolve() で絶対化された URI と完全一致する"""
        # Path.resolve()で実行時cwd基準に絶対化されるため、file:///リンクが付く
        data = {"cwd": "relative/path/myproject"}
        seg = statusline._seg_project(data)
        assert seg is not None
        assert "myproject" in seg.text
        expected_uri = Path(data["cwd"]).resolve().as_uri()
        assert expected_uri in seg.text

    def test_empty_cwd_shows_unknown(self) -> None:
        """cwdが空の場合は"unknown"を表示する"""
        data: dict[str, Any] = {}
        seg = statusline._seg_project(data)
        assert seg is not None
        assert "unknown" in seg.text

    def test_no_longer_depends_on_git_remote(self) -> None:
        """_git の remote_url が無くてもリンクが生成される(絶対パスの場合)"""
        cwd_abs = self._abs_cwd()
        data = {"cwd": cwd_abs, "_git": {"branch": "main"}}
        seg = statusline._seg_project(data)
        assert seg is not None
        assert "myproject" in seg.text
        # _git を見なくなったので、絶対パスならリンクが付く
        expected_uri = Path(cwd_abs).resolve().as_uri()
        assert expected_uri in seg.text

    def test_resolve_failure_writes_stderr_diagnostic(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """as_uri が例外で失敗した場合は stderr 診断のみ出してリンクは付与しない"""
        data = {"cwd": self._abs_cwd()}
        with patch.object(Path, "as_uri", side_effect=ValueError("uri build error")):
            seg = statusline._seg_project(data)
        assert seg is not None
        # as_uri 失敗時は file:/// リンクが出力に含まれない
        assert "file://" not in seg.text
        err = capsys.readouterr().err
        assert "statusline:" in err
        assert "uri build error" in err

    def test_absolute_cwd_no_stderr_output(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """成功時は stderr に何も出力しない"""
        data = {"cwd": self._abs_cwd()}
        statusline._seg_project(data)
        assert capsys.readouterr().err == ""

    def test_dot_cwd_uses_resolved_name(self) -> None:
        """cwd='.' なら resolve() 後の現在ディレクトリ名が表示される"""
        data = {"cwd": "."}
        seg = statusline._seg_project(data)
        assert seg is not None
        expected_name = Path.cwd().name
        assert expected_name in seg.text

    def test_dotdot_cwd_uses_resolved_parent_name(self) -> None:
        """cwd='..' なら resolve() 後の親ディレクトリ名が表示される"""
        data = {"cwd": ".."}
        seg = statusline._seg_project(data)
        assert seg is not None
        expected_name = Path("..").resolve().name
        assert expected_name in seg.text


class TestSegBranch:
    """_seg_branch のテスト"""

    def test_displays_branch_name(self) -> None:
        """ブランチ名を表示する"""
        data = {"_git": {"branch": "main"}}
        seg = statusline._seg_branch(data)
        assert seg is not None
        assert "main" in seg.text

    def test_no_git_info_returns_none(self) -> None:
        """git情報がない場合はNone"""
        assert statusline._seg_branch({}) is None

    def test_git_info_not_dict_returns_none(self) -> None:
        """_gitがdictでない場合はNone"""
        assert statusline._seg_branch({"_git": "not-a-dict"}) is None

    def test_no_branch_returns_none(self) -> None:
        """branchキーがない場合はNone"""
        assert statusline._seg_branch({"_git": {}}) is None

    def test_with_remote_url_creates_link(self) -> None:
        """リモートURLがある場合はOSC 8リンクを含む"""
        data = {
            "_git": {
                "branch": "feature/test",
                "remote_url": "https://github.com/user/repo.git",
            },
        }
        seg = statusline._seg_branch(data)
        assert seg is not None
        assert "feature/test" in seg.text
        assert "\033]8;;" in seg.text

    def test_without_remote_url_no_link(self) -> None:
        """リモートURLがない場合はリンクなし"""
        data = {"_git": {"branch": "main"}}
        seg = statusline._seg_branch(data)
        assert seg is not None
        assert "\033]8;;" not in seg.text

    def test_unsupported_remote_protocol_no_link(self) -> None:
        """非対応プロトコルのremote_urlではリンクなし"""
        data = {"_git": {"branch": "main", "remote_url": "svn://example.com/repo"}}
        seg = statusline._seg_branch(data)
        assert seg is not None
        assert "main" in seg.text
        assert "\033]8;;" not in seg.text


class TestSegModel:
    """_seg_model のテスト"""

    def test_displays_name_with_version(self) -> None:
        """display_nameとバージョンを表示する"""
        data = {"model": {"display_name": "Opus", "id": "claude-opus-4-6"}}
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Opus 4.6" in seg.text

    def test_no_model_returns_none(self) -> None:
        """modelキーがない場合はNone"""
        assert statusline._seg_model({}) is None

    def test_model_not_dict_returns_none(self) -> None:
        """modelがdictでない場合はNone"""
        assert statusline._seg_model({"model": "string"}) is None

    def test_no_display_name_returns_none(self) -> None:
        """display_nameがない場合はNone"""
        assert statusline._seg_model({"model": {"id": "claude-opus-4-6"}}) is None

    def test_version_already_in_name_no_duplicate(self) -> None:
        """display_nameにバージョンが含まれる場合は重複しない"""
        data = {"model": {"display_name": "Opus 4.6", "id": "claude-opus-4-6"}}
        seg = statusline._seg_model(data)
        assert seg is not None
        # "Opus 4.6"が1回だけ含まれ、"Opus 4.6 4.6"にはならない
        assert "4.6 4.6" not in seg.text
        assert "Opus 4.6" in seg.text

    def test_drops_context_paren_in_display_name(self) -> None:
        """display_nameの"(1M context)"は表示しない

        1M 以外のコンテキスト長を明示して使うことはまず無く、情報量が無いためである
        """
        data = {
            "model": {"display_name": "Opus 4.6 (1M context)", "id": "claude-opus-4-6"}
        }
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Opus 4.6" in seg.text
        assert "1M" not in seg.text
        assert "(" not in seg.text

    def test_drops_200k_context_paren(self) -> None:
        """display_nameの"(200K context)"も表示しない"""
        data = {
            "model": {
                "display_name": "Sonnet 4.5 (200K context)",
                "id": "claude-sonnet-4-5-20250514",
            },
        }
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Sonnet 4.5" in seg.text
        assert "200K" not in seg.text
        assert "(" not in seg.text

    def test_no_context_suffix_unchanged(self) -> None:
        """コンテキスト情報がないdisplay_nameはそのまま"""
        data = {"model": {"display_name": "Opus", "id": "claude-opus-4-6"}}
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Opus 4.6" in seg.text

    def test_no_version_extracted(self) -> None:
        """バージョン抽出できない場合はdisplay_nameのみ"""
        data = {"model": {"display_name": "CustomModel", "id": "custom"}}
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "CustomModel" in seg.text

    def test_effort_level_appended_at_end(self) -> None:
        """effort.level は base+version の末尾に併記される"""
        data = {
            "model": {"display_name": "Opus (1M context)", "id": "claude-opus-4-7"},
            "effort": {"level": "high"},
        }
        seg = statusline._seg_model(data)
        assert seg is not None
        # 語順: base version effort (コンテキスト長の括弧は表示しない)
        assert "Opus 4.7 high" in seg.text

    def test_no_effort_no_level_text(self) -> None:
        """Effort キーがない場合は effort 表記が付かない"""
        data = {"model": {"display_name": "Sonnet", "id": "claude-sonnet-4-6"}}
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Sonnet 4.6" in seg.text
        # effort 系の語が混入しない
        for level in ("low", "medium", "high", "xhigh", "max"):
            assert level not in seg.text

    def test_effort_not_dict_ignored(self) -> None:
        """Effort が dict でない場合は無視する"""
        data = {
            "model": {"display_name": "Opus", "id": "claude-opus-4-7"},
            "effort": "high",
        }
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Opus 4.7" in seg.text
        assert "high" not in seg.text

    def test_paren_ending_with_context_dropped_entirely(self) -> None:
        """' context)'で終わる括弧は内容によらず丸ごと表示しない"""
        data = {
            "model": {
                "display_name": "Opus (1M context context)",
                "id": "claude-opus-4-7",
            },
        }
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Opus 4.7" in seg.text
        assert "(" not in seg.text

    def test_paren_without_context_unchanged(self) -> None:
        """括弧内に' context)'がない場合は括弧をそのまま保持する"""
        data = {
            "model": {
                "display_name": "Opus (preview)",
                "id": "claude-opus-4-7",
            },
        }
        seg = statusline._seg_model(data)
        assert seg is not None
        assert "Opus 4.7 (preview)" in seg.text


class TestSegContext:
    """_seg_context のテスト"""

    def test_displays_percentage(self) -> None:
        """使用率をパーセント表示する"""
        data = {"context_window": {"used_percentage": 45}}
        seg = statusline._seg_context(data)
        assert seg is not None
        assert "45%" in seg.text

    def test_no_context_window_returns_none(self) -> None:
        """context_windowがない場合はNone"""
        assert statusline._seg_context({}) is None

    def test_no_used_percentage_returns_none(self) -> None:
        """used_percentageがない場合はNone"""
        assert statusline._seg_context({"context_window": {}}) is None

    def test_high_utilization_uses_red(self) -> None:
        """80%以上はREDカラーを使用する"""
        data = {"context_window": {"used_percentage": 85}}
        seg = statusline._seg_context(data)
        assert seg is not None
        # RED(31)のANSIエスケープを含む
        assert "\033[31m" in seg.text

    def test_medium_utilization_uses_yellow(self) -> None:
        """60-79%はYELLOWカラーを使用する"""
        data = {"context_window": {"used_percentage": 65}}
        seg = statusline._seg_context(data)
        assert seg is not None
        assert "\033[33m" in seg.text

    def test_low_utilization_uses_green(self) -> None:
        """60%未満はGREENカラーを使用する"""
        data = {"context_window": {"used_percentage": 30}}
        seg = statusline._seg_context(data)
        assert seg is not None
        assert "\033[32m" in seg.text

    def test_non_numeric_percentage_returns_none(self) -> None:
        """数値変換できないused_percentageの場合はNone"""
        data = {"context_window": {"used_percentage": "abc"}}
        assert statusline._seg_context(data) is None

    def test_context_window_not_dict_returns_none(self) -> None:
        """context_windowがdictでない場合はNone"""
        assert statusline._seg_context({"context_window": "not-a-dict"}) is None

    def test_nan_percentage_returns_none(self) -> None:
        """NaN の used_percentage の場合は None (int() 例外回避)"""
        data = {"context_window": {"used_percentage": float("nan")}}
        assert statusline._seg_context(data) is None

    def test_inf_percentage_returns_none(self) -> None:
        """Infinity の used_percentage の場合は None (int() 例外回避)"""
        data = {"context_window": {"used_percentage": float("inf")}}
        assert statusline._seg_context(data) is None


class TestSegLines:
    """_seg_lines のテスト"""

    def test_displays_added_and_removed(self) -> None:
        """追加行数と削除行数を表示する"""
        data = {"cost": {"total_lines_added": 10, "total_lines_removed": 5}}
        seg = statusline._seg_lines(data)
        assert seg is not None
        assert "+10" in seg.text
        assert "-5" in seg.text

    def test_zero_changes_returns_none(self) -> None:
        """変更がない場合はNone"""
        data = {"cost": {"total_lines_added": 0, "total_lines_removed": 0}}
        assert statusline._seg_lines(data) is None

    def test_no_cost_returns_none(self) -> None:
        """costキーがない場合はNone"""
        assert statusline._seg_lines({}) is None

    def test_added_only(self) -> None:
        """追加のみの場合"""
        data = {"cost": {"total_lines_added": 20, "total_lines_removed": 0}}
        seg = statusline._seg_lines(data)
        assert seg is not None
        assert "+20" in seg.text

    def test_added_green_removed_red(self) -> None:
        """追加はGREEN、削除はREDで色付け"""
        data = {"cost": {"total_lines_added": 1, "total_lines_removed": 1}}
        seg = statusline._seg_lines(data)
        assert seg is not None
        assert "\033[32m+1\033[0m" in seg.text
        assert "\033[31m-1\033[0m" in seg.text

    def test_non_numeric_lines_returns_none(self) -> None:
        """数値変換できないline数の場合はNone"""
        data = {"cost": {"total_lines_added": "abc", "total_lines_removed": 0}}
        assert statusline._seg_lines(data) is None

    def test_cost_not_dict_returns_none(self) -> None:
        """costがdictでない場合はNone"""
        assert statusline._seg_lines({"cost": "not-a-dict"}) is None


class TestSegRateCommon:
    """_seg_rate_common のテスト"""

    def test_displays_rate_info(self) -> None:
        """レートリミット情報を表示する"""
        data = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 45.0,
                    "resets_at": 1736951400.0,
                },
            },
        }
        with patch("statusline._format_reset_time_short", return_value="14:30"):
            seg = statusline._seg_rate_common(
                data,
                "five_hour",
                "5h",
                "\u23f0",
                statusline._format_reset_time_short,
            )
        assert seg is not None
        assert "5h" in seg.text
        assert "45%" in seg.text
        assert "14:30" in seg.text

    def test_no_rate_limits_returns_none(self) -> None:
        """rate_limitsがない場合はNone"""
        seg = statusline._seg_rate_common(
            {}, "five_hour", "5h", "\u23f0", statusline._format_reset_time_short
        )
        assert seg is None

    def test_no_bucket_returns_none(self) -> None:
        """指定のバケットがない場合はNone"""
        data: dict[str, Any] = {"rate_limits": {}}
        seg = statusline._seg_rate_common(
            data, "five_hour", "5h", "\u23f0", statusline._format_reset_time_short
        )
        assert seg is None

    def test_missing_used_percentage_returns_none(self) -> None:
        """used_percentageがない場合はNone"""
        data = {"rate_limits": {"five_hour": {"resets_at": 1736951400.0}}}
        seg = statusline._seg_rate_common(
            data, "five_hour", "5h", "\u23f0", statusline._format_reset_time_short
        )
        assert seg is None

    def test_high_utilization_uses_red(self) -> None:
        """80%以上はREDカラー"""
        data = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 90.0,
                    "resets_at": 1736951400.0,
                },
            },
        }
        with patch("statusline._format_reset_time_short", return_value="14:30"):
            seg = statusline._seg_rate_common(
                data,
                "five_hour",
                "5h",
                "\u23f0",
                statusline._format_reset_time_short,
            )
        assert seg is not None
        assert "\033[31m" in seg.text

    def test_non_numeric_used_percentage_returns_none(self) -> None:
        """数値変換できないused_percentageの場合はNone"""
        data = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": "abc",
                    "resets_at": 1736951400.0,
                },
            },
        }
        seg = statusline._seg_rate_common(
            data, "five_hour", "5h", "\u23f0", statusline._format_reset_time_short
        )
        assert seg is None

    def test_missing_resets_at_returns_none(self) -> None:
        """resets_atがない場合はNone"""
        data = {"rate_limits": {"five_hour": {"used_percentage": 45.0}}}
        seg = statusline._seg_rate_common(
            data, "five_hour", "5h", "\u23f0", statusline._format_reset_time_short
        )
        assert seg is None

    def test_fmt_reset_overflow_returns_none(self) -> None:
        """fmt_resetがOverflowErrorを送出した場合はNoneを返す"""
        data = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 30.0,
                    "resets_at": 1.0,
                },
            },
        }

        def failing_fmt(_ts: float) -> str:
            raise OverflowError

        seg = statusline._seg_rate_common(data, "five_hour", "5h", "X", failing_fmt)
        assert seg is None


class TestSegRate5hAnd7d:
    """_seg_rate_5h / _seg_rate_7d の統合テスト"""

    def test_seg_rate_5h_returns_segment(self) -> None:
        """5hレートリミットセグメントを返す"""
        data = {
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 30.0,
                    "resets_at": 1736951400.0,
                },
            },
        }
        with patch("statusline._format_reset_time_short", return_value="14:30"):
            seg = statusline._seg_rate_5h(data)
        assert seg is not None
        assert "5h" in seg.text
        assert "30%" in seg.text

    def test_seg_rate_7d_returns_segment(self) -> None:
        """7dレートリミットセグメントを返す"""
        data = {
            "rate_limits": {
                "seven_day": {
                    "used_percentage": 50.0,
                    "resets_at": 1737331200.0,
                },
            },
        }
        with patch("statusline._format_reset_date", return_value="1/20 0:00"):
            seg = statusline._seg_rate_7d(data)
        assert seg is not None
        assert "7d" in seg.text
        assert "50%" in seg.text

    def test_seg_rate_5h_no_data_returns_none(self) -> None:
        """データなしの場合はNone"""
        assert statusline._seg_rate_5h({}) is None

    def test_seg_rate_7d_no_data_returns_none(self) -> None:
        """データなしの場合はNone"""
        assert statusline._seg_rate_7d({}) is None


class TestBuildLines:
    """_build_lines のテスト"""

    def test_full_data_returns_three_lines(self) -> None:
        """全データがある場合は3行を返す"""
        data = {
            "cwd": "/home/user/project",
            "_git": {
                "branch": "main",
                "remote_url": "https://github.com/user/project.git",
            },
            "model": {"display_name": "Opus", "id": "claude-opus-4-6"},
            "context_window": {"used_percentage": 45},
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 30,
                    "resets_at": 1736949000,
                },
                "seven_day": {
                    "used_percentage": 50,
                    "resets_at": 1737331200,
                },
            },
            "cost": {"total_cost_usd": 1.23},
        }
        with (
            patch.object(statusline, "_currency", "USD"),
            patch("statusline._format_reset_time_short", return_value="14:30"),
            patch("statusline._format_reset_date", return_value="1/20 0:00"),
        ):
            lines = statusline._build_lines(data)
        assert len(lines) == 3
        assert "14:30" in lines[1]
        assert "1/20 0:00" in lines[1]

    def test_minimal_data_returns_project_line(self) -> None:
        """最小データでもプロジェクト行は返る"""
        lines = statusline._build_lines({"cwd": "/home/user/project"})
        assert len(lines) >= 1
        assert "project" in lines[0]

    def test_empty_data_returns_project_unknown(self) -> None:
        """空データでも"unknown"プロジェクト行は返る"""
        lines = statusline._build_lines({})
        assert len(lines) >= 1
        assert "unknown" in lines[0]

    def test_segments_joined_with_separator(self) -> None:
        """同一行の複数セグメントはセパレータで結合される"""
        data = {
            "cwd": "/home/user/project",
            "_git": {"branch": "main"},
        }
        lines = statusline._build_lines(data)
        # 1行目: project | branch
        assert "\u2502" in lines[0]

    def test_custom_lines_config(self) -> None:
        """カスタムlines構成で指定セグメントのみ出力する"""
        data = {
            "cwd": "/home/user/project",
            "model": {"display_name": "Opus", "id": "claude-opus-4-6"},
        }
        custom_lines = statusline._parse_segments("model")
        lines = statusline._build_lines(data, custom_lines)
        assert len(lines) == 1
        assert "Opus" in lines[0]

    def test_custom_lines_excludes_unspecified(self) -> None:
        """指定されていないセグメントは出力に含まれない"""
        data = {
            "cwd": "/home/user/project",
            "_git": {"branch": "main"},
            "model": {"display_name": "Opus", "id": "claude-opus-4-6"},
        }
        custom_lines = statusline._parse_segments("model")
        lines = statusline._build_lines(data, custom_lines)
        assert len(lines) == 1
        assert "main" not in lines[0]

    def test_with_full_stdin_sample(self, tmp_path: Path) -> None:
        """実際のstdinデータ構造で_build_linesが正常に動作する"""
        cache_path = tmp_path / "session-cost.json"
        cache_path.write_text(json.dumps({"sessions": {"abc123...": 0.0}}))
        with (
            patch.object(statusline, "_currency", "USD"),
            patch.object(statusline, "_SESSION_COST_CACHE_PATH", cache_path),
            patch("statusline._format_reset_time_short", return_value="14:30"),
            patch("statusline._format_reset_date", return_value="1/20 0:00"),
        ):
            lines = statusline._build_lines(dict(_FULL_STDIN_SAMPLE))
        # stdinデータのみ(runtime注入なし)で3行: project, model+context+rate, cost
        assert len(lines) == 3
        assert "myproject" in lines[0]  # workspace.current_dirが優先される
        assert "Opus 4.6" in lines[1]
        assert "14:30" in lines[1]
        assert "1/20 0:00" in lines[1]
        assert "$0.01" in lines[2]


class TestFetchGitInfo:
    """_fetch_git_info のテスト"""

    def test_returns_branch_and_remote(self) -> None:
        """ブランチ名とリモートURLを返す"""

        def mock_run(cmd: list[str], **_kwargs: object) -> MagicMock:
            if "--abbrev-ref" in cmd:
                return MagicMock(returncode=0, stdout="main\n")
            if "get-url" in cmd:
                return MagicMock(
                    returncode=0, stdout="https://github.com/user/repo.git\n"
                )
            return MagicMock(returncode=1, stdout="")

        with patch("statusline.subprocess.run", side_effect=mock_run):
            result = statusline._fetch_git_info("/some/path")
        assert result["branch"] == "main"
        assert result["remote_url"] == "https://github.com/user/repo.git"

    def test_detached_head_uses_short_hash(self) -> None:
        """Detached HEAD時は短縮コミットハッシュを使用する"""

        def mock_run(cmd: list[str], **_kwargs: object) -> MagicMock:
            if "--abbrev-ref" in cmd:
                return MagicMock(returncode=0, stdout="HEAD\n")
            if "--short" in cmd:
                return MagicMock(returncode=0, stdout="abc1234\n")
            if "get-url" in cmd:
                return MagicMock(returncode=1, stdout="")
            return MagicMock(returncode=1, stdout="")

        with patch("statusline.subprocess.run", side_effect=mock_run):
            result = statusline._fetch_git_info("/some/path")
        assert result["branch"] == "abc1234"

    def test_no_branch_raises_runtime_error(self) -> None:
        """ブランチ取得失敗時はメッセージ付きのRuntimeErrorを送出する"""
        mock_result = MagicMock(returncode=1, stdout="")
        with (
            patch("statusline.subprocess.run", return_value=mock_result),
            pytest.raises(RuntimeError, match="git branch not detected"),
        ):
            statusline._fetch_git_info("/some/path")

    def test_no_remote_url(self) -> None:
        """リモートURLが取得できない場合はremote_urlキーなし"""

        def mock_run(cmd: list[str], **_kwargs: object) -> MagicMock:
            if "--abbrev-ref" in cmd:
                return MagicMock(returncode=0, stdout="feature\n")
            if "get-url" in cmd:
                return MagicMock(returncode=1, stdout="")
            return MagicMock(returncode=1, stdout="")

        with patch("statusline.subprocess.run", side_effect=mock_run):
            result = statusline._fetch_git_info("/some/path")
        assert result["branch"] == "feature"
        assert "remote_url" not in result


class TestGetGitInfo:
    """_get_git_info のテスト"""

    def test_fetches_and_returns_data(self, tmp_path: Path) -> None:
        """_fetch_git_infoを呼びデータを返す"""
        cache_file = tmp_path / "git-cache.json"
        with (
            patch.object(statusline, "_GIT_CACHE_PATH", cache_file),
            patch(
                "statusline._fetch_git_info",
                return_value={"branch": "main", "remote_url": "https://example.com"},
            ),
        ):
            result = statusline._get_git_info("/some/path")
        assert result == {"branch": "main", "remote_url": "https://example.com"}

    def test_returns_cached_data(self, tmp_path: Path) -> None:
        """有効なキャッシュがあればAPIを呼ばず返す"""
        cache_file = tmp_path / "git-cache.json"
        cache_data = {
            "_cached_at": time.time(),
            "data": {"branch": "cached-branch"},
            "cwd": "/some/path",
        }
        cache_file.write_text(json.dumps(cache_data))
        with patch.object(statusline, "_GIT_CACHE_PATH", cache_file):
            result = statusline._get_git_info("/some/path")
        assert result == {"branch": "cached-branch"}

    def test_different_cwd_invalidates_cache(self, tmp_path: Path) -> None:
        """cwdが異なる場合はキャッシュを無効化する"""
        cache_file = tmp_path / "git-cache.json"
        cache_data = {
            "_cached_at": time.time(),
            "data": {"branch": "old-branch"},
            "cwd": "/old/path",
        }
        cache_file.write_text(json.dumps(cache_data))
        with (
            patch.object(statusline, "_GIT_CACHE_PATH", cache_file),
            patch(
                "statusline._fetch_git_info",
                return_value={"branch": "new-branch"},
            ),
        ):
            result = statusline._get_git_info("/new/path")
        assert result == {"branch": "new-branch"}


class TestFileLock:
    """_file_lock のテスト"""

    def test_acquire_and_release(self, tmp_path: Path) -> None:
        """ロックを取得しスコープ離脱で解放する"""
        cache_path = tmp_path / "cache.json"
        lock_path = tmp_path / "cache.json.lock"
        with statusline._file_lock(cache_path):
            assert lock_path.exists()
        assert not lock_path.exists()

    def test_existing_lock_times_out(self, tmp_path: Path) -> None:
        """既存ロックがあるとタイムアウトして処理を継続する(可用性優先)"""
        cache_path = tmp_path / "cache.json"
        lock_path = tmp_path / "cache.json.lock"
        # 事前にロックファイルを作成しておく
        lock_path.touch()
        # タイムアウトしても例外は発生せず、処理を続行する
        with statusline._file_lock(cache_path, timeout_s=0.05):
            pass
        # 自プロセスが取得していないので既存ロックは解放しない
        assert lock_path.exists()


class TestGetDailyCost:
    """_get_daily_cost のテスト"""

    _FIXED_TODAY = "2026-06-26"

    @pytest.fixture(autouse=True)
    def _fixed_today(self) -> Iterator[None]:
        """statusline._today を固定日付に patch する"""
        with patch("statusline._today", return_value=self._FIXED_TODAY):
            yield

    def _make_data(
        self, total_cost_usd: float, session_id: str = "sess-a"
    ) -> dict[str, Any]:
        """テスト用のstdinデータを生成する"""
        return {
            "cost": {"total_cost_usd": total_cost_usd},
            "session_id": session_id,
        }

    def test_first_call_returns_zero(self, tmp_path: Path) -> None:
        """初回呼び出しでセッションを記録し0.0を返す"""
        cache_file = tmp_path / "daily-cost.json"

        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            result = statusline._get_daily_cost(self._make_data(0.0))

        assert result == 0.0
        cache_obj = json.loads(cache_file.read_text())
        assert cache_obj["sessions"]["sess-a"] == 0.0
        assert cache_obj["accumulated"] == 0.0

    def test_accumulates_delta_within_session(self, tmp_path: Path) -> None:
        """同一セッション内でdeltaを累積する"""
        cache_file = tmp_path / "daily-cost.json"
        cache_file.write_text(
            json.dumps({
                "date": self._FIXED_TODAY,
                "sessions": {"sess-a": 2.0},
                "accumulated": 3.0,
            })
        )

        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            result = statusline._get_daily_cost(self._make_data(5.0))

        # delta = 5.0 - 2.0 = 3.0, accumulated = 3.0 + 3.0 = 6.0
        assert result is not None
        assert result == pytest.approx(6.0)  # pyright: ignore[reportUnknownMemberType]

    def test_new_session_records_without_accumulating(self, tmp_path: Path) -> None:
        """新規セッションはlast_totalを記録するのみで累積しない"""
        cache_file = tmp_path / "daily-cost.json"
        cache_file.write_text(
            json.dumps({
                "date": self._FIXED_TODAY,
                "sessions": {"sess-a": 10.0},
                "accumulated": 15.0,
            })
        )

        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            result = statusline._get_daily_cost(self._make_data(0.5, "sess-b"))

        # 新規セッションは累積しない
        assert result is not None
        assert result == pytest.approx(15.0)  # pyright: ignore[reportUnknownMemberType]
        cache_obj = json.loads(cache_file.read_text())
        assert cache_obj["sessions"]["sess-b"] == 0.5

    def test_date_change_resets_all(self, tmp_path: Path) -> None:
        """日付が変わるとセッション追跡と累積値をリセットする"""
        cache_file = tmp_path / "daily-cost.json"
        cache_file.write_text(
            json.dumps({
                "date": "1999-01-01",
                "sessions": {"old-sess": 50.0},
                "accumulated": 100.0,
            })
        )

        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            result = statusline._get_daily_cost(self._make_data(2.0))

        assert result == 0.0
        cache_obj = json.loads(cache_file.read_text())
        assert cache_obj["date"] == self._FIXED_TODAY
        assert "old-sess" not in cache_obj["sessions"]

    def test_returns_none_without_cost_data(self) -> None:
        """costデータがない場合はNoneを返す"""
        result = statusline._get_daily_cost({})
        assert result is None

    def test_returns_none_without_total_cost_usd(self) -> None:
        """total_cost_usdがない場合はNoneを返す"""
        result = statusline._get_daily_cost({"cost": {}})
        assert result is None

    def test_non_numeric_total_cost_returns_none(self, tmp_path: Path) -> None:
        """total_cost_usdが数値変換できない場合はNoneを返す"""
        cache_file = tmp_path / "daily-cost.json"
        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            data: dict[str, Any] = {
                "cost": {"total_cost_usd": "abc"},
                "session_id": "s1",
            }
            result = statusline._get_daily_cost(data)
        assert result is None

    def test_handles_corrupt_cache(self, tmp_path: Path) -> None:
        """破損したキャッシュファイルの場合は0から開始する"""
        cache_file = tmp_path / "daily-cost.json"
        cache_file.write_text("not valid json")

        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            result = statusline._get_daily_cost(self._make_data(15.0))

        assert result == 0.0

    def test_multiple_sessions_in_a_day(self, tmp_path: Path) -> None:
        """1日に複数セッションのコストが正しく累積される"""
        cache_file = tmp_path / "daily-cost.json"

        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            # セッション1: 開始
            r = statusline._get_daily_cost(self._make_data(0.0, "s1"))
            assert r == 0.0

            # セッション1: $3使用
            r = statusline._get_daily_cost(self._make_data(3.0, "s1"))
            assert r is not None
            assert r == pytest.approx(3.0)  # pyright: ignore[reportUnknownMemberType]

            # セッション1: $5まで使用
            r = statusline._get_daily_cost(self._make_data(5.0, "s1"))
            assert r is not None
            assert r == pytest.approx(5.0)  # pyright: ignore[reportUnknownMemberType]

            # セッション2: 新セッション開始(記録のみ)
            r = statusline._get_daily_cost(self._make_data(0.0, "s2"))
            assert r is not None
            assert r == pytest.approx(5.0)  # pyright: ignore[reportUnknownMemberType]  # 前セッションの$5は保持

            # セッション2: $2使用
            r = statusline._get_daily_cost(self._make_data(2.0, "s2"))
            assert r is not None
            assert r == pytest.approx(7.0)  # pyright: ignore[reportUnknownMemberType]  # $5 + $2 = $7

    def test_concurrent_sessions_no_flipflop(self, tmp_path: Path) -> None:
        """複数セッションが交互に呼び出してもflip-flopしない"""
        cache_file = tmp_path / "daily-cost.json"

        with patch.object(statusline, "_DAILY_COST_CACHE_PATH", cache_file):
            # セッションA, B同時開始
            statusline._get_daily_cost(self._make_data(0.0, "a"))
            statusline._get_daily_cost(self._make_data(0.0, "b"))

            # セッションA: $3, B: $2
            statusline._get_daily_cost(self._make_data(3.0, "a"))
            statusline._get_daily_cost(self._make_data(2.0, "b"))

            # 交互に呼び出し(flip-flop)
            statusline._get_daily_cost(self._make_data(4.0, "a"))
            statusline._get_daily_cost(self._make_data(2.5, "b"))
            statusline._get_daily_cost(self._make_data(5.0, "a"))
            r = statusline._get_daily_cost(self._make_data(3.0, "b"))

            # 正しい合計: A=$5 + B=$3 = $8
            assert r is not None
            assert r == pytest.approx(8.0)  # pyright: ignore[reportUnknownMemberType]


class TestSegDailyCost:
    """_seg_daily_cost のテスト"""

    def test_returns_segment_with_daily_cost(self) -> None:
        """デイリーコストがある場合はフォーマットされたSegmentを返す"""
        with (
            patch.object(statusline, "_currency", "USD"),
            patch("statusline._get_daily_cost", return_value=1.23),
        ):
            seg = statusline._seg_daily_cost({})
        assert seg is not None
        assert "$1.23" in seg.text
        assert statusline._Icons().MONEY in seg.text

    def test_returns_none_when_none(self) -> None:
        """デイリーコストがNoneの場合はNoneを返す"""
        with patch("statusline._get_daily_cost", return_value=None):
            seg = statusline._seg_daily_cost({})
        assert seg is None

    def test_returns_none_when_zero(self) -> None:
        """デイリーコストが0.0の場合はNoneを返す"""
        with patch("statusline._get_daily_cost", return_value=0.0):
            seg = statusline._seg_daily_cost({})
        assert seg is None

    def test_jpy_display(self) -> None:
        """JPYの場合は円表示"""
        with (
            patch.object(statusline, "_currency", "JPY"),
            patch("statusline._get_exchange_rate", return_value=150.0),
            patch("statusline._get_daily_cost", return_value=1.00),
        ):
            seg = statusline._seg_daily_cost({})
        assert seg is not None
        assert "¥150" in seg.text

    def test_layout_cost_line_has_daily_cost(self) -> None:
        """デフォルトセグメントの3行目に_seg_daily_costが含まれる"""
        lines = statusline._parse_segments(statusline._DEFAULT_SEGMENTS)
        cost_line = lines[2]
        fn_names = [fn.__name__ for fn in cost_line.segment_fns]
        assert "_seg_session_cost" in fn_names
        assert "_seg_daily_cost" in fn_names


class TestParseSegments:
    """_parse_segments のテスト"""

    def test_single_segment(self) -> None:
        """単一セグメントを1行にパースする"""
        lines = statusline._parse_segments("project")
        assert len(lines) == 1
        assert len(lines[0].segment_fns) == 1

    def test_multiple_segments_one_line(self) -> None:
        """カンマ区切りで1行内に複数セグメントをパースする"""
        lines = statusline._parse_segments("project,branch,model")
        assert len(lines) == 1
        assert len(lines[0].segment_fns) == 3

    def test_multiple_lines(self) -> None:
        """パイプ区切りで複数行にパースする"""
        lines = statusline._parse_segments("project,branch|model,context")
        assert len(lines) == 2
        assert len(lines[0].segment_fns) == 2
        assert len(lines[1].segment_fns) == 2

    def test_unknown_segment_skipped(self) -> None:
        """不明なセグメント名は無視してスキップする"""
        lines = statusline._parse_segments("project,unknown_seg,branch")
        assert len(lines) == 1
        assert len(lines[0].segment_fns) == 2

    def test_all_unknown_produces_empty_line(self) -> None:
        """全て不明なセグメント名の行は空になり除外される"""
        lines = statusline._parse_segments("xxx,yyy|project")
        assert len(lines) == 1

    def test_default_segments_match_original(self) -> None:
        """デフォルト文字列が想定どおりの3行構成を生成する"""
        lines = statusline._parse_segments(statusline._DEFAULT_SEGMENTS)
        assert len(lines) == 3
        assert len(lines[0].segment_fns) == 2  # project, branch
        assert len(lines[1].segment_fns) == 4  # model, context, rate_5h, rate_7d
        assert len(lines[2].segment_fns) == 2  # session_cost, daily_cost

    def test_whitespace_trimmed(self) -> None:
        """セグメント名前後の空白は除去される"""
        lines = statusline._parse_segments(" project , branch | model ")
        assert len(lines) == 2
        assert len(lines[0].segment_fns) == 2
        assert len(lines[1].segment_fns) == 1

    def test_empty_string_returns_empty(self) -> None:
        """空文字列は空リストを返す"""
        lines = statusline._parse_segments("")
        assert len(lines) == 0


class TestMain:
    """main() の統合テスト"""

    @pytest.fixture(autouse=True)
    def _restore_globals(self) -> Iterator[None]:
        """テスト後にグローバル状態を復元する"""
        saved = statusline._icons, statusline._currency
        yield
        statusline._icons, statusline._currency = saved

    def test_valid_input_produces_output(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """正常なJSON入力でステータスラインが出力される"""
        with (
            patch("sys.stdin") as mock_stdin,
            patch("sys.argv", ["statusline.py"]),
            patch.object(statusline, "_get_git_info", return_value={"branch": "main"}),
            patch.object(statusline, "_resolve_currency", return_value="USD"),
            patch.object(statusline, "_get_session_cost", return_value=0.5),
            patch.object(statusline, "_get_daily_cost", return_value=1.0),
        ):
            mock_stdin.read.return_value = json.dumps(_FULL_STDIN_SAMPLE)
            statusline.main()
        output = capsys.readouterr().out
        assert "myproject" in output
        assert "main" in output

    def test_icons_nerd_flag(self, capsys: pytest.CaptureFixture[str]) -> None:
        """--icons nerd でNerd Fontsアイコンが使用される"""
        with (
            patch("sys.stdin") as mock_stdin,
            patch("sys.argv", ["statusline.py", "--icons", "nerd"]),
            patch.object(statusline, "_get_git_info", return_value=None),
            patch.object(statusline, "_resolve_currency", return_value="USD"),
            patch.object(statusline, "_get_session_cost", return_value=None),
            patch.object(statusline, "_get_daily_cost", return_value=None),
        ):
            mock_stdin.read.return_value = json.dumps(_FULL_STDIN_SAMPLE)
            statusline.main()
        output = capsys.readouterr().out
        assert statusline._ICONS_NERD.FOLDER in output

    def test_empty_stdin_no_output(self, capsys: pytest.CaptureFixture[str]) -> None:
        """空のstdinでは出力なし"""
        with (
            patch("sys.stdin") as mock_stdin,
            patch("sys.argv", ["statusline.py"]),
            patch.object(statusline, "_resolve_currency", return_value="USD"),
        ):
            mock_stdin.read.return_value = ""
            statusline.main()
        assert capsys.readouterr().out == ""

    def test_invalid_json_no_output(self, capsys: pytest.CaptureFixture[str]) -> None:
        """不正なJSONでは出力なし"""
        with (
            patch("sys.stdin") as mock_stdin,
            patch("sys.argv", ["statusline.py"]),
            patch.object(statusline, "_resolve_currency", return_value="USD"),
        ):
            mock_stdin.read.return_value = "{invalid"
            statusline.main()
        assert capsys.readouterr().out == ""

    def test_non_dict_json_no_output(self, capsys: pytest.CaptureFixture[str]) -> None:
        """JSON配列では出力なし"""
        with (
            patch("sys.stdin") as mock_stdin,
            patch("sys.argv", ["statusline.py"]),
            patch.object(statusline, "_resolve_currency", return_value="USD"),
        ):
            mock_stdin.read.return_value = "[1, 2, 3]"
            statusline.main()
        assert capsys.readouterr().out == ""

    def test_stdin_oserror_no_output(self, capsys: pytest.CaptureFixture[str]) -> None:
        """stdin読み取りのOSErrorでは出力なし"""
        with (
            patch("sys.stdin") as mock_stdin,
            patch("sys.argv", ["statusline.py"]),
            patch.object(statusline, "_resolve_currency", return_value="USD"),
        ):
            mock_stdin.read.side_effect = OSError
            statusline.main()
        assert capsys.readouterr().out == ""


_USAGE_API_SAMPLE: dict[str, Any] = {
    "five_hour": {"utilization": 28.0, "resets_at": "2026-08-22T07:19:59+00:00"},
    "seven_day": {"utilization": 51.0, "resets_at": "2026-08-23T02:59:59+00:00"},
    "seven_day_opus": None,
    "limits": [
        {
            "kind": "session",
            "group": "session",
            "percent": 28,
            "resets_at": "2026-08-22T07:19:59+00:00",
            "scope": None,
        },
        {
            "kind": "weekly_all",
            "group": "weekly",
            "percent": 51,
            "resets_at": "2026-08-23T02:59:59+00:00",
            "scope": None,
        },
        {
            "kind": "weekly_scoped",
            "group": "weekly",
            "percent": 87,
            "resets_at": "2026-08-23T02:59:59+00:00",
            "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None},
        },
    ],
}


def _write_credentials(
    path: Path,
    *,
    token: str = "tok-abc",  # noqa: S107
    expires_in_ms: int = 3_600_000,
) -> None:
    """テスト用の認証情報ファイルを書き出す"""
    expires_at = int(time.time() * 1000) + expires_in_ms
    path.write_text(
        json.dumps({
            "claudeAiOauth": {
                "accessToken": token,
                "expiresAt": expires_at,
                "subscriptionType": "max",
            }
        }),
        encoding="utf-8",
    )


class TestReadAccessToken:
    """_read_access_token のテスト"""

    def test_returns_token_when_valid(self, tmp_path: Path) -> None:
        """有効期限内のトークンを返す"""
        creds = tmp_path / "creds.json"
        _write_credentials(creds)
        with patch.object(statusline, "_CREDENTIALS_PATH", creds):
            assert statusline._read_access_token() == "tok-abc"

    def test_returns_none_when_expired(self, tmp_path: Path) -> None:
        """期限切れトークンはNoneを返す(リフレッシュは本体に任せる)"""
        creds = tmp_path / "creds.json"
        _write_credentials(creds, expires_in_ms=-1000)
        with patch.object(statusline, "_CREDENTIALS_PATH", creds):
            assert statusline._read_access_token() is None

    def test_returns_none_when_file_missing(self, tmp_path: Path) -> None:
        """認証情報ファイルがなければNoneを返す"""
        with patch.object(statusline, "_CREDENTIALS_PATH", tmp_path / "nope.json"):
            assert statusline._read_access_token() is None

    def test_returns_none_on_invalid_json(self, tmp_path: Path) -> None:
        """壊れたJSONではNoneを返す"""
        creds = tmp_path / "creds.json"
        creds.write_text("{invalid", encoding="utf-8")
        with patch.object(statusline, "_CREDENTIALS_PATH", creds):
            assert statusline._read_access_token() is None

    def test_returns_none_without_oauth_section(self, tmp_path: Path) -> None:
        """claudeAiOauthセクションがなければNoneを返す"""
        creds = tmp_path / "creds.json"
        creds.write_text(json.dumps({"mcpOAuth": {}}), encoding="utf-8")
        with patch.object(statusline, "_CREDENTIALS_PATH", creds):
            assert statusline._read_access_token() is None


class TestFetchModelUsage:
    """_fetch_usage_snapshot のテスト"""

    def _snapshot_with(self, body: dict[str, Any]) -> Any:  # noqa: ANN401
        """指定レスポンスをモックしてスナップショットを取得する"""
        with (
            patch.object(statusline, "_read_access_token", return_value="tok"),
            patch(
                "statusline.urlopen",
                return_value=_mock_http_response(json.dumps(body).encode()),
            ),
        ):
            return statusline._fetch_usage_snapshot()

    def _fetch_with(self, body: dict[str, Any]) -> Any:  # noqa: ANN401
        """指定レスポンスをモックしてモデル別枠だけを取り出す"""
        snapshot = self._snapshot_with(body)
        return None if snapshot is None else snapshot["model_scoped"]

    def test_extracts_weekly_all_bucket(self) -> None:
        """weekly_all を 7d 全体のバケットとして取り出す"""
        snapshot = self._snapshot_with(_USAGE_API_SAMPLE)
        assert snapshot is not None
        assert snapshot["weekly"] == {
            "used_percentage": 51,
            "resets_at": datetime(2026, 8, 23, 2, 59, 59, tzinfo=UTC).timestamp(),
        }

    def test_weekly_is_none_without_weekly_all(self) -> None:
        """weekly_all が無ければ 7d 全体は None になる"""
        body: dict[str, Any] = {
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "percent": 5,
                    "resets_at": None,
                    "scope": {"model": {"display_name": "Fable"}},
                }
            ]
        }
        snapshot = self._snapshot_with(body)
        assert snapshot is not None
        assert snapshot["weekly"] is None

    def test_weekly_is_none_without_reset_time(self) -> None:
        """リセット時刻が無い weekly_all は採用しない"""
        body: dict[str, Any] = {
            "limits": [{"kind": "weekly_all", "percent": 51, "resets_at": None}]
        }
        snapshot = self._snapshot_with(body)
        assert snapshot is not None
        assert snapshot["weekly"] is None

    def test_projects_weekly_scoped_entries(self) -> None:
        """weekly_scopedのモデル別枠を射影する"""
        result = self._fetch_with(_USAGE_API_SAMPLE)
        assert result is not None
        assert len(result) == 1
        assert result[0]["display_name"] == "Fable"
        assert result[0]["percent"] == 87

    def test_excludes_other_kinds(self) -> None:
        """種別が session や weekly_all の要素は対象外とする"""
        result = self._fetch_with(_USAGE_API_SAMPLE)
        assert result is not None
        assert all(e["display_name"] == "Fable" for e in result)

    def test_excludes_entries_without_model_scope(self) -> None:
        """scope.model を持たないweekly_scopedは除外する"""
        body: dict[str, Any] = {
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "percent": 10,
                    "resets_at": None,
                    "scope": {"model": None, "surface": {"display_name": "Cowork"}},
                }
            ]
        }
        assert self._fetch_with(body) == []

    def test_converts_resets_at_to_epoch(self) -> None:
        """resets_atをepoch秒に変換する"""
        result = self._fetch_with(_USAGE_API_SAMPLE)
        assert result is not None
        expected = datetime(2026, 8, 23, 2, 59, 59, tzinfo=UTC).timestamp()
        assert result[0]["resets_at"] == pytest.approx(expected)  # pyright: ignore[reportUnknownMemberType]

    def test_keeps_entry_with_null_resets_at(self) -> None:
        """resets_atがnullでもエントリを残す"""
        body: dict[str, Any] = {
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "percent": 5,
                    "resets_at": None,
                    "scope": {"model": {"display_name": "Fable"}},
                }
            ]
        }
        result = self._fetch_with(body)
        assert result is not None
        assert result[0]["resets_at"] is None

    def test_returns_empty_list_without_limits(self) -> None:
        """limitsがないレスポンスは空リストを返す"""
        assert self._fetch_with({"five_hour": None}) == []

    def test_returns_none_without_token(self) -> None:
        """トークンがない場合はHTTPを発行せずNoneを返す"""
        with (
            patch.object(statusline, "_read_access_token", return_value=None),
            patch("statusline.urlopen") as mock_urlopen,
        ):
            assert statusline._fetch_usage_snapshot() is None
        mock_urlopen.assert_not_called()

    def test_returns_none_on_http_error(self) -> None:
        """HTTP失敗時はNoneを返す"""
        with (
            patch.object(statusline, "_read_access_token", return_value="tok"),
            patch("statusline.urlopen", side_effect=URLError("boom")),
        ):
            assert statusline._fetch_usage_snapshot() is None


class TestSpawnUsageRefresh:
    """_spawn_usage_refresh のテスト"""

    @pytest.mark.skipif(sys.platform != "win32", reason="Windows 固有の起動フラグ")
    def test_hides_console_window_without_detaching_on_windows(self) -> None:
        """Windows では CREATE_NO_WINDOW だけを指定し DETACHED_PROCESS を併用しない

        DETACHED_PROCESS と併用すると CREATE_NO_WINDOW は無視される(Windows の仕様)
        uv の仮想環境では sys.executable がランチャーで実体の python.exe を
        起動し直すため、デタッチすると孫プロセスが可視のコンソール窓を割り当てる
        """
        with patch("statusline.subprocess.Popen") as popen:
            _SPAWN_USAGE_REFRESH()
        assert popen.call_args.kwargs["creationflags"] == subprocess.CREATE_NO_WINDOW


class TestGetModelUsage:
    """_get_model_usage のテスト"""

    _ENTRY: ClassVar[dict[str, Any]] = {
        "display_name": "Fable",
        "percent": 87,
        "resets_at": None,
    }

    def _write_cache(
        self, path: Path, *, cached_at: float, attempted_at: float
    ) -> None:
        """テスト用のキャッシュファイルを書き出す"""
        path.write_text(
            json.dumps({
                "_cached_at": cached_at,
                "_attempted_at": attempted_at,
                "data": [self._ENTRY],
            }),
            encoding="utf-8",
        )

    def test_returns_cached_data_within_ttl_without_spawn(self, tmp_path: Path) -> None:
        """TTL内はキャッシュを返し更新プロセスを起動しない"""
        cache = tmp_path / "usage.json"
        now = time.time()
        self._write_cache(cache, cached_at=now, attempted_at=now)
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_spawn_usage_refresh") as spawn,
        ):
            result = statusline._get_model_usage()
        assert result == [self._ENTRY]
        spawn.assert_not_called()

    def test_returns_expired_data_and_spawns(self, tmp_path: Path) -> None:
        """TTL切れでは期限切れデータを返しつつ更新を起動する

        経過時間は TTL 超過かつ STALE 以内とし、足切りとは独立に検証する
        """
        cache = tmp_path / "usage.json"
        old = time.time() - 600
        self._write_cache(cache, cached_at=old, attempted_at=old)
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_spawn_usage_refresh") as spawn,
        ):
            result = statusline._get_model_usage()
        assert result == [self._ENTRY]
        spawn.assert_called_once()

    def test_drops_entries_not_refreshed_within_stale_limit(
        self, tmp_path: Path
    ) -> None:
        """STALE を超えて更新できていないキャッシュの値は表示に使わない

        認証切れなどで更新が止まった際に古い値を出し続けないための足切りである
        """
        cache = tmp_path / "usage.json"
        now = time.time()
        self._write_cache(cache, cached_at=now - 10_000, attempted_at=now)
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_spawn_usage_refresh"),
        ):
            assert statusline._get_model_usage() is None

    def test_records_attempt_before_spawn_so_next_render_skips(
        self, tmp_path: Path
    ) -> None:
        """更新の起動前に試行時刻を記録し、直後の描画では重複起動しない

        子プロセスが取得を終える前に描画が繰り返されても更新は 1 回だけ起動する
        """
        cache = tmp_path / "usage.json"
        old = time.time() - 600
        self._write_cache(cache, cached_at=old, attempted_at=old)
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_spawn_usage_refresh") as spawn,
        ):
            statusline._get_model_usage()
            statusline._get_model_usage()
        spawn.assert_called_once()

    def test_does_not_spawn_within_retry_interval(self, tmp_path: Path) -> None:
        """直近に試行済みなら再試行を起動しない"""
        cache = tmp_path / "usage.json"
        self._write_cache(
            cache, cached_at=time.time() - 10_000, attempted_at=time.time()
        )
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_spawn_usage_refresh") as spawn,
        ):
            statusline._get_model_usage()
        spawn.assert_not_called()

    def test_spawns_and_returns_none_without_cache(self, tmp_path: Path) -> None:
        """キャッシュがなければNoneを返して更新を起動する"""
        with (
            patch.object(
                statusline, "_MODEL_USAGE_CACHE_PATH", tmp_path / "absent.json"
            ),
            patch.object(statusline, "_spawn_usage_refresh") as spawn,
        ):
            assert statusline._get_model_usage() is None
        spawn.assert_called_once()

    def test_never_performs_http_request(self, tmp_path: Path) -> None:
        """表示経路ではHTTPを発行しない"""
        with (
            patch.object(
                statusline, "_MODEL_USAGE_CACHE_PATH", tmp_path / "absent.json"
            ),
            patch.object(statusline, "_spawn_usage_refresh"),
            patch("statusline.urlopen") as mock_urlopen,
        ):
            statusline._get_model_usage()
        mock_urlopen.assert_not_called()


class TestRefreshModelUsage:
    """_refresh_model_usage のテスト"""

    _ENTRY: ClassVar[dict[str, Any]] = {
        "display_name": "Fable",
        "percent": 87,
        "resets_at": None,
    }
    _WEEKLY: ClassVar[dict[str, Any]] = {
        "used_percentage": 51,
        "resets_at": 1787454000,
    }

    def test_writes_data_on_success(self, tmp_path: Path) -> None:
        """取得成功時に週次値とモデル別枠と取得時刻を書き込む"""
        cache = tmp_path / "usage.json"
        snapshot = {"weekly": self._WEEKLY, "model_scoped": [self._ENTRY]}
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_fetch_usage_snapshot", return_value=snapshot),
        ):
            statusline._refresh_model_usage()
        obj = json.loads(cache.read_text(encoding="utf-8"))
        assert obj["data"] == [self._ENTRY]
        assert obj["weekly"] == self._WEEKLY
        assert obj["_cached_at"] > 0
        assert obj["_attempted_at"] > 0

    def test_keeps_previous_data_on_failure(self, tmp_path: Path) -> None:
        """取得失敗時も既存データを保持し試行時刻のみ更新する"""
        cache = tmp_path / "usage.json"
        cache.write_text(
            json.dumps({
                "_cached_at": 100.0,
                "_attempted_at": 100.0,
                "data": [self._ENTRY],
                "weekly": self._WEEKLY,
            }),
            encoding="utf-8",
        )
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_fetch_usage_snapshot", return_value=None),
        ):
            statusline._refresh_model_usage()
        obj = json.loads(cache.read_text(encoding="utf-8"))
        assert obj["data"] == [self._ENTRY]
        assert obj["weekly"] == self._WEEKLY
        assert obj["_cached_at"] == 100.0
        assert obj["_attempted_at"] > 100.0


class TestWithCachedWeekly:
    """_with_cached_weekly のテスト"""

    _WEEKLY: ClassVar[dict[str, Any]] = {
        "used_percentage": 51,
        "resets_at": 1787454000,
    }
    _DATA: ClassVar[dict[str, Any]] = {
        "rate_limits": {
            "five_hour": {"used_percentage": 30, "resets_at": 1787383200},
            "seven_day": {"used_percentage": 99, "resets_at": 1},
        }
    }

    def _apply(self, cache_obj: dict[str, Any] | None, tmp_path: Path) -> Any:  # noqa: ANN401
        """指定キャッシュ内容で差し替えを実行する"""
        cache = tmp_path / "usage.json"
        if cache_obj is not None:
            cache.write_text(json.dumps(cache_obj), encoding="utf-8")
        with patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache):
            return statusline._with_cached_weekly(self._DATA)

    def _fresh_cache(self, weekly: dict[str, Any], age: float = 0.0) -> dict[str, Any]:
        """指定の週次値を age 秒前に取得したキャッシュ内容を生成する"""
        return {"weekly": weekly, "_cached_at": time.time() - age}

    def test_replaces_seven_day_with_cached_value(self, tmp_path: Path) -> None:
        """キャッシュの週次値で seven_day を差し替える"""
        got = self._apply(self._fresh_cache(self._WEEKLY), tmp_path)
        assert got["rate_limits"]["seven_day"] == self._WEEKLY

    def test_keeps_five_hour_untouched(self, tmp_path: Path) -> None:
        """5h は差し替えない"""
        got = self._apply(self._fresh_cache(self._WEEKLY), tmp_path)
        assert got["rate_limits"]["five_hour"] == self._DATA["rate_limits"]["five_hour"]

    def test_returns_original_without_cache(self, tmp_path: Path) -> None:
        """キャッシュが無ければ元の data を返す"""
        assert self._apply(None, tmp_path) == self._DATA

    def test_returns_original_when_weekly_invalid(self, tmp_path: Path) -> None:
        """週次値が不正なら元の data を返す"""
        got = self._apply(self._fresh_cache({"used_percentage": None}), tmp_path)
        assert got == self._DATA

    def test_returns_original_when_cache_is_stale(self, tmp_path: Path) -> None:
        """STALE を超えて更新できていないキャッシュの週次値は使わない

        モデル別枠と同じ足切りを適用し、片方だけ古い値が混ざらないようにする
        """
        got = self._apply(self._fresh_cache(self._WEEKLY, age=10_000), tmp_path)
        assert got == self._DATA

    def test_does_not_mutate_input(self, tmp_path: Path) -> None:
        """元の data を書き換えない"""
        self._apply(self._fresh_cache(self._WEEKLY), tmp_path)
        assert self._DATA["rate_limits"]["seven_day"]["used_percentage"] == 99


class TestSegRate7dModelUsage:
    """_seg_rate_7d のモデル別枠併記のテスト"""

    _DATA: ClassVar[dict[str, Any]] = {
        "rate_limits": {"seven_day": {"used_percentage": 51, "resets_at": 1787454000}}
    }

    def _seg_with(self, entries: list[dict[str, Any]] | None) -> Any:  # noqa: ANN401
        """指定のモデル別枠でセグメントを生成する"""
        with patch.object(statusline, "_get_model_usage", return_value=entries):
            return statusline._seg_rate_7d(self._DATA)

    def test_appends_model_percent_in_parentheses(self) -> None:
        """モデル別枠を利用率の直後へ括弧で併記する"""
        seg = self._seg_with([
            {"display_name": "Fable", "percent": 88, "resets_at": None}
        ])
        assert seg is not None
        assert "51%" in seg.text
        assert "88%" in seg.text
        assert "(" in seg.text

    def test_omits_parentheses_without_model_usage(self) -> None:
        """モデル別枠がなければ括弧を出さない"""
        seg = self._seg_with(None)
        assert seg is not None
        assert "51%" in seg.text
        assert "(" not in seg.text

    def test_selects_highest_percent(self) -> None:
        """複数枠では利用率が最も高いものを併記する"""
        seg = self._seg_with([
            {"display_name": "Sonnet", "percent": 10, "resets_at": None},
            {"display_name": "Fable", "percent": 88, "resets_at": None},
        ])
        assert seg is not None
        assert "88%" in seg.text
        assert "10%" not in seg.text

    def test_colors_each_percent_independently(self) -> None:
        """本体と併記部分をそれぞれの利用率で色付けする"""
        seg = self._seg_with([
            {"display_name": "Fable", "percent": 88, "resets_at": None}
        ])
        assert seg is not None
        assert str(int(statusline._Color.GREEN)) in seg.text
        assert str(int(statusline._Color.RED)) in seg.text

    def test_ignores_invalid_percent(self) -> None:
        """利用率が不正な枠は併記しない"""
        seg = self._seg_with([
            {"display_name": "Fable", "percent": None, "resets_at": None}
        ])
        assert seg is not None
        assert "(" not in seg.text

    def test_uses_cached_weekly_for_base_value(self, tmp_path: Path) -> None:
        """通常値もキャッシュの週次値を使う(内訳と表示時点を揃えるため)"""
        cache = tmp_path / "usage.json"
        cache.write_text(
            json.dumps({
                "weekly": {"used_percentage": 60, "resets_at": 1787454000},
                "_cached_at": time.time(),
            }),
            encoding="utf-8",
        )
        with (
            patch.object(statusline, "_MODEL_USAGE_CACHE_PATH", cache),
            patch.object(statusline, "_get_model_usage", return_value=None),
        ):
            seg = statusline._seg_rate_7d(self._DATA)
        assert seg is not None
        assert "60%" in seg.text
        assert "51%" not in seg.text

    def test_does_not_affect_5h_segment(self) -> None:
        """5h セグメントには併記しない"""
        data: dict[str, Any] = {
            "rate_limits": {
                "five_hour": {"used_percentage": 32, "resets_at": 1787383200}
            }
        }
        with patch.object(
            statusline,
            "_get_model_usage",
            return_value=[{"display_name": "Fable", "percent": 88, "resets_at": None}],
        ):
            seg = statusline._seg_rate_5h(data)
        assert seg is not None
        assert "(" not in seg.text


class TestMainRefreshUsage:
    """main() の --refresh-usage 分岐のテスト"""

    def test_refresh_flag_skips_stdin(self, capsys: pytest.CaptureFixture[str]) -> None:
        """--refresh-usage ではstdinを読まず更新のみ行う"""
        with (
            patch("sys.argv", ["statusline.py", "--refresh-usage"]),
            patch("sys.stdin") as mock_stdin,
            patch.object(statusline, "_refresh_model_usage") as refresh,
        ):
            statusline.main()
        refresh.assert_called_once()
        mock_stdin.read.assert_not_called()
        assert capsys.readouterr().out == ""
