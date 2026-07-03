# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///

"""Claude Code statusline用のスクリプト

Claude Codeのステータスフックから呼び出され、ターミナル下部に
プロジェクト情報やAPIレートリミット状況を表示する
"""

# json.loads/dict.get由来のUnknown型が全関数に波及するため、ファイルレベルで抑制する
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownArgumentType=false
# pyright: reportUnknownVariableType=false
# 入力 JSON 構造の documentation 用 TypedDict 群は実行時に参照しないため抑制する
# pyright: reportUnusedClass=false

from __future__ import annotations

import argparse
import contextlib
import json
import locale
import math
import os
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import IntEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypedDict
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from collections.abc import Generator


class _ModelInput(TypedDict, total=False):
    """Claude Code statusline JSON の model フィールド"""

    id: str
    display_name: str


class _WorkspaceInput(TypedDict, total=False):
    """Claude Code statusline JSON の workspace フィールド"""

    current_dir: str
    project_dir: str
    added_dirs: list[str]
    git_worktree: str


class _CostInput(TypedDict, total=False):
    """Claude Code statusline JSON の cost フィールド"""

    total_cost_usd: float
    total_duration_ms: int
    total_api_duration_ms: int
    total_lines_added: int
    total_lines_removed: int


class _CurrentUsageInput(TypedDict, total=False):
    """context_window.current_usage の内訳"""

    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


class _ContextWindowInput(TypedDict, total=False):
    """Claude Code statusline JSON の context_window フィールド"""

    total_input_tokens: int
    total_output_tokens: int
    context_window_size: int
    used_percentage: float
    remaining_percentage: float
    current_usage: _CurrentUsageInput


class _EffortInput(TypedDict, total=False):
    """Claude Code statusline JSON の effort フィールド"""

    level: str


class _RateBucketInput(TypedDict, total=False):
    """rate_limits.five_hour / seven_day のバケット構造"""

    used_percentage: float
    resets_at: float


class _RateLimitsInput(TypedDict, total=False):
    """Claude Code statusline JSON の rate_limits フィールド"""

    five_hour: _RateBucketInput
    seven_day: _RateBucketInput


class _OutputStyleInput(TypedDict, total=False):
    """Claude Code statusline JSON の output_style フィールド"""

    name: str


class _VimInput(TypedDict, total=False):
    """Claude Code statusline JSON の vim フィールド"""

    mode: str


class _AgentInput(TypedDict, total=False):
    """Claude Code statusline JSON の agent フィールド"""

    name: str


class _WorktreeInput(TypedDict, total=False):
    """Claude Code statusline JSON の worktree フィールド"""

    name: str
    path: str
    branch: str
    original_cwd: str
    original_branch: str


class _StatuslineInput(TypedDict, total=False):  # noqa: PYI049
    """Claude Code statusline フックから stdin で渡される JSON の構造

    公式ドキュメント: https://code.claude.com/docs/en/statusline
    実行時の型保証は無いため、各 _seg_* 関数では isinstance による防御を維持する
    """

    cwd: str
    session_id: str
    transcript_path: str
    model: _ModelInput
    workspace: _WorkspaceInput
    version: str
    cost: _CostInput
    context_window: _ContextWindowInput
    exceeds_200k_tokens: bool
    effort: _EffortInput
    rate_limits: _RateLimitsInput
    output_style: _OutputStyleInput
    vim: _VimInput
    agent: _AgentInput
    worktree: _WorktreeInput


class _Color(IntEnum):
    """ANSIカラーコード"""

    RED = 31
    GREEN = 32
    YELLOW = 33
    BLUE = 34
    RESET = 0


@dataclass(frozen=True, slots=True)
class Segment:
    """ステータスライン上の1セグメントを表す"""

    text: str


@dataclass(frozen=True, slots=True)
class _LineConfig:
    """行のレイアウト定義"""

    segment_fns: list[Callable[[dict[str, Any]], Segment | None]] = field(
        default_factory=list,
    )


@dataclass(frozen=True, slots=True)
class _CurrencyInfo:
    """通貨のフォーマット情報"""

    symbol: str
    decimals: int


@dataclass(frozen=True, slots=True)
class _Icons:
    """アイコンセットの定義"""

    FOLDER: str = "📁"
    BRANCH: str = "🔀"
    MODEL: str = "🤖"
    CHART: str = "📊"
    PENCIL: str = "✏️"
    CLOCK: str = "⏰"
    CALENDAR: str = "📅"
    RESET: str = "🔁"
    MONEY: str = "💰"


_SEPARATOR = " \u2502 "  # " │ "
_API_TIMEOUT = 5  # 秒
_SUBPROCESS_TIMEOUT = 3  # 秒
_GIT_CACHE_TTL = 5  # 秒
_GIT_CACHE_PATH = Path(tempfile.gettempdir()) / "claude-git-cache.json"
_EXCHANGE_CACHE_PATH = Path(tempfile.gettempdir()) / "claude-exchange-cache.json"
_SESSION_COST_CACHE_PATH = Path(tempfile.gettempdir()) / "claude-session-cost.json"
_DAILY_COST_CACHE_PATH = Path(tempfile.gettempdir()) / "claude-daily-cost.json"
_EXCHANGE_API_URL = "https://api.frankfurter.app/latest?from=USD&to={currency}"

_CURRENCIES: dict[str, _CurrencyInfo] = {
    "USD": _CurrencyInfo(symbol="$", decimals=2),
    "EUR": _CurrencyInfo(symbol="\u20ac", decimals=2),
    "GBP": _CurrencyInfo(symbol="\u00a3", decimals=2),
    "JPY": _CurrencyInfo(symbol="\u00a5", decimals=0),
    "CNY": _CurrencyInfo(symbol="\u00a5", decimals=2),
    "KRW": _CurrencyInfo(symbol="\u20a9", decimals=0),
    "INR": _CurrencyInfo(symbol="\u20b9", decimals=2),
    "CAD": _CurrencyInfo(symbol="C$", decimals=2),
    "AUD": _CurrencyInfo(symbol="A$", decimals=2),
    "CHF": _CurrencyInfo(symbol="CHF", decimals=2),
    "BRL": _CurrencyInfo(symbol="R$", decimals=2),
    "SEK": _CurrencyInfo(symbol="kr", decimals=2),
    "NOK": _CurrencyInfo(symbol="kr", decimals=2),
    "DKK": _CurrencyInfo(symbol="kr", decimals=2),
    "PLN": _CurrencyInfo(symbol="z\u0142", decimals=2),
    "CZK": _CurrencyInfo(symbol="K\u010d", decimals=2),
    "SGD": _CurrencyInfo(symbol="S$", decimals=2),
    "HKD": _CurrencyInfo(symbol="HK$", decimals=2),
    "MXN": _CurrencyInfo(symbol="MX$", decimals=2),
    "HUF": _CurrencyInfo(symbol="Ft", decimals=0),
    "IDR": _CurrencyInfo(symbol="Rp", decimals=0),
    "ILS": _CurrencyInfo(symbol="\u20aa", decimals=2),
    "ISK": _CurrencyInfo(symbol="kr", decimals=0),
    "MYR": _CurrencyInfo(symbol="RM", decimals=2),
    "NZD": _CurrencyInfo(symbol="NZ$", decimals=2),
    "PHP": _CurrencyInfo(symbol="\u20b1", decimals=2),
    "RON": _CurrencyInfo(symbol="lei", decimals=2),
    "THB": _CurrencyInfo(symbol="\u0e3f", decimals=2),
    "TRY": _CurrencyInfo(symbol="\u20ba", decimals=2),
    "ZAR": _CurrencyInfo(symbol="R", decimals=2),
}

_LOCALE_TO_CURRENCY: dict[str, str] = {
    "JP": "JPY",
    "US": "USD",
    "GB": "GBP",
    "DE": "EUR",
    "FR": "EUR",
    "IT": "EUR",
    "ES": "EUR",
    "NL": "EUR",
    "BE": "EUR",
    "AT": "EUR",
    "FI": "EUR",
    "IE": "EUR",
    "PT": "EUR",
    "GR": "EUR",
    "LU": "EUR",
    "CN": "CNY",
    "KR": "KRW",
    "IN": "INR",
    "CA": "CAD",
    "AU": "AUD",
    "CH": "CHF",
    "BR": "BRL",
    "SE": "SEK",
    "NO": "NOK",
    "DK": "DKK",
    "PL": "PLN",
    "CZ": "CZK",
    "SG": "SGD",
    "HK": "HKD",
    "MX": "MXN",
    "HU": "HUF",
    "ID": "IDR",
    "IL": "ILS",
    "IS": "ISK",
    "MY": "MYR",
    "NZ": "NZD",
    "PH": "PHP",
    "RO": "RON",
    "TH": "THB",
    "TR": "TRY",
    "ZA": "ZAR",
}

_ICONS_NERD = _Icons(
    FOLDER="\uf07b",  # nf-fa-folder
    BRANCH="\ue725",  # nf-dev-git_branch
    MODEL="\U000f167a",  # nf-md-robot_outline
    CHART="\uf201",  # nf-fa-line_chart
    PENCIL="\U000f03eb",  # nf-md-pencil
    CLOCK="\uf017",  # nf-fa-clock_o
    CALENDAR="\ueab0",  # nf-cod-calendar
    RESET="\uf0e2",  # nf-fa-undo
    MONEY="\uefca",  # nf-fa-money_check_dollar
)

_icons: _Icons = _Icons()
_currency: str = "USD"


def _today() -> str:
    """今日の日付をYYYY-MM-DD形式で返す"""
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def _safe_float(value: object) -> float | None:
    """値をfloatに安全に変換する"""
    try:
        return float(value)  # type: ignore[arg-type]
    except ValueError, TypeError:
        return None


def _safe_int(value: object) -> int | None:
    """値をintに安全に変換する"""
    try:
        return int(value)  # type: ignore[arg-type]
    except ValueError, TypeError:
        return None


def _colorize(text: str, color: _Color) -> str:
    """テキストにANSIカラーエスケープを付与する"""
    return f"\033[{color.value}m{text}\033[0m"


def _color_for_utilization(pct: float) -> _Color:
    """利用率に応じたカラーを返す

    0-59%: GREEN, 60-79%: YELLOW, 80-100%: RED
    """
    if pct >= 80:
        return _Color.RED
    if pct >= 60:
        return _Color.YELLOW
    return _Color.GREEN


def _format_reset_time_short(ts: float) -> str:
    """リセット時刻を "H:MM" 形式でフォーマットする(0埋めなし)"""
    local_dt = datetime.fromtimestamp(ts, tz=UTC).astimezone()
    return f"{local_dt.hour}:{local_dt.minute:02d}"


def _format_reset_date(ts: float) -> str:
    """リセット時刻を "M/D H:MM" 形式でフォーマットする(0埋めなし)"""
    local_dt = datetime.fromtimestamp(ts, tz=UTC).astimezone()
    return f"{local_dt.month}/{local_dt.day} {local_dt.hour}:{local_dt.minute:02d}"


def _osc8_link(url: str, text: str) -> str:
    """OSC 8エスケープシーケンスでクリッカブルリンクを生成する

    対応ターミナル(iTerm2, Kitty, WezTerm等)ではCtrl+クリックで開ける
    非対応ターミナルでは通常テキストとして表示される
    """
    return f"\033]8;;{url}\a{text}\033]8;;\a"


def _remote_to_https(remote_url: str) -> str | None:
    """GitリモートURLをHTTPS URLに変換する

    SSH形式(git@github.com:user/repo.git)とHTTPS形式の両方に対応する
    """
    url = remote_url.strip()
    if url.startswith("git@"):
        # git@github.com:user/repo.git -> https://github.com/user/repo
        url = url.replace(":", "/", 1).replace("git@", "https://", 1)
    url = url.removesuffix(".git")
    if url.startswith("https://"):
        return url
    return None


def _extract_version(model_id: str) -> str:
    """モデルIDからバージョン文字列を抽出する

    "claude-opus-4-6" -> "4.6"
    "claude-sonnet-4-5-20250514" -> "4.5"
    "claude-haiku-3-5-20241022" -> "3.5"
    """
    # "claude-" プレフィクスを除去
    rest = model_id.removeprefix("claude-")

    # モデルファミリー名を除去(opus, sonnet, haikuなど)
    parts = rest.split("-")
    if len(parts) < 2:
        return ""

    # ファミリー名以降で数字部分を探す
    digit_parts: list[str] = []
    found_digit = False
    for part in parts[1:]:
        if part.isdigit():
            if len(part) >= 4:
                break  # 日付文字列(20240229等)はバージョンではないためスキップ
            found_digit = True
            digit_parts.append(part)
            # メジャー.マイナーの2つまで取得する
            if len(digit_parts) >= 2:
                break
        elif found_digit:
            break  # 数字の連続が途切れたら終了

    if not digit_parts:
        return ""

    return ".".join(digit_parts)


def _cache_key_matches(
    cache_obj: dict[str, Any], cache_key: dict[str, str] | None
) -> bool:
    """キャッシュオブジェクトのキーが期待値と一致するか判定する"""
    if not cache_key:
        return True
    return all(cache_obj.get(k) == v for k, v in cache_key.items())


def _write_cache(cache_path: Path, cache_obj: dict[str, Any]) -> None:
    """Atomic writeでキャッシュファイルを書き込む"""
    with contextlib.suppress(OSError):
        tmp_fd, tmp_name = tempfile.mkstemp(
            dir=cache_path.parent, suffix=".tmp", prefix="claude-cache-"
        )
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(cache_obj, f)
            Path(tmp_name).replace(cache_path)
            cache_path.chmod(0o600)
        except OSError:
            with contextlib.suppress(OSError):
                Path(tmp_name).unlink()


@contextlib.contextmanager
def _file_lock(cache_path: Path, timeout_s: float = 1.0) -> Generator[None]:
    """ファイルキャッシュ更新の排他ロックを取得するcontext manager

    `<cache_path>.lock` を O_CREAT | O_EXCL で作成して排他制御を行う
    タイムアウト時はロック取得を諦めて処理を続行する(可用性を優先)
    複数 statusline プロセスがキャッシュをread-modify-writeする際の競合を直列化する
    """
    lock_path = cache_path.parent / (cache_path.name + ".lock")
    deadline = time.monotonic() + timeout_s
    fd: int | None = None
    while time.monotonic() < deadline:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            time.sleep(0.01)
    try:
        yield
    finally:
        if fd is not None:
            with contextlib.suppress(OSError):
                os.close(fd)
            with contextlib.suppress(OSError):
                lock_path.unlink()


def _cached_fetch(
    cache_path: Path,
    ttl: int,
    fetch_fn: Callable[[], Any],
    cache_key: dict[str, str] | None = None,
) -> Any | None:  # noqa: ANN401
    """汎用キャッシュ付きデータ取得関数

    キャッシュファイルからデータを読み取り、TTL内かつcache_keyが一致すれば返す
    TTL切れ/キャッシュなし/cache_key不一致の場合はfetch_fnを呼び出す
    fetch_fn失敗時はcache_keyが一致する期限切れキャッシュをフォールバックとして返す

    cache_keyにdateを含めればTTLに頼らず日付変更で無効化できる
    その場合ttlにsys.maxsizeを渡すことでTTLを実質無効にする
    """
    now = datetime.now(UTC).timestamp()
    expired_data: Any | None = None

    # キャッシュチェック
    with contextlib.suppress(OSError, json.JSONDecodeError, KeyError, TypeError):
        cache_text = cache_path.read_text(encoding="utf-8")
        cache_obj = json.loads(cache_text)

        if _cache_key_matches(cache_obj, cache_key):
            data = cache_obj.get("data")
            if data is not None:
                expired_data = data
                if now - cache_obj.get("_cached_at", 0) < ttl:
                    return data

    # データ取得
    try:
        data = fetch_fn()
        if data is None:
            return expired_data
    except Exception:  # noqa: BLE001
        return expired_data

    # キャッシュ保存
    cache_obj = {"_cached_at": now, "data": data}
    if cache_key:
        cache_obj.update(cache_key)
    _write_cache(cache_path, cache_obj)

    return data


def _get_currency_from_locale() -> str:
    """システムロケールから通貨コードを判定する

    ロケール文字列から国コードを抽出し、対応する通貨コードを返す
    POSIX形式(ja_JP)とWindowsフルネーム形式(Japanese_Japan)の両方に対応する
    判定できない場合はUSDを返す
    """
    try:
        loc, _ = locale.getlocale()
    except ValueError:
        return "USD"
    if not loc:
        return "USD"
    parts = loc.split("_")
    if len(parts) < 2:
        return "USD"
    # POSIX形式: "ja_JP" -> "JP", "en_US" -> "US"
    country = parts[1].split(".")[0].upper()
    currency = _LOCALE_TO_CURRENCY.get(country)
    if not currency:
        # Windowsフルネーム形式のフォールバック:
        # 言語名からlocale_aliasでPOSIXロケールを推定する
        # 例: "Japanese" -> "ja_JP.eucJP" -> "JP"
        alias = locale.locale_alias.get(parts[0].lower(), "")
        alias_parts = alias.split("_")
        if len(alias_parts) >= 2:
            country = alias_parts[1].split(".")[0].upper()
        currency = _LOCALE_TO_CURRENCY.get(country)
    return currency or "USD"


def _get_exchange_rate(currency: str) -> float | None:
    """USD→指定通貨の為替レートを取得する(キャッシュ付き)"""
    if currency == "USD":
        return None

    def fetch() -> float:
        url = _EXCHANGE_API_URL.format(currency=currency)
        req = Request(url, headers={"User-Agent": "statusline/1.0"})  # noqa: S310
        with urlopen(req, timeout=_API_TIMEOUT) as resp:  # noqa: S310
            body = resp.read().decode("utf-8")
        rate = json.loads(body).get("rates", {}).get(currency)
        if rate is None:
            msg = f"rate not found for {currency}"
            raise ValueError(msg)
        return float(rate)

    today = _today()
    result = _cached_fetch(
        _EXCHANGE_CACHE_PATH,
        sys.maxsize,
        fetch,
        cache_key={"currency": currency, "date": today},
    )
    return float(result) if result is not None else None


def _format_cost(cost_usd: float) -> str:
    """コスト値を現在の通貨設定でフォーマットする

    _currencyがUSDの場合はそのまま表示する
    為替レート取得失敗時はUSDにフォールバックする
    """
    if _currency == "USD":
        return f"${cost_usd:,.2f}"

    rate = _get_exchange_rate(_currency)
    if rate is None:
        return f"${cost_usd:,.2f}"

    info = _CURRENCIES.get(_currency)
    if info is None:
        return f"${cost_usd:,.2f}"

    converted = cost_usd * rate
    return f"{info.symbol}{converted:,.{info.decimals}f}"


def _resolve_currency(currency_arg: str | None) -> str:
    """CLI引数とロケールから通貨コードを決定する

    優先順位: CLI引数 → ロケール判定 → USD
    ローカルの_CURRENCIESを一次ソースとし、ネットワーク呼び出しを行わない
    APIの対応通貨チェックはレート取得時に自然に行われる
    """
    supported = set(_CURRENCIES)

    if currency_arg and currency_arg in supported:
        return currency_arg

    locale_currency = _get_currency_from_locale()
    if locale_currency in supported:
        return locale_currency

    return "USD"


def _get_cwd(data: dict[str, Any]) -> str:
    """stdinデータからカレントディレクトリを取得する

    workspace.current_dirを優先し、フォールバックとしてcwdを使用する
    """
    workspace = data.get("workspace")
    if isinstance(workspace, dict):
        current_dir = workspace.get("current_dir")
        if current_dir:
            return str(current_dir)
    return str(data.get("cwd", ""))


def _fetch_git_info(cwd: str) -> dict[str, Any]:
    """Gitのブランチ名とリモートURLを取得する"""
    info: dict[str, Any] = {}
    result = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],  # noqa: S607
        capture_output=True,
        text=True,
        cwd=cwd or None,
        timeout=_SUBPROCESS_TIMEOUT,
        check=False,
    )
    branch = result.stdout.strip() if result.returncode == 0 else ""

    if branch == "HEAD":
        # Detached HEAD状態では短縮コミットハッシュを取得する
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607
            capture_output=True,
            text=True,
            cwd=cwd or None,
            timeout=_SUBPROCESS_TIMEOUT,
            check=False,
        )
        branch = result.stdout.strip()

    if not branch:
        msg = "git branch not detected"
        raise RuntimeError(msg)

    info["branch"] = branch

    # リモートURLを取得する
    result = subprocess.run(
        ["git", "remote", "get-url", "origin"],  # noqa: S607
        capture_output=True,
        text=True,
        cwd=cwd or None,
        timeout=_SUBPROCESS_TIMEOUT,
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        info["remote_url"] = result.stdout.strip()

    return info


def _get_git_info(cwd: str) -> dict[str, Any] | None:
    """Gitのブランチ名とリモートURLをキャッシュ付きで取得する

    キャッシュのTTLは_GIT_CACHE_TTL秒である
    cwdが変わった場合はキャッシュを無効化する
    """
    return _cached_fetch(
        _GIT_CACHE_PATH,
        _GIT_CACHE_TTL,
        lambda: _fetch_git_info(cwd),
        cache_key={"cwd": cwd},
    )


def _get_session_cost(data: dict[str, Any]) -> float | None:
    """セッション単位のコストを算出する

    total_cost_usdはセッションスコープ(各セッションで0から開始)であるが、
    Claude Codeの再起動等でセッションIDが変わらずコストが引き継がれるケースに備え、
    セッション開始時のコストをベースラインとして記録し差分を返す
    """
    cost = data.get("cost")
    total_cost = cost.get("total_cost_usd") if isinstance(cost, dict) else None
    if total_cost is None:
        return None

    total_cost_val = _safe_float(total_cost)
    if total_cost_val is None:
        return None

    session_id = data.get("session_id")
    if not session_id:
        return total_cost_val

    # セッションキャッシュを読み込む(セッションIDごとの辞書形式)
    sessions: dict[str, float] = {}
    with contextlib.suppress(OSError, json.JSONDecodeError, KeyError, TypeError):
        cache_text = _SESSION_COST_CACHE_PATH.read_text(encoding="utf-8")
        cache_obj = json.loads(cache_text)
        sessions = cache_obj.get("sessions", {})

    if session_id in sessions:
        baseline = float(sessions[session_id])
        return total_cost_val - baseline

    # 新しいセッション: 現在のコストをベースラインとして記録する
    sessions[session_id] = total_cost_val
    _write_cache(_SESSION_COST_CACHE_PATH, {"sessions": sessions})
    return 0.0


def _get_daily_cost(data: dict[str, Any]) -> float | None:
    """日次コストをセッション別delta累積方式で算出する

    total_cost_usdはセッションスコープ(各セッションで0から開始)のため、
    session_idごとにlast_totalを追跡しdeltaを累積する
    - 既知のセッション: delta(前回値との差分)を加算する
    - 新規セッション: last_totalを記録し、次回以降のdeltaから累積する
    - 日付変更時: 全セッションの追跡と累積値をリセットする
    """
    cost = data.get("cost")
    total_cost = cost.get("total_cost_usd") if isinstance(cost, dict) else None
    if total_cost is None:
        return None

    current_total = _safe_float(total_cost)
    if current_total is None:
        return None

    session_id = str(data.get("session_id", ""))
    today = _today()

    accumulated = 0.0
    sessions: dict[str, float] = {}

    # 複数 statusline プロセスがキャッシュをread-modify-writeする際の
    # 競合を防ぐためロック内で一連の処理を直列化する
    with _file_lock(_DAILY_COST_CACHE_PATH):
        with contextlib.suppress(OSError, json.JSONDecodeError, KeyError, TypeError):
            cache_text = _DAILY_COST_CACHE_PATH.read_text(encoding="utf-8")
            cache_obj = json.loads(cache_text)

            if cache_obj.get("date") == today:
                accumulated = float(cache_obj.get("accumulated", 0.0))
                sessions = cache_obj.get("sessions", {})

        if session_id in sessions:
            delta = current_total - sessions[session_id]
            if delta > 0:
                accumulated += delta
        # 新規セッションはlast_totalを記録するのみ
        # (日跨ぎセッションの昨日分コストを含めないため)

        if sessions.get(session_id) != current_total:
            sessions[session_id] = current_total
            _write_cache(
                _DAILY_COST_CACHE_PATH,
                {
                    "date": today,
                    "sessions": sessions,
                    "accumulated": accumulated,
                },
            )
    return accumulated


def _seg_project(data: dict[str, Any]) -> Segment | None:
    """プロジェクト名セグメントを生成する

    cwdを file:/// URLに変換してOSC 8クリッカブルリンクにする
    表示テキストはbasenameのみとし、リンク先のみカレントディレクトリを指す
    """
    cwd = _get_cwd(data)
    path_obj = Path(cwd)
    name = path_obj.name or "unknown"

    # cwd を file:/// URL に変換する
    # resolve() で相対パスも絶対化してから as_uri() を呼ぶ
    # 解決後のパスから basename も取得し、表示名とリンク先の整合を保つ
    # (例: cwd="." や ".." で表示名が空や ".." になるのを防ぐ)
    # 失敗時は stderr に診断情報を出力する(stdout は statusline 表示に使われる)
    cwd_url: str | None = None
    if cwd:
        try:
            resolved = path_obj.resolve()
            cwd_url = resolved.as_uri()
            name = resolved.name or name
        except (OSError, ValueError) as e:
            sys.stderr.write(
                f"statusline: cannot build file URI from cwd={cwd!r}: {e}\n"
            )
            cwd_url = None

    display = f"{_icons.FOLDER} {name}"
    if cwd_url:
        display = f"{_icons.FOLDER} {_osc8_link(cwd_url, name)}"

    label = _colorize(display, _Color.BLUE)
    return Segment(text=label)


def _seg_branch(data: dict[str, Any]) -> Segment | None:
    """Gitブランチ名セグメントを生成する

    GitリモートURLが取得できる場合はOSC 8クリッカブルリンクにする
    """
    git_info = data.get("_git")
    if not isinstance(git_info, dict):
        return None
    branch = git_info.get("branch")
    if not branch:
        return None

    # リモートURLからブランチページのリンクを生成する
    remote_url = git_info.get("remote_url", "")
    branch_url = None
    if remote_url:
        repo_url = _remote_to_https(remote_url)
        if repo_url:
            branch_url = f"{repo_url}/tree/{branch}"

    if branch_url:
        display = f"{_icons.BRANCH} {_osc8_link(branch_url, branch)}"
    else:
        display = f"{_icons.BRANCH} {branch}"

    label = _colorize(display, _Color.YELLOW)
    return Segment(text=label)


def _seg_model(data: dict[str, Any]) -> Segment | None:
    """モデル名セグメントを生成する

    display_nameを base_name と括弧部分に分離し、
    "base_name version (context) effort" の順で組み立てる
    例: display_name="Opus (1M context)", id="claude-opus-4-7", effort="high"
    -> "Opus 4.7 (1M) high"
    """
    model = data.get("model")
    if not isinstance(model, dict):
        return None

    display_name = str(model.get("display_name", ""))
    model_id = str(model.get("id", ""))

    if not display_name:
        return None

    # display_name から括弧部分を分離する
    # 例: "Opus (1M context)" -> base="Opus", paren="(1M)"
    base_name = display_name
    paren_text = ""
    paren_idx = display_name.find("(")
    if paren_idx >= 0:
        base_name = display_name[:paren_idx].rstrip()
        paren_text = display_name[paren_idx:]
        # 末尾の " context)" のみを ")" に短縮する
        # (内部に出現する "context" の文字列を意図せず置換しないため)
        context_suffix = " context)"
        if paren_text.endswith(context_suffix):
            paren_text = paren_text[: -len(context_suffix)] + ")"

    # model_idからバージョン番号を抽出する
    # 例: "claude-opus-4-6" -> "4.6"
    version = _extract_version(model_id)

    parts: list[str] = [base_name]
    if version and version not in base_name:
        parts.append(version)
    if paren_text:
        parts.append(paren_text)

    # effort.levelがあれば末尾に併記する
    # 例: "low", "medium", "high", "xhigh", "max"
    effort = data.get("effort")
    if isinstance(effort, dict):
        level = effort.get("level")
        if level:
            parts.append(str(level))

    model_text = " ".join(parts)
    label = f"{_icons.MODEL} {model_text}"
    return Segment(text=label)


def _seg_context(data: dict[str, Any]) -> Segment | None:
    """コンテキストウィンドウ使用率セグメントを生成する"""
    ctx = data.get("context_window")
    if not isinstance(ctx, dict):
        return None

    pct = ctx.get("used_percentage")
    if pct is None:
        return None

    pct_val = _safe_float(pct)
    if pct_val is None or not math.isfinite(pct_val):
        return None
    pct_int = int(pct_val)
    color = _color_for_utilization(pct_val)
    pct_str = f"{pct_int}%"

    colored_pct = _colorize(pct_str, color)
    label = f"{_icons.CHART} {colored_pct}"
    # 表示幅: アイコン(1) + 空白(1) + パーセント文字列
    return Segment(text=label)


def _seg_lines(data: dict[str, Any]) -> Segment | None:
    """変更行数セグメントを生成する"""
    cost = data.get("cost")
    if not isinstance(cost, dict):
        return None

    added = _safe_int(cost.get("total_lines_added", 0))
    removed = _safe_int(cost.get("total_lines_removed", 0))
    if added is None or removed is None:
        return None

    if added == 0 and removed == 0:
        return None

    colored_add = _colorize(f"+{added}", _Color.GREEN)
    colored_del = _colorize(f"-{removed}", _Color.RED)
    label = f"{_icons.PENCIL} {colored_add}/{colored_del}"
    return Segment(text=label)


def _seg_rate_common(
    data: dict[str, Any],
    usage_key: str,
    period_label: str,
    icon: str,
    fmt_reset: Callable[[int | float], str],
) -> Segment | None:
    """レートリミットセグメントの共通生成ロジック"""
    usage = data.get("rate_limits")
    if not isinstance(usage, dict):
        return None

    bucket = usage.get(usage_key)
    if not isinstance(bucket, dict):
        return None

    pct_val = _safe_float(bucket.get("used_percentage"))
    ts = _safe_float(bucket.get("resets_at"))
    if (
        pct_val is None
        or ts is None
        or not math.isfinite(pct_val)
        or not math.isfinite(ts)
    ):
        return None
    try:
        reset_str = fmt_reset(ts)
    except ValueError, TypeError, OverflowError, OSError:
        return None

    color = _color_for_utilization(pct_val)

    pct_str = f"{int(pct_val)}%"
    colored_pct = _colorize(pct_str, color)
    label = f"{icon} {period_label} {colored_pct} {_icons.RESET} {reset_str}"
    return Segment(text=label)


def _seg_rate_5h(data: dict[str, Any]) -> Segment | None:
    """5時間レートリミットセグメントを生成する"""
    return _seg_rate_common(
        data, "five_hour", "5h", _icons.CLOCK, _format_reset_time_short
    )


def _seg_rate_7d(data: dict[str, Any]) -> Segment | None:
    """7日間レートリミットセグメントを生成する"""
    return _seg_rate_common(
        data, "seven_day", "7d", _icons.CALENDAR, _format_reset_date
    )


def _seg_session_cost(data: dict[str, Any]) -> Segment | None:
    """セッションコストセグメントを生成する"""
    cost_val = _get_session_cost(data)
    if cost_val is None:
        return None

    label = f"{_icons.MONEY} {_format_cost(cost_val)} (session)"
    return Segment(text=label)


def _seg_daily_cost(data: dict[str, Any]) -> Segment | None:
    """デイリーコストセグメントを生成する"""
    daily = _get_daily_cost(data)
    if daily is None or daily <= 0.0:
        return None

    label = f"{_icons.MONEY} {_format_cost(daily)} (daily)"
    return Segment(text=label)


def _render_line(segments: list[Segment]) -> str:
    """セグメントのリストをセパレータで結合して1行にする"""
    sep = _SEPARATOR
    return sep.join(s.text for s in segments)


def _build_lines(
    data: dict[str, Any],
    lines: list[_LineConfig] | None = None,
) -> list[str]:
    """行定義に従ってステータスラインを構築する"""
    if lines is None:
        lines = _parse_segments(_DEFAULT_SEGMENTS)

    output_lines: list[str] = []

    for line_cfg in lines:
        segments: list[Segment] = []
        for fn in line_cfg.segment_fns:
            seg = fn(data)
            if seg is not None:
                segments.append(seg)

        if segments:
            output_lines.append(_render_line(segments))

    return output_lines


_SEGMENT_REGISTRY: dict[str, Callable[[dict[str, Any]], Segment | None]] = {
    "project": _seg_project,
    "branch": _seg_branch,
    "model": _seg_model,
    "context": _seg_context,
    "lines": _seg_lines,
    "rate_5h": _seg_rate_5h,
    "rate_7d": _seg_rate_7d,
    "session_cost": _seg_session_cost,
    "daily_cost": _seg_daily_cost,
}

_DEFAULT_SEGMENTS = (
    "project,branch|model,context,rate_5h,rate_7d|session_cost,daily_cost"
)


def _parse_segments(segments_str: str) -> list[_LineConfig]:
    """セグメント構成文字列をパースしてLineConfigリストを生成する"""
    if not segments_str.strip():
        return []

    result: list[_LineConfig] = []
    for line_str in segments_str.split("|"):
        fns: list[Callable[[dict[str, Any]], Segment | None]] = []
        for raw_name in line_str.split(","):
            name = raw_name.strip()
            fn = _SEGMENT_REGISTRY.get(name)
            if fn is not None:
                fns.append(fn)
        if fns:
            result.append(_LineConfig(segment_fns=fns))
    return result


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """コマンドライン引数をパースする"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--icons", type=str, default=None)
    parser.add_argument("--currency", type=str.upper, default=None)
    parser.add_argument("--segments", type=str, default=_DEFAULT_SEGMENTS)
    return parser.parse_args(argv)


def main() -> None:
    """stdinからClaude Codeのステータス情報JSONを読み取り表示する

    Claude Codeのstatuslineフックから呼び出されることを想定する
    stdinにはプロジェクト情報やモデル情報を含むJSONが渡される
    --icons nerd を指定するとNerd Fontsアイコンを使用する
    --currency JPY を指定すると通貨を指定できる
    """
    global _icons, _currency  # noqa: PLW0603

    args = _parse_args()
    _icons = _ICONS_NERD if args.icons == "nerd" else _Icons()
    _currency = _resolve_currency(args.currency)

    try:
        raw = sys.stdin.read()
    except OSError, UnicodeDecodeError:
        return

    if not raw.strip():
        return

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return

    if not isinstance(data, dict):
        return

    # Git情報を取得してdataに格納する
    cwd = _get_cwd(data)
    git_info = _get_git_info(cwd) if cwd else None
    if git_info is not None:
        data["_git"] = git_info

    lines_config = _parse_segments(args.segments)
    lines = _build_lines(data, lines_config)
    if lines:
        print("\n".join(lines))


if __name__ == "__main__":
    main()
