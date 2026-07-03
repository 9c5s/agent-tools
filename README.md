# agent-tools

9c5s's skill collection for coding agents.

Claude Code の [プラグインマーケットプレイス](https://code.claude.com/docs/en/plugin-marketplaces) を通じて配布される、個人向け AI コーディングエージェント用スキル集。

## インストール

Claude Code の TUI 上で以下を実行:

```
/plugin marketplace add 9c5s/agent-tools
/plugin install 9c5s@agent-tools
```

インストール後、収録スキルは `9c5s:<スキル名>` の名前空間で自動的にトリガー可能になる。

## 収録スキル

| 名前 | 用途 |
|---|---|
| `codex-review-loop` | Codex に厳密レビューさせ、PASS まで指摘→検証→反映→再レビューを繰り返す汎用レビューループ |
| `japanese-tech-writing` | 日本語技術文書の文章規範 (整形、パラグラフライティング、論証の厳密さ、LLM っぽい空句の禁止など) を適用して執筆・推敲する |
| `parallel-dispatch` | 複数スキルを同一対象に対してサブエージェントで並列実行し、結果を統合する |
| `review-resolve` | PR のレビュー指摘 (未解決スレッド、diff 範囲外コメント、bot レビュー) を採用/不採用判定して 👍/👎 リアクション + resolve まで潰す |
| `tdd` | t-wada 式 9 項目チェックでテストコードの品質を分析するレビュー用スキル |

各スキルの詳細は `.agents/skills/<name>/SKILL.md` を参照。

## リポジトリ構成

```
agent-tools/
├── .claude-plugin/marketplace.json   # マーケットプレイス定義
├── .agents/                          # プラグインルート (install 対象)
│   ├── .claude-plugin/plugin.json    # プラグイン定義
│   └── skills/                       # 5スキル
├── .claude/                          # 個人設定 (install 対象外、公開のみ)
│   ├── CLAUDE.md
│   ├── commands/
│   ├── hooks/
│   ├── scripts/
│   └── settings.json
├── README.md
└── LICENSE
```

`.claude/` は作者本人の個人設定であり、`/plugin install` の対象外。GitHub 上では公開されているが、他ユーザーがインストールすることはない。

## ライセンス

[MIT License](./LICENSE)
