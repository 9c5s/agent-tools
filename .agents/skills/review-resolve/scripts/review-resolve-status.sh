#!/usr/bin/env bash
# shellcheck disable=SC2250,SC2016
# SC2250: jq クエリ内の $u/$b/$state を bash 変数として誤検知し brace 化を強制するため無効化
# SC2016: jq の文字列補間 \($u) を含む single-quoted 文字列を意図的に使用するため無効化
# review-resolve スキル用のステータス取得ヘルパー
# 使い方: 直接サブコマンドで実行する (source による取り込みは想定しない)
#   $ bash review-resolve-status.sh <subcommand> <args>
#
# サブコマンド:
#   init                       OWNER/REPO/N/MY_LOGIN/LAST_PUSH_TS を echo (env 設定用)
#   unresolved-threads         未解決 reviewThread を JSON 行で列挙 (pagination 対応)
#   outside-diff-reviews [TS]  「Outside diff range」を含む review を JSON 行で列挙。TS 指定で submitted_at > TS のみに絞る
#   react PR_COMMENT_ID +1|-1  PR review comment にリアクションを付ける
#   resolve THREAD_NODE_ID     reviewThread を resolved にする
#   walkthrough-id             CodeRabbit walkthrough コメント (最新) の databaseId を返す
#   walkthrough-state          walkthrough の現在状態を1行で出す
#                              形式: updated_at=<iso> state=<in_progress|rate_limited|no_actionable|has_actionable|lookup_failed|no_walkthrough|unknown>
#   walkthrough-history        walkthrough の編集履歴をマーカー分類付きで列挙
#   coderabbit-trigger         '@coderabbit review' を投稿し comment ID と posted_at を出す
#   bot-reviews-since TS       TS 以降の bot review を列挙 (login/submitted/id)
#   codex-reaction             Codex の PR-issue リアクションを列挙 (eyes/+1/-1)
#   codex-cleared SINCE        Codex 観点クリア判定 (SINCE 以降の +1 リアクションまたは usage-limit comment があれば exit 0、無ければ exit 1)
#   completion-summary         全 thread の resolved/hasMyReply + Codex リアクション + walkthrough 状態を出力
#   monitor-loop               loop モードの監視ループ本体 (Monitor ツールから呼ぶ。30s 間隔で polling、各 event を stdout)
#
# 設計: review-resolve.md の検知ロジックを全てここに集約し、skill 本体は
# 自然言語の判断手順だけに専念する。jq クエリの重複と「自然言語ながら定型」
# な指示を排除する。

set -uo pipefail

owner_repo_n() {
  : "${OWNER:?OWNER not set; run 'review-resolve-status.sh init' first}"
  : "${REPO:?REPO not set}"
  : "${N:?N not set}"
}

cmd_init() {
  local n login owner repo last_push
  # gh pr view の呼び出しを 1 回に集約 (number + commits[-1].committedDate)
  # TODO: LAST_PUSH_TS は commits[-1].committedDate を使用しており、実 push 時刻と乖離する場合がある。
  # gh API には PR commit ごとの pushedDate が無く、push 時刻の正確な取得には timeline events 走査が必要で複雑。
  # 現状は許容範囲として committedDate を採用。
  read -r n last_push <<< "$(gh pr view --json number,commits --jq '"\(.number) \(.commits[-1].committedDate)"')"
  if [ -z "$n" ] || [ -z "$last_push" ]; then
    echo "init: gh pr view failed (PR が見つからない、未認証、または PR check-out 外)" >&2
    return 1
  fi
  login=$(gh api user --jq .login)
  if [ -z "$login" ]; then
    echo "init: gh api user failed (未認証)" >&2
    return 1
  fi
  read -r owner repo <<< "$(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"')"
  if [ -z "$owner" ] || [ -z "$repo" ]; then
    echo "init: gh repo view failed" >&2
    return 1
  fi
  printf 'export OWNER=%q REPO=%q N=%q MY_LOGIN=%q LAST_PUSH_TS=%q\n' "$owner" "$repo" "$n" "$login" "$last_push"
}

# reviewThreads を cursor-based pagination で全件取得し、各 thread を JSON 行として出力
_fetch_all_review_threads() {
  owner_repo_n
  local cursor="null" has_next="true" json cursor_arg
  while [ "$has_next" = "true" ]; do
    if [ "$cursor" = "null" ]; then
      cursor_arg="null"
    else
      cursor_arg="\"$cursor\""
    fi
    if ! json=$(gh api graphql -f query="query { repository(owner: \"$OWNER\", name: \"$REPO\") { pullRequest(number: $N) { reviewThreads(first: 100, after: $cursor_arg) { pageInfo { hasNextPage endCursor } nodes { id isResolved path line comments(first: 100) { nodes { databaseId author { login } body createdAt } } } } } } }"); then
      echo "_fetch_all_review_threads: gh api graphql failed (auth/rate-limit/network)" >&2
      return 1
    fi
    if ! echo "$json" | jq -e '.data.repository.pullRequest.reviewThreads' > /dev/null 2>&1; then
      echo "_fetch_all_review_threads: GraphQL response missing reviewThreads (PR が見つからない or 権限なし)" >&2
      return 1
    fi
    echo "$json" | jq -c '.data.repository.pullRequest.reviewThreads.nodes[]'
    has_next=$(echo "$json" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    cursor=$(echo "$json" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
  done
}

cmd_unresolved_threads() {
  _fetch_all_review_threads | jq -c 'select(.isResolved == false)'
}

cmd_outside_diff_reviews() {
  owner_repo_n
  # body-only findings の検出パターン (CodeRabbit などが inline でなく body に置く指摘):
  # - "Outside (the) diff range" / "outside the diff" / "outside-diff"
  # - "Nitpick comments (N)" — CodeRabbit の nitpick section
  # - "Additional comments (N)" — 補助 comments
  # 表記揺れ吸収のため case-insensitive で OR マッチする。
  # optional 第 1 引数 SINCE_TS (ISO8601) が指定されたらその時刻以降の review に絞る。
  # loop モードで `$LAST_PUSH_TS` 以降の body-only findings を判定するのに使う。
  local since="${1:-}"
  local pattern='(?i)(outside\\b.*diff|nitpick comments?|additional comments?)'
  if [ -n "$since" ]; then
    gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --paginate \
      --jq ".[] | select(.body != null and (.body | test(\"$pattern\"))) | select(.submitted_at > \"$since\") | {id: .id, user: (.user.login? // \"ghost\"), submitted: .submitted_at, body: .body}"
  else
    gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --paginate \
      --jq ".[] | select(.body != null and (.body | test(\"$pattern\"))) | {id: .id, user: (.user.login? // \"ghost\"), submitted: .submitted_at, body: .body}"
  fi
}

cmd_react() {
  owner_repo_n
  local cid="${1:?need PR review comment ID}" content="${2:?need +1 or -1}"
  gh api -X POST "repos/$OWNER/$REPO/pulls/comments/$cid/reactions" -f "content=$content" --jq '.content'
}

cmd_resolve() {
  local node_id="${1:?need thread node ID}"
  gh api graphql -f query="mutation { resolveReviewThread(input: { threadId: \"$node_id\" }) { thread { isResolved } } }" \
    --jq '.data.resolveReviewThread.thread.isResolved'
}

cmd_walkthrough_id() {
  owner_repo_n
  # 複数回投稿された walkthrough の中で最新 (updated_at が最大) を返す。
  # `gh api --paginate --jq` 単体ではページごとに jq が走り、ページ毎の last しか取れない。
  # 一方 `--paginate --slurp` は `--jq` と排他なので、--paginate の生出力 (各ページ配列の連結)
  # を `jq -s 'add | ...'` に流し込んで全ページを 1 配列に集めてから sort_by | last を適用する
  gh api --paginate "repos/$OWNER/$REPO/issues/$N/comments" \
    | jq -s 'add | [.[] | select(.user.login == "coderabbitai[bot]") | select(.body | startswith("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"))] | sort_by(.updated_at) | last | .id // empty'
}

cmd_walkthrough_state() {
  owner_repo_n
  local wid rc=0
  wid=$(cmd_walkthrough_id) || rc=$?
  if [ "$rc" -ne 0 ]; then
    # 真の lookup 失敗 (auth/rate-limit/network) は exit code 1 で呼び出し元に伝播する。
    # echo を return より前に行うと echo の exit code 0 を継承するため、return 1 を明示する
    echo "updated_at=none state=lookup_failed"
    return 1
  fi
  if [ -z "$wid" ]; then
    # walkthrough コメントが存在しない (PR 作成直後 / CodeRabbit 未起動) のは正常な状態
    echo "updated_at=none state=no_walkthrough"
    return 0
  fi
  # 判定優先順序: 完了マーカー (Actionable / No actionable) > 進行中 > rate_limit > unknown。
  # 完了マーカーを最優先することで、body に残った過去の rate_limit 履歴を「完了済」が上書きする。
  # in_progress マーカー無しで rate_limit マーカーのみのケース (CodeRabbit がレビュー開始前に
  # rate_limit に到達) は rate_limited として正しく判定する。
  local data updated_at body state api_rc=0
  data=$(gh api "repos/$OWNER/$REPO/issues/comments/$wid" --jq '{updated_at, body: (.body // "")}') || api_rc=$?
  if [ "$api_rc" -ne 0 ] || [ -z "$data" ]; then
    # gh api / jq の失敗 (auth / rate-limit / 削除済みコメント / network) は空入力で続行せず lookup_failed
    echo "updated_at=none state=lookup_failed"
    return 1
  fi
  updated_at=$(printf '%s' "$data" | jq -r '.updated_at // empty')
  body=$(printf '%s' "$data" | jq -r '.body // empty')
  if [ -z "$updated_at" ]; then
    echo "updated_at=none state=lookup_failed"
    return 1
  fi
  if printf '%s' "$body" | grep -q "Actionable comments posted: 0"; then
    state="no_actionable"
  elif printf '%s' "$body" | grep -qE "Actionable comments posted: [1-9]"; then
    state="has_actionable"
  elif printf '%s' "$body" | grep -q "No actionable comments were generated"; then
    state="no_actionable"
  elif printf '%s' "$body" | grep -q "review in progress by coderabbit.ai"; then
    if printf '%s' "$body" | grep -q "rate limited by coderabbit.ai"; then
      state="rate_limited"
    else
      state="in_progress"
    fi
  elif printf '%s' "$body" | grep -q "rate limited by coderabbit.ai"; then
    state="rate_limited"
  else
    state="unknown"
  fi
  # rate_limited のときは body から残り時間を抽出して walkthrough の updated_at に加算した
  # reset 予定時刻 (ISO8601 UTC) を出力に付与する。呼び出し元はこれを使って「reset まで待つ →
  # 再判定」を判断できる。CodeRabbit の rate-limit 文言は複数あるため両方サポート:
  # - adaptive 制限: "More reviews will be available in N minutes (and M seconds)"
  # - plan 制限:    "Next review available in: N minutes" (markdown bold で `**N minutes**`)
  local extra=""
  if [ "$state" = "rate_limited" ]; then
    local mins secs total updated_epoch reset_epoch reset_at
    mins=$(printf '%s' "$body" | grep -oE 'More reviews will be available in [0-9]+ minutes?' | grep -oE '[0-9]+' | head -1)
    if [ -z "$mins" ]; then
      # markdown bold (`**Next review available in:** **N minutes**`) を許容するため
      # `in:` と数字の間の `*` / space を `[^0-9]*` で許容する
      mins=$(printf '%s' "$body" | grep -oE '[Nn]ext review available in:[^0-9]*[0-9]+ minutes?' | grep -oE '[0-9]+' | head -1)
    fi
    secs=$(printf '%s' "$body" | grep -oE 'and [0-9]+ seconds?' | grep -oE '[0-9]+' | head -1)
    if [ -n "$mins" ]; then
      total=$((mins * 60 + ${secs:-0}))
      updated_epoch=$(date -u -d "$updated_at" +%s 2> /dev/null || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$updated_at" +%s 2> /dev/null || echo "")
      if [ -n "$updated_epoch" ]; then
        reset_epoch=$((updated_epoch + total))
        reset_at=$(date -u -r "$reset_epoch" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null || date -u -d "@$reset_epoch" +%Y-%m-%dT%H:%M:%SZ)
        extra=" rate_limit_reset_at=$reset_at"
      fi
    fi
  fi
  echo "updated_at=$updated_at state=$state$extra"
}

cmd_walkthrough_history() {
  owner_repo_n
  local wid node_id rc=0
  wid=$(cmd_walkthrough_id) || rc=$?
  if [ "$rc" -ne 0 ]; then
    # cmd_walkthrough_state と同じく lookup 失敗 (auth/rate-limit/network) は exit 1 で伝播する
    echo "walkthrough-history: walkthrough lookup failed" >&2
    return 1
  fi
  if [ -z "$wid" ]; then
    echo "no walkthrough"
    return 0
  fi
  node_id=$(gh api "repos/$OWNER/$REPO/issues/comments/$wid" --jq '.node_id') || return 1
  gh api graphql -f query="query { node(id: \"$node_id\") { ... on IssueComment { userContentEdits(first: 100) { nodes { editedAt diff } } } } }" \
    --jq '.data.node.userContentEdits.nodes[] | {
      editedAt,
      in_progress: ((.diff // "") | contains("review in progress by coderabbit.ai")),
      rate_limited_marker: ((.diff // "") | contains("rate limited by coderabbit.ai")),
      has_actionable_phrase: ((.diff // "") | (contains("No actionable comments were generated") or test("Actionable comments posted: [0-9]+")))
    }'
}

cmd_coderabbit_trigger() {
  owner_repo_n
  # POST レスポンスの created_at を posted_at として返す (ローカル時計に依存しない)
  # 失敗時は jq に渡る前に exit code が非 0 になり (set -uo pipefail)、何も出力されない
  # bot handle は `@coderabbitai` (公式ドキュメント表記、bot login も `coderabbitai[bot]` に合致)
  gh api "repos/$OWNER/$REPO/issues/$N/comments" -f body="@coderabbitai review" \
    --jq '"comment_id=\(.id) posted_at=\(.created_at)"'
}

cmd_wait_and_retrigger() {
  # walkthrough が rate_limited なら、body から抽出した reset 予定時刻まで待ってから
  # `@coderabbitai review` を自動投稿する。バックグラウンド (Bash run_in_background) で
  # 起動して放置できる設計。すでに rate_limited でなければ何もせず exit 0。
  #
  # 使い方:
  #   bash review-resolve-status.sh wait-and-retrigger [BUFFER_SECONDS]
  # BUFFER_SECONDS: reset_at に上乗せする待ち秒数 (default 60、reset 直後の race を回避)
  owner_repo_n
  local buffer="${1:-60}"
  local state_out reset_at now_epoch reset_epoch wait_seconds state
  state_out=$(cmd_walkthrough_state) || return 1
  state=$(printf '%s' "$state_out" | grep -oE 'state=[a-z_]+' | cut -d= -f2)
  if [ "$state" != "rate_limited" ]; then
    echo "walkthrough state=$state (not rate_limited); no retrigger needed" >&2
    return 0
  fi
  reset_at=$(printf '%s' "$state_out" | grep -oE 'rate_limit_reset_at=[^ ]+' | cut -d= -f2)
  if [ -z "$reset_at" ]; then
    echo "walkthrough rate_limited but reset_at unavailable; aborting" >&2
    return 1
  fi
  now_epoch=$(date -u +%s)
  reset_epoch=$(date -u -d "$reset_at" +%s 2> /dev/null \
    || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$reset_at" +%s 2> /dev/null \
    || echo "")
  if [ -z "$reset_epoch" ]; then
    echo "could not parse reset_at=$reset_at; aborting" >&2
    return 1
  fi
  wait_seconds=$((reset_epoch + buffer - now_epoch))
  if [ "$wait_seconds" -gt 0 ]; then
    echo "waiting ${wait_seconds}s until reset_at=$reset_at (+ ${buffer}s buffer)..." >&2
    sleep "$wait_seconds"
  else
    echo "reset_at=$reset_at already past; triggering immediately" >&2
  fi
  echo "posting @coderabbitai review..." >&2
  cmd_coderabbit_trigger
}

cmd_bot_reviews_since() {
  owner_repo_n
  local since="${1:?need timestamp ISO8601}"
  gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --paginate \
    --jq ".[] | select(.user.login? // \"\" | endswith(\"[bot]\")) | select(.submitted_at > \"$since\") | \"\\(.user.login? // \"ghost\") submitted_at=\\(.submitted_at) id=\\(.id)\""
}

cmd_codex_reaction() {
  owner_repo_n
  # 30 件超のリアクションがある PR で codex の eyes/+1 が後続ページに行くケースに対応するため --paginate
  gh api --paginate "repos/$OWNER/$REPO/issues/$N/reactions" \
    --jq '.[] | select(.user.login == "chatgpt-codex-connector[bot]") | "\(.content) at \(.created_at)"'
}

cmd_codex_cleared() {
  owner_repo_n
  local since="${1:?need SINCE_TS (ISO8601, e.g. \$LAST_PUSH_TS)}"
  # Codex 観点のクリア判定は 2 種類:
  # 1. SINCE 以降に Codex が +1 リアクションを付けた = この push のレビュー完了・指摘なし
  # 2. Codex が usage limit comment を投稿済み (SINCE 無関係 / 全期間で検索) = 課金上限到達で
  #    これ以降の push でも Codex はレビューしない確定。一度発生したら以降のすべての loop で
  #    Codex 観点を「待っても来ない」として永久に clear 扱いにする
  # 終了コード: 0=cleared, 1=not_cleared, 2=lookup_failed (gh api 失敗)
  # API 失敗を not_cleared と区別することで、呼び出し元が「真の未達」か「判定不能」かを分けて扱える
  local found rc=0
  found=$(gh api --paginate "repos/$OWNER/$REPO/issues/$N/reactions" \
    --jq ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.content == \"+1\") | select(.created_at > \"$since\") | .created_at") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "lookup_failed: reactions API (rc=$rc)" >&2
    return 2
  fi
  found=$(printf '%s' "$found" | head -1)
  if [ -n "$found" ]; then
    echo "cleared: +1 reaction at $found"
    return 0
  fi
  # usage_limit comment は SINCE フィルタなしで全期間検索する (一度出たら永久 clear)
  rc=0
  found=$(gh api --paginate "repos/$OWNER/$REPO/issues/$N/comments" \
    --jq ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.body | test(\"reached your Codex usage limits\")) | .created_at") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "lookup_failed: comments API (rc=$rc)" >&2
    return 2
  fi
  found=$(printf '%s' "$found" | head -1)
  if [ -n "$found" ]; then
    echo "cleared: usage_limit comment at $found (Codex は usage limit 到達後、以降の push でもレビューしない確定)"
    return 0
  fi
  echo "not_cleared"
  return 1
}

cmd_completion_summary() {
  owner_repo_n
  : "${MY_LOGIN:?MY_LOGIN not set; run 'review-resolve-status.sh init' first}"
  # 各セクションで「0 件」と「API 失敗」を区別する。bash 関数の終了ステータスは
  # `$?` で取れるが、コマンド置換 + パイプ後は失敗を捕捉しづらいため、各 helper を
  # `if cmd; then` で実行して取得成否を分岐する。
  # 完了確認用コマンドなので、どれか 1 セクションでも失敗したら最後に return 1
  local failed=0
  echo "--- threads (resolved/unresolved + hasMyReply) ---"
  local threads
  if threads=$(_fetch_all_review_threads | jq -r --arg me "$MY_LOGIN" '
    "\(if .isResolved then "[resolved]  " else "[unresolved]" end) \(.path):\(.line) cid=\(.comments.nodes[0].databaseId? // "none") author=\(.comments.nodes[0].author.login? // "ghost") hasMyReply=\([.comments.nodes[].author.login?] | any(. == $me))"'); then
    echo "${threads:-(0件)}"
  else
    echo "(取得失敗)"
    failed=1
  fi
  echo "--- codex reactions ---"
  local reactions
  if reactions=$(cmd_codex_reaction); then
    echo "${reactions:-(0件)}"
  else
    echo "(取得失敗)"
    failed=1
  fi
  echo "--- coderabbit walkthrough state ---"
  local state
  if state=$(cmd_walkthrough_state); then
    echo "${state:-(0件)}"
  else
    echo "(取得失敗)"
    failed=1
  fi
  return "$failed"
}

cmd_monitor_loop() {
  owner_repo_n
  : "${MY_LOGIN:?MY_LOGIN not set; run 'review-resolve-status.sh init' first}"
  : "${LAST_PUSH_TS:?LAST_PUSH_TS not set; run 'review-resolve-status.sh init' first}"
  # pipefail: 内部 pipe (rrs | jq) の左側失敗を握り潰さない
  set -o pipefail

  local last="$LAST_PUSH_TS"
  local walkthrough_last=""
  local codex_reaction_last=""

  # BSD (date -r EPOCH) と GNU (date -d @EPOCH) の両対応で 1 秒戻した ISO8601 を返す
  _date_minus_1s() {
    local epoch=$(($(date +%s) - 1))
    date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2> /dev/null \
      || date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ
  }

  while true; do
    # 次回 last の候補を polling 開始前に確定する。polling 中に created された event は
    # 今回の last より新しく next_watermark より古くなり、次回 iteration で必ず拾える
    local next_watermark
    next_watermark=$(_date_minus_1s)
    local failed=0

    # 失敗時は stdout に "poll-failed: ..." を出して通知化する。失敗を黙殺すると
    # 15 分タイムアウト判定で「無音」と区別できず誤って終了するため
    gh api --paginate "repos/$OWNER/$REPO/pulls/$N/reviews" \
      --jq ".[] | select(.submitted_at > \"$last\") | select(.user.login != \"$MY_LOGIN\") | \"review: \(.user.login) at \(.submitted_at) id=\(.id)\"" \
      || {
        echo "poll-failed: reviews"
        failed=1
      }
    gh api --paginate "repos/$OWNER/$REPO/issues/$N/comments" \
      --jq ".[] | select(.created_at > \"$last\") | select(.user.login != \"$MY_LOGIN\") | \"comment: \(.user.login) at \(.created_at) id=\(.id)\"" \
      || {
        echo "poll-failed: comments"
        failed=1
      }
    cmd_unresolved_threads \
      | jq -r --arg last "$last" --arg me "$MY_LOGIN" \
        '.comments.nodes[] | select(.createdAt > $last) | select(.author.login != $me) | "thread: \(.author.login) at \(.createdAt) cid=\(.databaseId)"' \
      || {
        echo "poll-failed: threads"
        failed=1
      }

    local walkthrough_now
    if walkthrough_now=$(cmd_walkthrough_state); then
      # 初回 polling (walkthrough_last="") でも有意な値が取れたら通知する。空 → 空の no-op は通知しない
      if [ -n "$walkthrough_now" ] && [ "$walkthrough_now" != "$walkthrough_last" ]; then
        echo "walkthrough: $walkthrough_now"
      fi
      walkthrough_last="$walkthrough_now"
    else
      # cmd_walkthrough_state は lookup_failed のとき exit 1 を返す。no_walkthrough は exit 0
      echo "poll-failed: walkthrough-state"
      failed=1
    fi

    # Codex の eyes/+1 リアクション変化を通知。Codex が新 review を出さず +1 だけ付けた
    # 「クリーン完了」も検知できるようにする
    local codex_reaction_now
    if codex_reaction_now=$(cmd_codex_reaction); then
      codex_reaction_now=$(printf '%s' "$codex_reaction_now" | sort -u | tr '\n' '|')
      # 初回 polling (codex_reaction_last="") で「Codex は既に eyes/+1 を付けている」状態を
      # 取りこぼさないため、現在値が非空なら必ず通知。空 → 空は no-op で通知しない
      if [ -n "$codex_reaction_now" ] && [ "$codex_reaction_now" != "$codex_reaction_last" ]; then
        echo "codex-reaction: $codex_reaction_now"
      fi
      codex_reaction_last="$codex_reaction_now"
    else
      echo "poll-failed: codex-reaction"
      failed=1
    fi

    # polling が 1 つでも失敗していたら watermark を進めない (失敗中に created された event を
    # 次回でも拾える状態に保つ)。全 polling 成功時のみ watermark を更新する
    if [ "$failed" -eq 0 ]; then
      last="$next_watermark"
    fi
    sleep 30
  done
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    init) cmd_init "$@" ;;
    unresolved-threads) cmd_unresolved_threads "$@" ;;
    outside-diff-reviews) cmd_outside_diff_reviews "$@" ;;
    react) cmd_react "$@" ;;
    resolve) cmd_resolve "$@" ;;
    walkthrough-id) cmd_walkthrough_id "$@" ;;
    walkthrough-state) cmd_walkthrough_state "$@" ;;
    walkthrough-history) cmd_walkthrough_history "$@" ;;
    coderabbit-trigger) cmd_coderabbit_trigger "$@" ;;
    wait-and-retrigger) cmd_wait_and_retrigger "$@" ;;
    bot-reviews-since) cmd_bot_reviews_since "$@" ;;
    codex-reaction) cmd_codex_reaction "$@" ;;
    codex-cleared) cmd_codex_cleared "$@" ;;
    completion-summary) cmd_completion_summary "$@" ;;
    monitor-loop) cmd_monitor_loop "$@" ;;
    "" | help | -h | --help)
      sed -n '5,30p' "$0"
      ;;
    *)
      echo "unknown subcommand: $sub" >&2
      exit 2
      ;;
  esac
}

main "$@"
