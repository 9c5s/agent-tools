---
name: review-resolve
description: "PR のレビュー指摘 (未解決スレッド・diff 範囲外コメント・bot レビュー) を 1 件ずつ採用/不採用判定して 👍/👎 リアクション + resolve まで潰す。CodeRabbit / Codex / gemini など複数 bot をまとめて対応。「レビュー対応」「レビュー潰し」「PR のコメントに返事して」「review thread 全部 resolve して」のような依頼で必ず使う。"
argument-hint: "[--loop]"
---

# レビュー指摘への対応

PR の未解決レビュースレッド全てに対し、対応方針 (採用/不採用) を決め、必要ならコード修正・push し、👍/👎 リアクションを付けて resolve する。スレッド外の指摘 (diff 範囲外コメント等) はコード修正と git log で完結させ PR 上で新規コメントを作らない。意思表示の手段が無いところにノイズを増やさないため。

## 引数解析

`$ARGUMENTS` を見て呼び出しモードを決める。

- `--loop` を含む → **loop モード** (後述「--loop モード」セクションへ): 反復対応・push 確認なし・`Monitor` で bot 監視
- それ以外 (引数なし含む) → **通常モード** (後述「手順 (通常モード)」セクションへ): 1 巡で完了・push 前にユーザー確認

呼び出し例: `/review-resolve` (通常) / `/review-resolve --loop` (loop)。`$ARGUMENTS` が `--help` / `-h` の場合は本セクションと「主要サブコマンド一覧」を出して終了。

## 同梱リソース

本スキルのディレクトリ (`${CLAUDE_SKILL_DIR}`) 配下に以下を同梱する。本文中の指示はこれらを前提とする。

- `scripts/review-resolve-status.sh` — 定型操作 (jq クエリ・GraphQL 引数) を吸収するヘルパー。本文では function `rrs` として参照
- `references/` — 詳細仕様の参照ドキュメント。本文からは都度ポインタで案内する
  - `bot-signals.md` — bot 別の終了シグナル一覧と通常終了の AND 条件
  - `coderabbit-walkthrough.md` — CodeRabbit walkthrough マーカーの段階更新と判定で踏みやすい罠
  - `monitor-internals.md` — `rrs monitor-loop` の event 形式と watermark 仕様

## 初期化

`rrs init` が `OWNER`/`REPO`/`N`/`MY_LOGIN`/`LAST_PUSH_TS` を export 文として吐く。以降のサブコマンドはこの env を参照する。

```bash
# init が失敗 (auth/rate-limit/PR check-out 外) した場合に空 env で続行しないよう、
# 出力をいったん変数で受け取り init の exit code を eval 前にチェックする
_rrs_init_out=$(bash "${CLAUDE_SKILL_DIR}/scripts/review-resolve-status.sh" init) \
  && eval "$_rrs_init_out" \
  || { echo "rrs init failed; abort setup" >&2; return 1 2>/dev/null || exit 1; }
unset _rrs_init_out
# alias ではなく function を使う: Claude Code の Bash tool 等の non-interactive shell は
# 既定で alias 展開しない (shopt -s expand_aliases が必要)。function は non-interactive でも動く。
# ただし function も同一 shell プロセス内でのみ有効で、別の Bash invocation には継承されない。
# 別 invocation で `rrs` を使う場合は、その都度この初期化ブロック全体を再実行する
rrs() { bash "${CLAUDE_SKILL_DIR}/scripts/review-resolve-status.sh" "$@"; }
```

以降の本文中の `rrs` は上記 function を指す。別 shell で実行する場合は `bash "${CLAUDE_SKILL_DIR}/scripts/review-resolve-status.sh" <subcommand>` に読み替えるか、再度この初期化ブロックを `eval` する。

## 主要サブコマンド一覧

`rrs` で呼べるサブコマンドの一覧。各サブコマンドの jq クエリ・GraphQL 引数はスクリプト側で吸収されているので、本文の手順ではこの名前だけ覚えれば足りる。

| サブコマンド | 用途 |
|---|---|
| `init` | OWNER/REPO/N/MY_LOGIN/LAST_PUSH_TS の export 文を生成 |
| `unresolved-threads` | 未解決スレッド一覧 (cid + 本文) |
| `outside-diff-reviews [ts]` | 「Outside diff range」を含む review 本文 (cutoff 指定可) |
| `react <cid> +1\|-1` | 指定コメントへ 👍/👎 リアクション |
| `resolve <thread_node_id>` | review thread を resolve |
| `codex-reaction` | Codex の `/issues/N/reactions` 最新状態 |
| `codex-cleared <ts>` | Codex 観点でクリアか判定 (exit code) |
| `walkthrough-state` | CodeRabbit walkthrough の現状 (state + updated_at + rate_limit_reset_at) |
| `walkthrough-history` | walkthrough edit 履歴を 3 マーカーで分類した JSON 行 |
| `coderabbit-trigger` | `@coderabbit review` を 1 行で投稿+時刻記録 |
| `wait-and-retrigger [BUFFER]` | rate_limited のとき reset 予定時刻+buffer 後に自動再 trigger |
| `bot-reviews-since <ts>` | 指定時刻以降の bot review 一覧 |
| `monitor-loop` | --loop モード用の 30 秒間隔 polling (event を 1 行ずつ stdout) |
| `completion-summary` | 未解決スレッド数 + Codex + walkthrough を 1 ブロックで (最終確認用) |

## 手順 (通常モード)

1. `rrs unresolved-threads` で未解決スレッドを取得し、各スレッドの最初の comment 本文を読む
2. `rrs outside-diff-reviews` で「Outside diff range」を含む review 本文を取得。bot 表記揺れで漏れる場合は `gh api repos/$OWNER/$REPO/pulls/$N/reviews --paginate --jq '.[] | select(.body!="") | {id, user: .user.login, body}'` で全件目視併用
3. 各指摘について「採用/不採用」と理由を決める。コード修正が必要なら先に実装する
4. コード修正があれば `git add` → `git commit` → `git push` を実行する。通常モードはユーザーに push 確認、`--loop` モードは確認なしで即実行。push 後は commit hash を控え、`eval "$(rrs init)"` を再実行して `LAST_PUSH_TS` を新 head に更新する
5. 各スレッドに対して: `rrs react <cid> +1` または `-1` でリアクション → `rrs resolve <thread_node_id>` で解決
6. 不採用で理由が分かりにくい場合のみ補足返信。`gh api repos/$OWNER/$REPO/pulls/$N/comments -f body="不採用 (理由1行)" -F in_reply_to=<cid>` 。リアクションだけで意思は伝わるので基本不要
7. diff 範囲外指摘への対応は commit にだけ残す。PR 上で issue comment やスレッド外コメントを作成しない
8. 完了確認: `rrs unresolved-threads | jq -s 'length'` が 0 になれば未解決スレッドは完了。diff 範囲外指摘は GitHub 上に完了マーカーが無いので、Claude Code 組み込みの TaskList ツール (`TaskCreate`/`TaskUpdate` または `TodoWrite` 等、環境で提供されるもの) で各 diff 範囲外指摘を 1 件 1 task として登録し対応有無を追跡する

## リアクションスタイル

- スレッドの最初の comment に 👍/👎 リアクションのみ。テキスト返信はしない。採用 commit hash は同 push の git log で辿れるので重複説明にならない
- 修正コミットのコード/docs コメントには設計判断の WHY だけ書く。「N 巡目指摘」「PR #X で指摘」のような経緯ラベルは git log と PR から参照できるので書かない
- **不採用時のみ coderabbit (coderabbitai[bot]) に対してだけ簡潔な理由を添えて返信する**。他の bot (gemini-code-assist, chatgpt-codex-connector など) は不採用でもリアクションのみで返信しない。理由返信は 1〜2 行・日本語・「だ・である」調

## --loop モード (`/review-resolve --loop`)

1 巡対応後も bot の追加レビューを監視し、来なくなるまで自動対応を繰り返す。通常モードとの違い:

- 反復中の commit/push はユーザー確認なしで即実行 (起動時点で承認済みとみなす)
- bot 監視は `Monitor` ツール (パッシブ) で行い、`ScheduleWakeup` での能動 polling は使わない。polling は cache を焼くだけで効率が悪い

### 監視 Monitor の起動

`Monitor` ツールに以下を `persistent: true`, `timeout_ms: 3600000` で渡す。終了時 `TaskStop`。

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/review-resolve-status.sh" monitor-loop
```

前提として `eval "$(... init)"` で親 shell に `export OWNER=... REPO=... N=... MY_LOGIN=... LAST_PUSH_TS=...` を済ませてあること (Monitor の child shell は親 env を継承するが `OWNER=value` 形式のローカル変数は継承されないので必ず `export` 経由)。

event 出力形式・実装上の保証 (watermark / pipefail / poll-failed の扱い) は `references/monitor-internals.md` 参照。

### 終了判定

bot 別の終了シグナル (Codex リアクション、CodeRabbit walkthrough state、gemini の fallback) と通常終了の AND 条件は `references/bot-signals.md` 参照。

Fallback 終了 (どれか 1 つ満たせば停止):

- 最終 push から 15 分以上、全 bot から新規 review/comment/thread・walkthrough 更新・codex リアクション変化・`poll-failed` も全て無い (= 真の無音)
- ユーザー指示 (「終了」「止めて」等)

片方の bot だけクリーン報告した時点で停止すると、もう片方の後続 findings (例: Codex 👍 後に CodeRabbit が actionable thread 投稿) を取りこぼすため OR ではなく AND で判定する。

### ループ手順

1. 通常手順 1〜8 を実行 (1 巡目)
2. push 後 `Monitor` を上記コマンドで起動
3. notification 受信時:
   - a. 内容確認 → 対応方針決定
   - b. 大規模変更 (※後述) はユーザー確認 → 承認後実装
   - c. 修正 → `bun plugin/src/patch-server.ts --make` 等の再生成 → テスト → `git add` → `git commit` → `git push` (確認なし) → `eval "$(rrs init)"` を再実行して `LAST_PUSH_TS` を新 head に更新
   - d. `rrs react <cid> +1|-1` + `rrs resolve <node_id>`
   - e. `rrs codex-reaction` で 👍 なら Codex 観点はクリア (即終了はせず CodeRabbit の終了条件 (f) と AND で判定)、👀 なら Codex は in_progress として待機継続
   - f. `rrs walkthrough-state` が `no_actionable` で `updated_at > LAST_PUSH_TS` **かつ** `rrs outside-diff-reviews "$LAST_PUSH_TS"` も空なら CodeRabbit 観点で終了確定。`no_actionable` は inline 指摘数 0 を意味するだけで、outside-diff/nitpick が body に残っているケースを取りこぼすため両方をチェックする。`outside-diff-reviews` には現 push 以降の cutoff を渡し、過去 push で既に対応済の outside-diff が残って永久に false にならないようにする
   - g. walkthrough が `state=rate_limited` (= `rate_limit_reset_at=...` 付き) になったら、`Bash run_in_background` で `rrs wait-and-retrigger` を起動して放置する。reset 予定時刻 + 60s buffer 後に自動で `@coderabbitai review` を投稿し、Monitor がその新 review を捕捉する。手動で再 trigger を覚えておく必要なし
4. 15 分新着もリアクション変化も walkthrough 更新も `poll-failed` も無ければ終了判定。Codex 👀 が残っていれば +5〜10 分延長。`poll-failed: ...` が連続して出ている間は API 不調なので終了判定の無音タイマーをリセットする
5. 終了確定で `TaskStop` → ユーザーに完了報告

### 大規模変更の合図

同じ箇所への指摘が連続し、対策を重ねるたびに別の穴が露呈する場合は、対症療法ではなく根本設計の見直しをユーザーに提案する。レース対策・ガード・遅延の各論を積み重ねると複雑度だけが増え新しい問題を呼ぶ傾向がある。

### CodeRabbit walkthrough の段階更新

walkthrough コメントは段階的に edit され、edit ごとに状態マーカーが切り替わる。マーカー一覧と判定で踏みやすい罠 (進行中マーカーが残る間は完了とみなさない、過去の rate-limit 履歴が body に残る、`@coderabbit review` 自動応答の incremental 注記) は `references/coderabbit-walkthrough.md` 参照。

## 完了報告フォーマット

ユーザーが「何が起きたか」を 1 画面で把握できる形で報告する。通常モード末尾 (手順 8 完了後) と --loop モード末尾 (ループ手順 5 で `TaskStop` 後) のどちらでも以下を出す。

### 通常モード

```
review-resolve 完了
- 未解決スレッド: N 件 (採用 K / 不採用 M, 全て resolve 済み)
- diff 範囲外指摘: L 件 (commit に反映, TaskList で追跡完了)
- commits: <hash1>, <hash2>, ...
```

### --loop モード

```
review-resolve --loop 完了: K 巡 / 計 N commits
- 1 巡目: 採用 X / 不採用 Y / outside-diff Z
- 2 巡目: ...
- 終了理由: Codex+CodeRabbit クリーン (AND) / fallback 無音 15 分 / ユーザー指示
```

採用/不採用の内訳は bot 別 (CodeRabbit / Codex / gemini) で分けるか合算するかは件数次第で判断する。1 桁なら合算で十分、二桁を超えるなら分けた方が読みやすい。

## 補足

`minimizeComment` は表示の非表示化であり resolve ではない。resolve には必ず `rrs resolve` (= `resolveReviewThread` mutation) を使う。
