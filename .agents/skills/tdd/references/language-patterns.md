# 言語別テストパターン リファレンス

テストファイルの検出、フレームワーク、言語固有の注意点をまとめたリファレンスである。

## 目次

- [セクション1: 汎用テストファイル検出ガイド](#セクション1-汎用テストファイル検出ガイド)
- [セクション2: 主要言語の具体パターン](#セクション2-主要言語の具体パターン)
  - [Python](#python)
  - [TypeScript / JavaScript](#typescript--javascript)
  - [React](#react)
  - [Go](#go)
- [セクション3: その他の言語](#セクション3-その他の言語簡易リファレンス)

---

## セクション1: 汎用テストファイル検出ガイド

どの言語にも共通する検出戦略を示す。未知の言語でもこの手順で検出可能である。

### 1-1. プロジェクト設定ファイルからの言語推定

| 設定ファイル | 言語/エコシステム |
|---|---|
| `package.json` | JavaScript / TypeScript |
| `tsconfig.json` | TypeScript |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `pyproject.toml`, `setup.py`, `setup.cfg` | Python |
| `pom.xml`, `build.gradle`, `build.gradle.kts` | Java / Kotlin |
| `*.csproj`, `*.sln` | C# / .NET |
| `Gemfile` | Ruby |
| `mix.exs` | Elixir |
| `deno.json`, `deno.jsonc` | Deno (TypeScript) |
| `composer.json` | PHP |
| `Package.swift` | Swift |

### 1-2. テストファイルの一般的な命名規則

以下のパターンはほぼ全ての言語で共通する:

- ファイル名に `test` または `spec` を含む
- 以下のディレクトリ配下に配置される:
  - `tests/`, `test/`, `__tests__/`, `spec/`, `specs/`
  - `src/test/` (Java/Kotlin)
  - `*_test.go` ファイルがパッケージと同じディレクトリに配置される (Go)

### 1-3. テストフレームワーク設定ファイルの検出

| 設定ファイル | フレームワーク |
|---|---|
| `jest.config.*`, `jest.setup.*` | Jest |
| `vitest.config.*` | Vitest |
| `playwright.config.*` | Playwright |
| `cypress.config.*`, `cypress/` | Cypress |
| `pytest.ini`, `conftest.py`, `pyproject.toml[tool.pytest]` | pytest |
| `.rspec` | RSpec |
| `phpunit.xml` | PHPUnit |
| `karma.conf.*` | Karma |

### 1-4. 未知の言語のフォールバック戦略

1. 上記の設定ファイルで言語を推定する
2. `test/`, `tests/`, `spec/`, `__tests__/` ディレクトリを探索する
3. ファイル名に `test`, `spec` を含むファイルを検出する
4. 検出したファイルの内容からテスト構造（アサーション関数、テストブロック等）を推測する
5. t-wadaの9原則は言語非依存であるため、構造を把握できればチェック可能である

---

## セクション2: 主要言語の具体パターン

### Python

**Glob**: `tests/**/*.py`, `**/test_*.py`, `**/*_test.py`, `**/*_spec.py`
**フレームワーク**: pytest (推奨), unittest
**注意点**:
- `conftest.py` でフィクスチャを共有する
- `@pytest.mark.parametrize` でテストケースを分離する
- `pytest.raises` で例外メッセージまで検証する

---

### TypeScript / JavaScript

**Glob**: `**/*.test.ts`, `**/*.spec.ts`, `**/*.test.tsx`, `**/*.spec.tsx`, `**/*.test.js`, `**/*.spec.js`, `**/*.test.jsx`, `**/*.spec.jsx`, `**/__tests__/**/*.[jt]s?(x)`
**フレームワーク**: Vitest (推奨), Jest
**注意点**:
- `describe.each` / `it.each` でパラメータ化テストを行う
- snapshotテストの過剰使用は避ける（変更への脆さの原因）

---

### React

**Glob**: TypeScript/JavaScriptと同じ（`.tsx`, `.jsx` ファイル）
**フレームワーク**: React Testing Library + Vitest/Jest

**クエリ優先順位** (Testing Library公式ガイドライン):

| 優先度 | クエリ | 用途 |
|---|---|---|
| 1 (最優先) | `getByRole` | アクセシビリティロールで取得 |
| 2 | `getByLabelText` | フォーム要素 |
| 3 | `getByPlaceholderText` | プレースホルダーで取得 |
| 4 | `getByText` | テキストコンテンツで取得 |
| 5 | `getByDisplayValue` | フォームの現在値 |
| 6 | `getByAltText` | 画像のalt属性 |
| 7 | `getByTitle` | title属性 |
| 8 (最終手段) | `getByTestId` | data-testid属性 |

**アンチパターン**:
- `fireEvent` の使用 - `userEvent` を優先する（ユーザー操作のシミュレーション精度が高い）
- `getByTestId` の過剰使用 - アクセシビリティクエリを優先する
- 実装詳細への依存 - コンポーネントの内部state/propsを直接テストしない
- `container.querySelector` の使用 - Testing Libraryのクエリを使う
- `act()` の手動呼び出し - Testing Libraryが内部で処理する

**偽陽性コード例（実装詳細依存）**:

```typescript
// 悪い: getByTestIdの過剰使用
it("shows title", () => {
  render(<Header title="Hello" />);
  expect(screen.getByTestId("header-title")).toHaveTextContent("Hello");
  // getByRoleやgetByTextを使うべき
});
```

---

### Go

**Glob**: `**/*_test.go`
**フレームワーク**: `testing` (標準), testify
**注意点**:
- テーブルドリブンテストがGoのイディオムである
- `t.Helper()` でヘルパー関数のスタックトレースを改善する
- `t.Parallel()` 使用時はループ変数のキャプチャに注意する（Go 1.22以降は不要）
- ブラックボックステストには `_test` パッケージサフィックスを使用する

**偽陽性コード例（t.Parallel()変数キャプチャ漏れ）**:

```go
// 悪い: t.Parallel()使用時の変数キャプチャ漏れ（Go 1.21以前）
for _, tt := range tests {
    t.Run(tt.name, func(t *testing.T) {
        t.Parallel()
        // ttがループ変数を参照 - 最後の値でのみテストされる
        got := Add(tt.a, tt.b)
        assert.Equal(t, tt.want, got)
    })
}
```

---

## セクション3: その他の言語（簡易リファレンス）

| 言語 | テストファイル | ディレクトリ | フレームワーク | Globパターン |
|---|---|---|---|---|
| Rust | `#[cfg(test)]` モジュール, `tests/*.rs` | `tests/`, ソース内 | 標準 (`assert!`, `assert_eq!`) | `tests/**/*.rs`, `src/**/*.rs` |
| Java/Kotlin | `*Test.java`, `*Spec.kt` | `src/test/java/`, `src/test/kotlin/` | JUnit 5, Kotest | `src/test/**/*.java`, `src/test/**/*.kt` |
| C#/.NET | `*Tests.cs`, `*Test.cs` | `*.Tests.csproj` | xUnit, NUnit, MSTest | `**/*Tests.cs`, `**/*Test.cs` |
| Ruby | `*_spec.rb`, `*_test.rb` | `spec/`, `test/` | RSpec, Minitest | `spec/**/*_spec.rb`, `test/**/*_test.rb` |
| PHP | `*Test.php` | `tests/` | PHPUnit, Pest | `tests/**/*Test.php` |
| Elixir | `*_test.exs` | `test/` | ExUnit | `test/**/*_test.exs` |
