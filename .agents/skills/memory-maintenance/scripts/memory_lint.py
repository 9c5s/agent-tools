# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml"]
# ///
"""Claude Code プロジェクトメモリの機械検査と整理を行うツール

~/.claude/projects/*/memory/ を横断して以下を検査する。

エラー (E):
- E1 index-missing: MEMORY.md が参照するファイルが存在しない
- E2 index-unlisted: 実体ファイルが MEMORY.md に載っていない
- E3 no-frontmatter: frontmatter がない
- E4 yaml-invalid: frontmatter が YAML として解析できない
- E5 schema: 正規形式違反 (name の kebab-case、description、metadata.node_type、type)

警告 (W):
- W1 wikilink: [[name]] の参照先が同一プロジェクト内に存在しない
- W2 duplicate: プロジェクト間の同名ファイル (内容が完全同一なら明記)
- W3 direct-content: MEMORY.md に index 行以外の本文が直書きされている
- W4 size: サイズ閾値超過 (個別ファイル 8KB、MEMORY.md 6KB)

--prune で指定ファイルを削除し、対応する index 行も除去する。
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

VALID_TYPES = {"user", "feedback", "project", "reference"}
KEBAB_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
INDEX_LINK_RE = re.compile(r"\]\(([^)]+\.md)\)")
INDEX_LINE_RE = re.compile(r"^- \[.*\]\([^)]+\.md\)")
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
FILE_SIZE_LIMIT = 8 * 1024
INDEX_SIZE_LIMIT = 6 * 1024


@dataclass
class Finding:
    """検査結果の 1 件を表す"""

    level: str  # "E" または "W"
    code: str
    project: str
    target: str
    message: str


@dataclass
class MemoryFile:
    """メモリファイル 1 件の解析結果を保持する"""

    path: Path
    project: str
    meta: dict | None = None
    body: str = ""
    parse_error: str | None = None
    names: set[str] = field(default_factory=set)


def read_text(path: Path) -> str:
    """BOM と CRLF を吸収してテキストを読み込む"""
    return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")


def parse_frontmatter(text: str) -> tuple[dict | None, str, str | None]:
    """frontmatter と本文を分離する。戻り値は (meta, body, error)"""
    if not text.startswith("---\n"):
        return None, text, "no-frontmatter"
    end = text.find("\n---", 4)
    if end == -1:
        return None, text, "unterminated"
    raw = text[4:end]
    body = text[end + 4 :]
    try:
        meta = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        return None, body, f"yaml-error: {exc}"
    if not isinstance(meta, dict):
        return None, body, "not-a-mapping"
    return meta, body, None


def discover_memory_dirs(projects_dir: Path) -> list[Path]:
    """メモリディレクトリを列挙する"""
    return sorted(
        (p / "memory" for p in projects_dir.iterdir() if (p / "memory").is_dir()),
        key=lambda p: p.parent.name.lower(),
    )


def load_memory_files(mem_dir: Path) -> list[MemoryFile]:
    """MEMORY.md 以外の全メモリファイルを解析する"""
    project = mem_dir.parent.name
    files = []
    for path in sorted(mem_dir.glob("*.md")):
        if path.name == "MEMORY.md":
            continue
        mf = MemoryFile(path=path, project=project)
        text = read_text(path)
        mf.meta, mf.body, mf.parse_error = parse_frontmatter(text)
        files.append(mf)
    return files


def check_schema(mf: MemoryFile) -> list[str]:
    """正規形式 (name/description/metadata) の違反を列挙する"""
    problems = []
    meta = mf.meta or {}
    name = meta.get("name")
    if not isinstance(name, str) or not name:
        problems.append("name がない")
    elif not KEBAB_RE.match(name):
        problems.append(f"name が kebab-case ではない: {name!r}")
    desc = meta.get("description")
    if not isinstance(desc, str) or not desc.strip():
        problems.append("description がない")
    nested = meta.get("metadata")
    if not isinstance(nested, dict):
        problems.append("metadata ブロックがない")
    else:
        if nested.get("node_type") != "memory":
            problems.append("metadata.node_type が memory ではない")
        if nested.get("type") not in VALID_TYPES:
            problems.append(f"metadata.type が不正: {nested.get('type')!r}")
    return problems


def lint_index(mem_dir: Path, files: list[MemoryFile]) -> list[Finding]:
    """MEMORY.md と実体の双方向整合、直書き、サイズを検査する"""
    project = mem_dir.parent.name
    findings = []
    index_path = mem_dir / "MEMORY.md"
    if not index_path.is_file():
        if files:
            findings.append(
                Finding("E", "E1", project, "MEMORY.md", "index (MEMORY.md) が存在しない")
            )
        return findings

    text = read_text(index_path)
    linked = {m.group(1).split("/")[-1] for m in INDEX_LINK_RE.finditer(text)}
    actual = {mf.path.name for mf in files}

    for missing in sorted(linked - actual):
        findings.append(
            Finding("E", "E1", project, missing, "index が参照するファイルが存在しない")
        )
    for unlisted in sorted(actual - linked):
        findings.append(
            Finding("E", "E2", project, unlisted, "index に載っていないファイル")
        )

    direct_lines = [
        line
        for line in text.splitlines()
        if line.strip()
        and not line.startswith("#")
        and not INDEX_LINE_RE.match(line)
    ]
    if direct_lines:
        sample = direct_lines[0][:60]
        findings.append(
            Finding(
                "W",
                "W3",
                project,
                "MEMORY.md",
                f"index 行以外の直書きが {len(direct_lines)} 行ある (例: {sample})",
            )
        )

    size = index_path.stat().st_size
    if size > INDEX_SIZE_LIMIT:
        findings.append(
            Finding("W", "W4", project, "MEMORY.md", f"index が {size:,} bytes ある")
        )
    return findings


def lint_files(files: list[MemoryFile]) -> list[Finding]:
    """個別ファイルの frontmatter・スキーマ・wikilink・サイズを検査する"""
    findings = []
    names = {mf.meta.get("name") for mf in files if isinstance(mf.meta, dict)}
    for mf in files:
        target = mf.path.name
        if mf.parse_error == "no-frontmatter":
            findings.append(Finding("E", "E3", mf.project, target, "frontmatter がない"))
            continue
        if mf.parse_error:
            findings.append(
                Finding("E", "E4", mf.project, target, f"frontmatter が不正 ({mf.parse_error})")
            )
            continue
        for problem in check_schema(mf):
            findings.append(Finding("E", "E5", mf.project, target, problem))
        for link in WIKILINK_RE.findall(mf.body):
            if link not in names:
                findings.append(
                    Finding("W", "W1", mf.project, target, f"[[{link}]] の参照先がない")
                )
        size = mf.path.stat().st_size
        if size > FILE_SIZE_LIMIT:
            findings.append(
                Finding("W", "W4", mf.project, target, f"ファイルが {size:,} bytes ある")
            )
    return findings


def lint_duplicates(all_files: list[MemoryFile]) -> list[Finding]:
    """プロジェクト間の同名ファイルを検出する"""
    findings = []
    by_name: dict[str, list[MemoryFile]] = {}
    for mf in all_files:
        by_name.setdefault(mf.path.name, []).append(mf)
    for name, group in sorted(by_name.items()):
        if len(group) < 2:
            continue
        digests = {hashlib.sha256(mf.path.read_bytes()).hexdigest() for mf in group}
        projects = ", ".join(sorted(mf.project for mf in group))
        detail = "内容も完全同一" if len(digests) == 1 else "内容は異なる"
        findings.append(
            Finding("W", "W2", "(横断)", name, f"{projects} に同名ファイル ({detail})")
        )
    return findings


def run_lint(projects_dir: Path, only: str | None) -> int:
    """lint を実行してレポートを出力する。エラーがあれば 1 を返す"""
    findings: list[Finding] = []
    all_files: list[MemoryFile] = []
    for mem_dir in discover_memory_dirs(projects_dir):
        project = mem_dir.parent.name
        if only and project.lower() != only.lower():
            continue
        files = load_memory_files(mem_dir)
        all_files.extend(files)
        findings.extend(lint_index(mem_dir, files))
        findings.extend(lint_files(files))
    if not only:
        findings.extend(lint_duplicates(all_files))

    errors = [f for f in findings if f.level == "E"]
    warnings = [f for f in findings if f.level == "W"]

    print("# メモリ lint レポート")
    print()
    print(f"- 検査ファイル数: {len(all_files)} (MEMORY.md を除く)")
    print(f"- エラー: {len(errors)} 件 / 警告: {len(warnings)} 件")
    for label, items in (("エラー", errors), ("警告", warnings)):
        if not items:
            continue
        print()
        print(f"## {label}")
        print()
        for f in items:
            print(f"- [{f.code}] {f.project} / `{f.target}` — {f.message}")
    if not findings:
        print()
        print("問題は検出されなかった。")
    return 1 if errors else 0


def run_prune(projects_dir: Path, targets: list[str]) -> int:
    """指定されたメモリファイルを削除し、index 行も除去する"""
    status = 0
    for raw in targets:
        path = Path(raw).resolve()
        if (
            path.parent.name != "memory"
            or path.parent.parent.parent != projects_dir.resolve()
        ):
            print(f"skip (メモリディレクトリ外): {raw}")
            status = 1
            continue
        if path.name == "MEMORY.md":
            print(f"skip (index は削除対象外): {raw}")
            status = 1
            continue
        if not path.is_file():
            print(f"skip (存在しない): {raw}")
            status = 1
            continue
        path.unlink()
        index_path = path.parent / "MEMORY.md"
        removed = 0
        if index_path.is_file():
            lines = read_text(index_path).splitlines(keepends=True)
            kept = [line for line in lines if f"({path.name})" not in line]
            removed = len(lines) - len(kept)
            if removed:
                index_path.write_text("".join(kept), encoding="utf-8")
        print(f"deleted: {path.parent.parent.name}/{path.name} (index 行 {removed} 行を除去)")
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description="Claude Code メモリの lint と整理")
    parser.add_argument(
        "--projects-dir",
        type=Path,
        default=Path.home() / ".claude" / "projects",
        help="projects ディレクトリ (既定: ~/.claude/projects)",
    )
    parser.add_argument("--project", help="検査対象を単一プロジェクトに絞る")
    parser.add_argument(
        "--prune",
        nargs="+",
        metavar="FILE",
        help="指定メモリファイルを削除し index 行も除去する",
    )
    args = parser.parse_args()
    if not args.projects_dir.is_dir():
        print(f"projects ディレクトリが見つからない: {args.projects_dir}", file=sys.stderr)
        return 2
    if args.prune:
        return run_prune(args.projects_dir, args.prune)
    return run_lint(args.projects_dir, args.project)


if __name__ == "__main__":
    sys.exit(main())
