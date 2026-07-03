# 実装計画書 (Plan) レビューの追加観点

設計仕様 (spec) より一段下の実装計画書 (Plan) を Codex レビューに掛ける場合、spec とは異なる失敗モードが出やすい。round 1 のプロンプトのレビュー観点に以下を含め、自分でも反映時のチェックに使う。

## 1. Plan 間整合 (複数ファイル分割時)

複数 Plan (例：bootstrap → stage1 → stage2) に分かれた場合に崩れやすいもの：

- **識別子の表記揺れ**：binding 名、型名、ファイル名が Plan 間で微妙に違う
- **interface signature の互換性**：前段 Phase で定義した signature を後段 Phase で破壊的変更する場合、その変更が後段の Plan に明示されているか
- **同じ概念を複数 Phase で触る箇所**：後段の書き換えが前段の決定を巻き戻していないか (例：設定ファイルの同一キーを bootstrap と stage1 の両方が書く場合、stage1 側の記述が bootstrap の決定を含んでいるか)

## 2. Task 順序と prerequisite

- **前提を後から作る順序の逆転**：Task 5 のコードが Task 10 で作る型に依存している → typecheck が Task 5 で失敗する
- **外部システムへの登録とデプロイの順序**：デプロイ完了前に外部側へ登録すると 404 などで失敗する類の依存
- **不可逆操作の前の動作確認**：rollback がブロックされる操作 (migration を含むデプロイなど) の前に、動作確認が完了する順序になっているか
- **保護設定の有効化タイミング**：branch protection のような「有効化すると以降の操作が制約される」設定は、依存する操作 (CI 完走など) の後に置かれているか

## 3. Task 番号変更時の参照更新

新規 Task を挿入する場合 (例：Task 4 と 5 の間に 4.5)、grep で全参照を洗う：

- Self-Review セクション内の Task 番号参照
- 別 Plan ファイルからの参照 (「stage2 Task N」など)
- 同一 Plan 内の他 Task からの参照 (「Task 18 Step 3 を参照」など)

## 4. commit 境界の整合

各 Task の `git add` / `git commit` が**その Task 内で変更したファイルすべて**を含むか。ある Step の変更が commit から漏れると次 Task へ持ち越され、「赤→緑→commit」の Task 境界が壊れる。

関連する罠：**`git grep` は untracked file を見ない**。新規ファイル作成直後に check script を走らせる Plan は、`git add` を前に挟むか、recovery 経路で再 `git add` を冗長化する。

## 5. TDD 約束と実装の同期

Plan の Interfaces セクションで「純粋関数 X を export して TDD」と約束したら、実 Task に X の独立 Step (テスト作成を含む) が残っているか確認する：

- Interfaces で export を約束した関数が、実 Task では handler 内の inline 実装になっている → 約束違反
- 「X を export」と書いたら、対応する Task に X のテストを書く Step があるか

## 6. 自己参照ファイルの scan 除外設計

placeholder / secret 検出 script は自分自身が検出対象の literal を持つ (ouroboros 問題)。Plan にこの種の script が含まれるなら：

- 除外 allowlist は最小限にする (docs / 永続ドキュメント / script 自身)
- **allowlist 内は CI で検出されない経路として残る**ことを認識し、二次防御 (allowlist をより狭くした secret-like literal scan) を検討する
- allowlist 内への実 token / 実 ID のコミットは「scan の責務外、手動レビュー責務」と Plan と関連ドキュメントに明記する

## 7. 上位ドキュメントとの整合

Plan の修正が HANDOFF / spec / architecture の前提を覆していないか、round が進んだら (目安：round 6 以降) cross-check する：

- spec で「公開値」と決めたものを Plan の secret scan 対象に加える、のような逆行がないか
- 用語や表記 (「Runtime secret のみ」など) が文書間で揃っているか
- 修正が他文書に影響するなら、Plan だけでなく他文書も同時に直接編集する

## 8. checkbox 消化型 agent への配慮

`superpowers:executing-plans` のような Step を機械的に消化する agent が実行する前提で書かれているか：

- 条件分岐で skip する Step は見出しに「(〜の場合のみ)」を付けて明示する

  ```markdown
  - [ ] **Step 4 (cleanup する場合のみ): cleanup 用に `.dev.vars` を一時復元**
  ```

- 「Step 3 で『しない』を選んだ場合、Step 4-6 はチェックせず Step 7 へ進む」のような skip 指示を、分岐元 Step の本文に書き、agent が自力で判断できる形にする
