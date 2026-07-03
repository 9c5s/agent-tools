# bot ごとの終了シグナル

各 bot は固有の「提案なし」シグナルを持つ。Monitor の通知だけでは判定できないものは能動確認する。

## Codex (`chatgpt-codex-connector[bot]`)

PR issue へのリアクションで状態を示す。

| 内容 | 意味 |
|---|---|
| 👀 `eyes` | レビュー実行中 (push 後 5〜12 分継続) |
| 👍 `+1` | レビュー完了、提案事項なし |
| (なし) | 未着手 もしくは 完了して新規 review/comment を投稿済み |

`rrs codex-reaction` で確認。LAST_PUSH_TS より新しい `+1` があれば即終了して良い。

`rrs codex-cleared "$LAST_PUSH_TS"` が exit 0 を返す条件:

- `LAST_PUSH_TS` より新しい `+1` リアクションが存在する
- または **`reached your Codex usage limits` を含む issue comment** が存在する。usage limit comment は Codex が課金上限に達してそれ以上レビューしない明示シグナルなので、Codex 観点としては「待っても来ない」確定で `+1` と同じく観点クリアとして扱う

## CodeRabbit (`coderabbitai[bot]`)

walkthrough コメント (PR 作成時に作る 1 件) を **edit して** レビュー結果を反映する。新規 issue comment は作らないため、Monitor の `created_at` 監視は通過する。

`rrs walkthrough-state` が `state=no_actionable` を返し、かつ `updated_at > LAST_PUSH_TS` なら「指摘なし」確定。`has_actionable` なら inline 指摘が reviewThread として現れているはずなので Monitor で捕捉される。

walkthrough の段階更新マーカーの詳細は [coderabbit-walkthrough.md](coderabbit-walkthrough.md) 参照。

## gemini-code-assist[bot]

観測されている終了シグナルが無い。無反応 = 提案なしとして時間 fallback で判定する。

## 通常終了の判定 (AND 条件)

全 bot がクリーンを報告する以下を **全て** 満たす場合に成立する。

- Codex: `rrs codex-cleared "$LAST_PUSH_TS"` が exit 0
- CodeRabbit: walkthrough `state=no_actionable` + `updated_at > LAST_PUSH_TS` + `rrs outside-diff-reviews "$LAST_PUSH_TS"` が空

片方の bot だけクリーン報告した時点で停止すると、もう片方の後続 findings (例: Codex 👍 後に CodeRabbit が actionable thread 投稿) を取りこぼすため OR ではなく AND で判定する。

## Fallback 終了 (どれか 1 つ満たせば停止)

- 最終 push から 15 分以上、全 bot から新規 review/comment/thread・walkthrough 更新・codex リアクション変化・`poll-failed` も全て無い (= 真の無音)
- ユーザー指示 (「終了」「止めて」等)
