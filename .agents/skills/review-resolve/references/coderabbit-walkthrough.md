# CodeRabbit walkthrough の段階更新

walkthrough コメントは段階的に edit され、edit ごとに状態マーカーが切り替わる。

## マーカー一覧

| マーカー (HTML コメント) | 意味 | 出現タイミング |
|---|---|---|
| `<!-- ...: review in progress by coderabbit.ai -->` | 進行中 (`> [!NOTE] Currently processing...`) | 0th (~15s)、1st (~1.5m) |
| `<!-- ...: rate limited by coderabbit.ai -->` | レートリミット (`> [!WARNING] Review limit reached`) | rate-limit 発火時 (~8m) |
| `No actionable comments were generated in the recent review. 🎉` | 完了・指摘なし | 完了 edit (~5〜8m) |
| `Actionable comments posted: N` (N > 0) | 完了・inline 指摘あり | 完了 edit (~5〜8m) |

## 判定で踏まないと混乱する点

- **進行中マーカーが残っている間は完了とみなさない**。1.5 分時点で Walkthrough/Changes/Pre-merge checks が body に表示されていても、進行中マーカーが消えるまでは 5〜8 分待つ
- **過去のレートリミット履歴は body に残り続ける**。`rate limited` マーカーの単純存在チェックは過去の rate-limit セッションでも true になる。`rrs walkthrough-state` は最新 edit の状態だけを見るので安全
- **`@coderabbit review` への自動応答** (Review triggered, 投稿の数秒後): incremental review system のため既にレビュー済みコミットは re-review されない可能性がある旨の注記付き。新規 commit 無しで再依頼してもレビュー結果が変わらないことがある

walkthrough の編集履歴を直接見たい場合は `rrs walkthrough-history` (各 edit を 3 マーカーで分類した JSON 行)。
