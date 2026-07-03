# HYPOTHESIS 検証のドメイン別情報源

Codex の指摘を一次資料で検証する際の情報源カタログ。利用可能な MCP ツールの名前はセッション (claude.ai コネクタ / プラグイン) によって変わるため、ツール名をハードコードせず、まず ToolSearch でドメイン名 (「cloudflare documentation」など) を検索し、なければ WebFetch で公式ドキュメントを直接読む。

## 検証の一般戦略

優先順位は以下の通り。上から順に試す。

1. **公式 docs 検索 MCP**：そのドメイン専用の検索ツールがあれば最優先 (最新かつ構造化されている)
2. **WebFetch で公式ドキュメントの該当ページを直接読む**：URL が分かっている、または Codex が URL を提示した場合
3. **ソースそのものを読む**：docs が沈黙している挙動 (fallback 順序、内部で叩くコマンドなど) は実装を読むしかない

## ドメイン別パターン

以下は代表例である。載っていないドメインは上の一般戦略で対応する。検証で得た個別の verified 事実は本ファイルには足さず、対象プロジェクトの docs に蓄積する (スキルを汎用に保つため)。

### Cloudflare (Workers / wrangler / Durable Objects / KV / Workers Builds)

- 第 1 候補：Cloudflare documentation 検索 MCP (ToolSearch で「cloudflare documentation」)
- 第 2 候補：WebFetch で `developers.cloudflare.com` の該当ページ
- API の現行形と古い形が混在しやすい (例：Durable Object base class は現行 `extends DurableObject<Env>` + `super(ctx, env)` であり、`implements DurableObject` は公式 docs から消えた古い形)。**現行ページに載っている形**を正とする

### GitHub Actions / Dependabot / REST API

- WebFetch で `docs.github.com` の該当ページを直接読む
- REST API の required body 構造 (branch protection PUT など) は該当 endpoint のリファレンスページで required / nullable を確認する。「null 可だが省略不可」のような罠がある
- Dependabot のエコシステム対応はバージョン閾値付きで書かれていることが多い。対象プロジェクトのバージョンと突き合わせる

### GitHub Action の実装そのもの (サードパーティ action)

- WebFetch で `https://raw.githubusercontent.com/<owner>/<repo>/<default-branch>/action.yml` を読む
- input の fallback 順序、デフォルト値、内部で叩くコマンド (SHA pin で塞げない supply-chain 経路の有無) は README ではなく action.yml とソースで確認する

### Bun

- WebFetch で `https://bun.com/docs/...` を読む
- npm 前提の指摘 (lifecycle script、`--ignore-scripts` の意味など) は Bun では成立しないことがある。**「npm ではこうだから Bun でもこう」という HYPOTHESIS は特に疑う**

### Biome

- WebFetch で `https://biomejs.dev/` の該当ガイド。メジャーバージョン間の config 構造変更は upgrade ガイド (例：`/guides/upgrade-to-biome-v2/`) が網羅的

### 任意のライブラリ / フレームワーク

- Context7：`resolve-library-id` → `query-docs`
- DeepWiki (`ask_question`)：特定 repo の実装に関する質問に有効

## 検証のコツ

- 「docs の周辺ページを眺めた」で終わらせず、**その主張を直接支持または否定する記述**まで読み込む。見つからなければ「沈黙」として扱う
- 公式が沈黙している場合、沈黙自体が検証結果。安全側の解釈を採用し、根拠 (= 沈黙) をドキュメントに記録する
- バージョン依存の主張 (「>=vX.Y でサポート」など) は、対象プロジェクトが実際に使うバージョン (lockfile / CI 設定) と突き合わせて初めて検証完了とする
- Codex が URL を提示してきた場合も、URL の内容が主張と一致するか、古くないかを必ず読んで確認する。URL 提示 = 検証済みではない
