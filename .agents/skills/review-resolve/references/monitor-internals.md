# Monitor / rrs monitor-loop の内部仕様

`Monitor` ツールに `rrs monitor-loop` を `persistent: true`, `timeout_ms: 3600000` で渡す。終了時は `TaskStop`。

## 前提

`eval "$(... init)"` で親 shell に対して `export OWNER=... REPO=... N=... MY_LOGIN=... LAST_PUSH_TS=...` を済ませてあること。Monitor の child shell は親 env を継承するが、`OWNER=value` 形式のローカル変数は継承されないので必ず `export` 経由で渡す。

```bash
bash "$HOME/.claude/commands/scripts/review-resolve-status.sh" monitor-loop
```

## 出力 event 形式

`rrs monitor-loop` の実体は `review-resolve-status.sh` 内の `cmd_monitor_loop` で、以下を 30 秒間隔で polling し各 event を 1 行ずつ stdout に出す。

- `review: <author> at <iso> id=<id>` — bot review 新着
- `comment: <author> at <iso> id=<id>` — issue comment 新着
- `thread: <author> at <iso> cid=<cid>` — 未解決 thread の bot 返信新着
- `walkthrough: updated_at=<iso> state=<state>` — CodeRabbit walkthrough state 変化
- `codex-reaction: <eyes|+1>|...` — Codex の `/issues/N/reactions` 変化
- `poll-failed: <kind>` — 上記いずれかの取得失敗

## 実装上の保証

詳細は `cmd_monitor_loop` 内コメント参照。

- `set -o pipefail` で `rrs | jq` の左側失敗を握り潰さない
- watermark (次の `last`) は polling 開始前に `_date_minus_1s` で先取り → polling 完了後に進める (polling 中に created された event は次回で拾える)
- 1 件でも `poll-failed` が出たら watermark を進めない (失敗中の event を取りこぼさない)
- `date -d @EPOCH` (GNU) と `date -r EPOCH` (BSD) の両対応
