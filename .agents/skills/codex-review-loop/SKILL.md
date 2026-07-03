---
name: codex-review-loop
description: "ドキュメント (設計仕様、実装計画、ADR、運用手順) からコード (working tree / branch 差分 / 実装全体) まで、任意の対象を Codex (codex-companion ランタイム) に独立レビュアーとして厳密レビューさせ、PASS が出るまで「指摘→HYPOTHESIS 一次資料検証→反映→再レビュー」を同一スレッドで反復改善する汎用レビューループ。「Codex にレビューさせて」「レビューループを回して」「PASS まで磨いて」「この仕様/計画書/ブランチ/実装を厳密レビューして直して」「codex review loop」のような依頼で必ず使う。GitHub PR 上のレビュースレッドへの返信と resolve の対応だけは review-resolve の領分で、本スキルは対象外。"
argument-hint: "[レビュー対象 (ファイルパス / ブランチ / diff 範囲)...]"
---

# Codex レビューループ

ドキュメント (設計仕様 / 実装計画 / ADR / 運用手順) やコード (差分 / 実装全体) を Codex に独立レビュアーとして厳密レビューさせ、**PASS** が出るまで「指摘 → HYPOTHESIS 検証 → 反映 → 再レビュー」を同一スレッドで反復する。

自分で書いた仕様やコードは内部視点に閉じやすく、指摘への都度の差分対応では全体整合が崩れる。さらに Codex の不確実な指摘 (HYPOTHESIS) を鵜呑みにすると誤った設計を採用してしまう。このループは「毎 round の独立検証」と「同一スレッド継続によるレビュアー側のコンテキスト蓄積」の組み合わせで、一次資料と整合の取れた成果物に収束させる。

## 同梱リソース

本スキルのディレクトリ (`${CLAUDE_SKILL_DIR}`) 配下：

- `references/verification-sources.md`：HYPOTHESIS を一次資料で検証する際のドメイン別情報源と検証のコツ。検証フェーズに入る前に読む
- `references/plan-review-checklist.md`：レビュー対象が実装計画書 (Plan) の場合の追加観点。Plan を対象にするなら round 1 の前に必ず読む

## 前提と初期化

1. codex プラグインがインストール済みであること。不安なら `codex:setup` skill で確認する
2. companion スクリプトのパスを解決する。**バージョン番号をハードコードしない** (プラグイン更新でパスが変わり、古いパスは silent に消える)：

```sh
# ls は環境によって -F などが alias され出力にゴミが付くため、glob + printf で解決する
script=$(printf '%s\n' "$HOME/.claude/plugins/cache/openai-codex/codex/"*/scripts/codex-companion.mjs | sort -V | tail -1)
[ -f "$script" ] && echo "companion: $script" || echo "codex plugin が見つからない。/codex:setup を案内する"
```

シェル変数は Bash ツールの呼び出し間で保持されない。以降のコード例の `$script` は、**各呼び出しの冒頭でこの解決行を再実行する**か、解決済みの絶対パスをリテラルで埋めて使う。

3. 一次資料を読む手段 (WebFetch / 各種 docs MCP / Context7) が使えることを確認する。利用可能なツール名はセッションにより異なるため、必要になった時点で ToolSearch で探す

## 全体フロー

```
[Round N の入口]
   ▼
[Codex に厳密レビューを依頼 (--resume で同一スレッド継続)]
   ▼
[verdict を取得: PASS / ISSUES]
   ├─ PASS → 最終確認してループ終了
   └─ ISSUES
       ▼
   [critical / major / minor を分類]
       ▼
   [HYPOTHESIS (タグなし URL 提示含む) を一次資料で検証]
       ├─ 検証 OK → 対象に反映 + 根拠 URL 併記
       └─ 検証 NG → 反映せず、棄却理由を記録
       ▼
   [対応内容を説明しつつ Round N+1 を起動] → 入口へ戻る
```

## レビュー対象と入口

このループは対象を選ばない。round 1 の入口だけが異なり、round 2 以降の回し方 (--resume / 検証 / 反映) は共通：

- **ドキュメント (spec / plan / ADR / 運用手順)**：`task` に絶対パスとレビュー観点を渡す (後述の Round 1)
- **実装全体 / 特定モジュール**：ドキュメントと同じく `task` にパスとレビュー観点を渡す
- **コード差分 (working tree / branch)**：ループを回すなら `task` のプロンプトに diff の範囲 (base ref / 対象パス) を明記して渡す。companion には diff 自動収集の専用サブコマンドもあるが、**これらのジョブは jobClass が review であり `task --resume` の再開対象にならない** (companion 実装で確認済み)。スレッド継続が要らない単発レビューにだけ使う：

  ```sh
  # 単発向け。このスレッドは task --resume で継続できない
  node "$script" review --background --scope <auto|working-tree|branch> [--base <ref>]
  node "$script" adversarial-review --background --scope branch [focus text]
  ```

対象がコードの場合、「反映」はコード修正を意味し、次 round 投入前にテスト / typecheck を通しておく。なお GitHub PR 上のレビュースレッド (bot コメント) への返信と resolve の対応は本スキルではなく `review-resolve` を使う。

## Round の回し方

全 round 共通: プロンプトは **Write ツールで scratchpad の一時ファイルに書き、`--prompt-file` で渡す**。プロンプト本文をシェルに通さないため、バッククォートやクォートの事故が構造的に起きない。

### Round 1 (新スレッド)

resume 可能な既存スレッドの有無を先に確認する：

```sh
node "$script" task-resume-candidate --json
```

`available: true` の場合は candidate の title / summary を確認し、本ループの続きなら round 2 以降の手順 (`--resume`) に合流する。無関係なスレッド、または `false` なら新スレッドで始める：

```sh
node "$script" task --background --fresh --prompt-file "<scratchpad>/round-1.md"
```

投入時の stdout に出る `started in the background as task-xxxx-yyyy` の task-id を控える。完了待ち、結果取得、中断はすべてこの ID で行う。

`codex:rescue` skill (Agent ツール、`subagent_type: "codex:codex-rescue"`、プロンプトで `--fresh` を指示) 経由でも起動できるが、その場合は完了待ち〜結果取得を subagent が担うため task-id ベースの後述手順は使わない。どちらの経路でも round 1 プロンプトに含めるもの：

- レビュー対象の**絶対パス** (Codex は別プロセスなので相対パスは通じない)
- 関連コンテキストへのパス (HANDOFF.md、architecture.md、上位 spec など)
- レビュー観点の列挙 (セキュリティ / 整合性 / 実現可能性 / 抜け漏れ / 設計判断の妥当性 / ドキュメント可読性。Plan 対象なら `references/plan-review-checklist.md` の観点も追加)
- 回答フォーマットの指定 (verdict 1 行 + critical/major/minor の優先度別箇条書き、不確実な指摘には HYPOTHESIS タグ)

### Round 2 以降 (--resume)

subagent 経由でも動くが、subagent が再 resume を queue できないケースが実際にあったため、**直接 companion を叩く方が確実**：

```sh
node "$script" task --background --resume --prompt-file "<scratchpad>/round-N.md"
```

round プロンプトのテンプレート (`round-N.md` の中身)：

```
round <N-1> で指摘された <総数> 件 (critical/major/minor の内訳) に対応した。
HYPOTHESIS は一次資料で検証した上で反映 / 棄却した：

(critical 1) <検証結果と根拠 URL>
(major 1) ...
(minor 1) ...

(棄却した指摘があれば:)
(検証で誤りと判明) <Codex の主張> → <検証根拠> により反映しない。<該当 section> に判断記録を残した

対象は <絶対パス> に保存済み。round <N> を厳しい観点でレビューしてくれ。
verdict は冒頭に PASS または ISSUES を 1 行。ISSUES なら critical/major/minor 区分で具体指摘と対応方針を箇条書きで。
HYPOTHESIS タグは引き続き付けてくれ。
これまでの確定事項を確認 / 否定する new evidence があれば必ず指摘してほしい。
本 round の修正で新たな矛盾 (regression) が生じていないかも念入りに見てほしい。
```

round 2 以降のプロンプトに毎回含める観点 (round 6 以降の cross-check を除きテンプレートに織り込み済み)：

- 前 round の指摘件数と分類、各指摘への対応 1 行要約 (HYPOTHESIS の verify 結果含む)
- 「確定事項を覆す new evidence の指摘」依頼 (蓄積した判断が後続 round で黙って覆る事故を防ぐ)
- 「修正による新たな矛盾 (regression) の検出」依頼
- round 6 以降は「累積指摘がすべて解消されているか cross-check」も指示する。Critical / Major が 0 件に落ちてから PASS 判定が出やすい

**罠 (実際に踏んだもの)**：

- プロンプトをインラインや heredoc で渡すと、中のバッククォートが bash の command substitution として**実行される** (code のつもりで書いた `bunx wrangler login` が実際に走りブラウザが開いた事故がある)。`--prompt-file` を使っていればこの経路自体が存在しない。やむを得ずインラインで渡す場合のみ `<<'EOF'` (シングルクォート付き heredoc) を使い、本文中のバッククォートを避ける
- running 中の codex task がある状態で再 resume すると `Task <id> is still running` で fail する。前 round の完了を待ってから投入する
- `--resume` は「現在の Claude セッションで最後に完走した task スレッド」を再開する実装で、スレッド ID の指定はできない。**ループ中に無関係な codex task を挟むと resume 先がその task のスレッドにすり替わる**。ループ中は他の codex task を投入しない。不安なら投入前に `task-resume-candidate --json` で candidate の title / summary がこのループのものか確認する

### round ごとの調整オプション (--effort / --model / --write)

いずれも必要な round だけ使う：

- `--effort <none|minimal|low|medium|high|xhigh>`：推論努力の調整。round 1 の初回総点検や PASS 判定前の最終 cross-check round は high 以上を検討する。軽微な修正確認 round は既定で十分
- `--model <model|spark>`：モデル切替 (`spark` は `gpt-5.3-codex-spark` のエイリアス)
- `--write` は**レビュー用途では付けない**。既定の read-only sandbox が「レビュアーは対象を書き換えない」という独立性を保証している。指摘の反映は検証を挟んで Claude 側が行うのがこのループの分業

### 完了待ちと中断

1 round は数分〜数十分かかる。`status <task-id> --wait` が指定 job の完了まで内部でポーリング (2 秒間隔) するので、これを Bash の `run_in_background: true` で起動して完了を待つ：

```sh
# 既定 timeout は 240 秒しかないため明示的に延長する (例: 60 分)
node "$script" status <task-id> --wait --timeout-ms 3600000 --json
```

- タイムアウトしても異常終了はせず、出力 JSON の `waitTimedOut: true` で判別できる。まだ running なら再度 --wait する
- job-id 指定で待つため、他の codex job が動いていても誤検知しない (全 job を grep する方式だと無関係な job で待ち続ける)
- round を中断したい場合 (誤投入や resume 先の間違いなど) は `node "$script" cancel <task-id>` で止める
- job が failed になった場合は `result <task-id>` で error を確認し、原因を潰してから同じ prompt ファイルで再投入する。応答に verdict 行がない場合は、verdict 行 (PASS / ISSUES) だけを求める短い follow-up を `--resume` で投げる

### 結果取得

```sh
node "$script" result <task-id> --json
```

`<task-id>` は task 投入時の stdout に出る (`... started in the background as task-xxxx-yyyy`)。省略すると最後に finished した job が返るが、複数 round 連続実行時は ID 指定が安全。

## HYPOTHESIS の検証

Codex は不確実な指摘に `[HYPOTHESIS]` タグを付ける建前だが、**自信ある形で URL だけ提示してタグを付けないこともある**。どちらの場合も必ず独立に一次資料で verify する。Codex の主張が結果的に正しくても、確認を省くと「誤った URL を引いた」「URL の内容が古い」事故を見落とす。ドメイン別の情報源と検証のコツは `references/verification-sources.md` を読む。

検証結果は 3 通りに処理する：

- **正しいと確認できた** → 反映し、根拠 URL を対象ドキュメント本文 (コードの場合は該当箇所のコメントやプロジェクト docs) に併記する
- **誤りと判明した** → 反映せず、棄却理由と根拠を対象ドキュメント内 (コードの場合はプロジェクト docs) に記録する (後続 round での再指摘や誤適用を防ぐ)
- **公式が沈黙している** → 安全側の解釈を採用し、その判断と根拠 (= 沈黙) を明記する。将来公式が明文化したら見直す旨も書く

検証で得た知見はスキルや個人メモに溜めず、**対象ドキュメント (またはプロジェクトの docs) に根拠 URL 付きで記録**する。プロジェクト固有の検証蓄積をプロジェクト側に置くことが、このスキル自体を汎用に保つ前提になっている。

## 反映時のルール

- 対象がドキュメントの場合、上端に round カウンタ (状態行) を置き、毎 round 更新する。コードの場合は毎 round のユーザー報告とコミットメッセージで round を追跡する
- 反映した指摘は次 round のプロンプトに明示し、Codex が同じ指摘を繰り返さないようにする
- 反映しなかった指摘は判断記録 (棄却理由 + 根拠) をドキュメント内に残す
- 同じ概念を複数ファイル / 複数 Phase / 複数 Task で触る場合、**片方の修正が他方の確定事項を巻き戻していないか、反映前に grep で確認する**。Round N の修正が Round N-1 の確定事項を覆すのが最も典型的な regression 事故

## 終了条件 (PASS)

verdict 行に `PASS` が出たらループ終了。ただし以下を最終確認する：

- 直前 round の指摘に HYPOTHESIS タグが残っていないか (残っていれば実装後の要観測項目として記録する)
- 「実地検証する」と書いたまま一次資料との突合せが済んでいない項目がないか
- (ドキュメント対象) 未解決の `<placeholder>` が残っていないか (置換は実装フェーズの仕事だが、存在の把握はここでする)
- (ドキュメント対象) 上端の状態行を「round N PASS」に更新する (レビュー経緯の記録としてそのまま残す)
- (コード対象) 最終状態でテスト / typecheck / lint が通っているか。PASS verdict はレビュー観点の判定であって CI 相当の検証は含まれない

## 運用上の注意

- **レビュー対象の内容は OpenAI 側に送られる**：transfer に限らず、task で渡したパスのファイル内容も Codex が読む。機密や個人情報を含む対象は、ループ開始前にユーザーへ確認する
- **盲目的に反映しない**：実績として、Codex が正しかった例 (一旦否定した指摘が公式仕様で裏付けられた) も、誤っていた例 (他ツール前提の HYPOTHESIS が対象環境では不成立) も両方ある。verify が唯一の判定手段
- **設計の本質的変更を勧められた場合**：反映前にユーザーへ確認する。連絡はその時ユーザーがいるチャネル (Discord など) で行う
- **毎 round 完了時にユーザーへ報告する**：ループは長時間かかり、ユーザーは別作業と並行している。verdict / 指摘件数と内訳 / 次アクションを毎回報告する。Discord はテーブル非対応なので箇条書きで書く
- **token 費用を意識する**：1 round あたり数千〜1 万 token 消費する。HYPOTHESIS を早めに verify して各 round の質を上げ、round 数を抑える方向に倒す
- **Codex のスレッドは companion 側で管理**されており、Claude Code の会話履歴とは独立。`--resume` で同じスレッドを継続する。ただし resume 候補は **workspace + 現在の Claude セッション単位**で解決されるため、Claude Code のセッションを跨ぐと候補が見つからないことがある。ループはなるべく 1 セッション内で完走させる。跨いでしまったら `task-resume-candidate --json` で確認し、候補がなければこれまでの対応履歴の要約をプロンプトに添えて新スレッド (`--fresh`) で再開する
- **収束の兆候**：Critical / Major が 0 になり、文言整合や数値合わせのような Minor だけが残ったら、PASS まであと 1〜2 round

## Claude セッションの引き継ぎ (transfer)

ループ本体とは別の補助動線として、現在の Claude Code セッション (jsonl) を丸ごと Codex スレッドに変換できる：

```sh
node "$script" transfer --json   # 既定は現セッション。--source <claude-jsonl> で別セッションも指定可
```

出力の `threadId` を `codex resume <threadId>` で開くと、Claude 側の議論履歴が見える状態で Codex と対話できる。

- **使いどころ**：レビュー対象がまだドキュメント化されていない段階で、Claude と練った議論の文脈全体を Codex に渡して壁打ちや対話レビューしたい場合。レビュー観点をプロンプトに書き起こす手間なく文脈を共有できる
- **ループには接続できない**：transfer が作るスレッドは companion の job 管理外で、`task --resume` の再開対象にならない (companion 実装で確認済み)。PASS まで回すループは従来通り `task` で回す
- **セッション全文が OpenAI 側に送られる**：機密や個人情報を含むセッションで使う前に、送ってよい内容かを確認し、迷ったらユーザーに確認する

## 対象が実装計画書 (Plan) の場合

spec より一段下の実装計画書は、spec とは異なる失敗モード (Plan 間整合、Task 順序、commit 境界、TDD 約束の同期など) を持つ。**round 1 のプロンプトを書く前に `references/plan-review-checklist.md` を読み、レビュー観点に含める**。
