# lsp

Windows 上の Claude Code で LSP サーバーとの通信を修復する、透過プロキシ経由の LSP 統合プラグイン。

## 解決する問題

Windows 上の Claude Code には LSP 系プラグインが動作しない既知の不具合があり、関連 issue ([anthropics/claude-code#27061](https://github.com/anthropics/claude-code/issues/27061) ほか) は not_planned で close されている。原因は次の 3 つ。

1. **`.cmd` ラッパーを起動できない** — `spawn()` が `shell: true` なしで呼び出されるため、npm が生成する `.cmd` ラッパー (typescript-language-server、pyright など) の起動が ENOENT で失敗する
2. **ファイル URI の形式不整合** — 同じファイルに対して `didOpen` は `file://D:\path\to\file.ts`、クエリ操作は `file:///D:/path/to/file.ts` を送信するため、サーバーがファイルを照合できず hover などが機能しない
3. **Content-Length の誤計算** — バイト数であるべき Content-Length を文字数で計算しているため、マルチバイト文字を含むメッセージが破損する

## 仕組み

`proxy.mjs` が Claude Code と言語サーバーの間に挟まり、3 つの原因をすべて修正する。

```
Claude Code --spawn--> node proxy.mjs <実体コマンド> [引数...]
                            |  (フレーミング修正 + URI 正規化)
                            +--spawn--> 実体の言語サーバー
```

- 実体コマンドを PATH + PATHEXT で解決し、`.cmd`/`.bat` のみ cmd.exe 経由で起動する
- クライアント → サーバー方向のメッセージをバイト精度で再フレーミングし、ファイル URI を正規形 `file:///X:/...` に統一する
- サーバー → クライアント方向は無変換で素通しする
- 非 Windows では全入出力を素通しする (実質的な透過となり無害)

依存パッケージはなく、Node.js のみで動作する。

## 対応言語

[公式マーケットプレイス](https://github.com/anthropics/claude-plugins-official) の全 LSP プラグインと同じ 12 言語に対応する。対象拡張子は公式定義と同一 (`.claude-plugin/plugin.json` を参照)。

| 言語 | 言語サーバー | 導入例 |
|---|---|---|
| TypeScript / JavaScript | typescript-language-server | `npm install -g typescript-language-server typescript` |
| Python | pyright | `npm install -g pyright` |
| C / C++ | clangd | LLVM 同梱 / GitHub リリース |
| C# | csharp-ls | `dotnet tool install -g csharp-ls` |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| Java | jdtls | Eclipse JDT Language Server 配布物 (JDK 17 以上) |
| Kotlin | kotlin-lsp | JetBrains の kotlin-lsp 配布物 |
| Lua | lua-language-server | GitHub リリース |
| PHP | intelephense | `npm install -g intelephense` |
| Ruby | ruby-lsp | `gem install ruby-lsp` |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |
| Swift | sourcekit-lsp | Swift toolchain 同梱 |

プロキシ経由での動作を実機検証済みなのは TypeScript / JavaScript、Python、Go、Rust。他の言語は公式定義の `command` / `args` をプロキシ経由に書き換えたのみだが、プロキシは実体コマンドに依存しないため同様に動作する。

## インストール

言語サーバー本体は公式プラグインと同様に別途導入しておく。利用する言語のものだけでよい (上表の導入例を参照)。

TypeScript / JavaScript では、対象ワークスペースに tsserver.js を同梱する TypeScript 5 系を導入する (`npm install -D typescript@5`)。TypeScript 7 系はネイティブ実装で tsserver.js を同梱しないため、typescript-language-server の初期化が失敗する。

Claude Code の TUI 上で以下を実行:

```
/plugin marketplace add 9c5s/agent-tools
/plugin install lsp@agent-tools
```

## 対応言語の追加

公式マーケットプレイスにない言語サーバーも、`.claude-plugin/plugin.json` の `lspServers` に同じ形式で追記すれば利用できる。起動コマンドの先頭にプロキシを挟むだけでよい。

```jsonc
"zls": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/proxy.mjs", "zls"],
  "extensionToLanguage": { ".zig": "zig" }
}
```

## 他のエージェント・クライアントでの利用

`proxy.mjs` はエージェント非依存の透過プロキシであり、stdio で LSP サーバーと通信する任意のクライアントで利用できる。起動コマンドの先頭に `node <パス>/proxy.mjs` を付けるだけでよい。

```
node proxy.mjs typescript-language-server --stdio
```

## デバッグ

環境変数 `LSP_PROXY_LOG=1` を設定すると、カレントディレクトリの `lsp-proxy.log` に両方向の全トラフィックを出力する。

## テスト

```
node --test test/proxy.test.mjs
```
