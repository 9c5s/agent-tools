// ja-style-guard: off
import { readFileSync } from 'node:fs'

// PreToolUse hook. ツールに渡す日本語の文体と表記を検査する
// description の言語と表記の機械的な違反は exit 2 で止め stderr の理由が Claude に返る
// 語彙と言い回しは文脈で可否が変わるため止めず additionalContext で警告だけを返す
// 対象は description を持つ全ツールと Write の content Edit の new_string である

// ひらがな カタカナ 漢字のいずれかを含めば日本語とみなす
// 技術用語やコード識別子だけの英文説明を弾くための最小の判定である
// 中黒や長音記号は script が Common で文字自体は日本語でないため字種の指定で除外する
const JA_RE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/u

// description を必須とするツール (コマンド通知の説明表示に使うため欠落も拒否する)
const REQUIRE_DESC = new Set(['Bash', 'PowerShell'])

// 拒否理由を返す (許可なら null)
// description があれば日本語判定し 無ければ REQUIRE_DESC のツールのみ欠落として拒否する
export function checkDescription(toolName: unknown, input: unknown): string | null {
  const desc =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>).description
      : undefined
  if (typeof desc === 'string' && desc.trim()) {
    if (JA_RE.test(desc)) return null
    return `description は日本語で書き直すこと (技術用語とコード識別子は原文のまま可): ${desc}`
  }
  if (typeof toolName === 'string' && REQUIRE_DESC.has(toolName)) {
    return 'description に日本語のコマンド説明を付けること'
  }
  return null
}

// 日本語文の句読点に半角の , . が使われていないかを探す
// 直後が英数字なら拡張子やバージョン番号 ドットの連続なら省略記号とみなして見逃す
const HALF_PUNCT_RE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}][,.](?![0-9A-Za-z.])/gu

// 日本語と英数字が半角スペースなしで隣接している箇所を探す
// 直前が \ ならエスケープシーケンス (\n など) の一部とみなして見逃す
const JA_ASCII_RE =
  /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}][0-9A-Za-z]|(?<!\\)[0-9A-Za-z][\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/gu

// 日本語の地の文で使わないダッシュ類 (em ダッシュと horizontal bar)
const DASH_RE = /[—―]/gu

// Markdown のコードブロックを取り除く (サンプルやログの引用を検査しないため)
function stripCodeBlocks(text: string): string {
  let inside = false
  return text
    .split('\n')
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        inside = !inside
        return false
      }
      return !inside
    })
    .join('\n')
}

// 箇条書きとコメント見出しのラベルと説明を区切る em ダッシュを取り除く
// 索引や項目の一覧 ファイル冒頭の見出しで広く使われている書式で 地の文のダッシュとは役割が違う
// 2 倍ダッシュと それ以外の行のダッシュは残して検知させる
const LABEL_LINE_RE = /^\s*(?:[-*]|\/\/|#+) /

function stripListLabelDash(text: string): string {
  return text
    .split('\n')
    .map((line) => (LABEL_LINE_RE.test(line) ? line.replace(/(?<!—) — (?!—)/gu, ' ') : line))
    .join('\n')
}

// 括弧の内側の半角カンマを空白にする (タプルや引数の列挙は日本語文の読点ではない)
function stripParenCommas(text: string): string {
  return text.replace(/[(（][^()（）]*[)）]/gu, (part) => part.replace(/,/gu, ' '))
}

// インラインコードを取り除く (識別子や書式例を地の文として検査しないため)
function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, '')
}

// 日本語を含む行だけを検査の対象にする (コードや英文の行で誤検知しないため)
function japaneseLines(text: string): string[] {
  return stripInlineCode(stripCodeBlocks(text))
    .split('\n')
    .filter((line) => JA_RE.test(line))
}

// 表記の機械的な違反を集める (字面だけで判定できるものに限る)
export function checkNotation(text: string): string[] {
  const found: string[] = []
  const lines = japaneseLines(text)
  const target = lines.join('\n')
  const halfPunct = stripParenCommas(target).match(HALF_PUNCT_RE)
  if (halfPunct) {
    found.push(`日本語文の句読点は 、 。 を使う (半角の , . は使わない): ${halfPunct.join(' ')}`)
  }
  const dash = stripListLabelDash(target).match(DASH_RE)
  if (dash) {
    found.push('ダッシュ (— ―) を日本語の地の文で使わない (括弧か句点で書き分ける)')
  }
  // 中黒が近い間隔で 2 つ以上並ぶ行だけを並列とみなす
  // 固有名詞の内部は 1 つで足り 別々の複合語にある中黒は間隔が開く
  if (lines.some((line) => /・[^・\s]{1,12}・/u.test(line))) {
    found.push('中黒 (・) を日本語の並列で使わない (読点か「と」に直す)')
  }
  return found
}

// 使用を避ける語彙と言い回し 同じ語でも文脈で可否が変わるため警告にとどめる
// 除外の先読みは 別語に当たる代表例だけを外す最小限にする
const VOCABULARY_RULES: { pattern: RegExp; hint: string }[] = [
  {
    pattern:
      /落ち(る|た|て|ます)|(?<![見欠])落と(す|し|そう)(?!穴)|(?<!前)倒(す|れる|し)|潰(す|れる|し)|コケ(る|た)|クラッシュ|殺(す|し)|死ぬ|飛(ぶ|んで)|吹っ飛|弾(く|か|い)|叩(く|い)|(?<![巡周])回(す|して|した)|撃(つ|って)|(?<!合)流(す|して|れる)|詰まる|素通し|張り付|(?<![破崩損])壊(す|れる|れた)|崩(れる|れた)|効く|載(る|って)|食い違/gu,
    hint: '擬人化と口語の動詞を使わない (除外される 異常終了する 無効化する のような正式な表現に直す)',
  },
  {
    pattern:
      /重要なのは|正面から|深掘り|掘り下げ|言語化|多角的|包括的|総合的|不可欠|核心的|鍵となる|根本的|の観点から|という側面から|に他ならない|非常に|(?<!見)極めて|大いに|本章では|見ていく|まとめると|要するに|言えるだろう/gu,
    hint: 'LLM っぽい空虚な言い回しを使わない (主張をそのまま書く)',
  },
  {
    pattern: /[→⇒]|＝/gu,
    hint: '矢印と ＝ で因果や手順を省略しない (読点 「の順」 番号付きリストに開く。コードの遷移列はコードブロックに入れる)',
  },
  {
    pattern: /いたします|させていただ|でございます|お詫び申し上げ/gu,
    hint: '過剰な丁寧語を使わない (します です に直す)',
  },
  {
    pattern: JA_ASCII_RE,
    hint: '日本語と英数字の境界には半角スペースを入れる',
  },
]

// 語彙と言い回しの指摘を集める (ブロックはせず警告として返す)
export function checkVocabulary(text: string): string[] {
  const target = japaneseLines(text).join('\n')
  if (!target) return []
  const found: string[] = []
  for (const rule of VOCABULARY_RULES) {
    const matched = target.match(rule.pattern)
    if (matched) {
      found.push(`${rule.hint}: ${[...new Set(matched)].join(' ')}`)
    }
  }
  return found
}

// 検査を止めるマーカー 使用を避ける語彙そのものを列挙する文書で使う
const OFF_MARKER = 'ja-style-guard: off'

// 検査の結果 block があればツールを止め warn は指摘としてだけ返す
export type Inspection = { block: string | null; warn: string[] }

// tool_input のうち日本語の文章が入りうる場所を集める
// written は文書としてそのまま残るテキストで 表記の違反はブロックの対象にする
// command は heredoc で文書を書く経路である一方 検索パターンやデータも混ざるため警告にとどめる
// Edit の old_string は既存のテキストなので対象にしない
function textsToInspect(
  toolName: unknown,
  input: Record<string, unknown>,
): { written: string[]; command: string[] } {
  const written: string[] = []
  if (typeof input.description === 'string') written.push(input.description)
  if (toolName === 'Write' && typeof input.content === 'string') written.push(input.content)
  if (toolName === 'Edit' && typeof input.new_string === 'string') written.push(input.new_string)
  return { written, command: typeof input.command === 'string' ? [input.command] : [] }
}

// 検査から外すかを判定する
// 書き込む内容のほか 編集先のファイルの先頭にマーカーがある場合も対象にする
function isExempt(filePath: unknown, texts: string[]): boolean {
  if (texts.some((text) => text.includes(OFF_MARKER))) return true
  if (typeof filePath !== 'string') return false
  try {
    return readFileSync(filePath, 'utf8').slice(0, 500).includes(OFF_MARKER)
  } catch {
    // 読めないファイルは検査の対象として扱う
    return false
  }
}

// ツール呼び出しを検査して ブロックする理由と警告に分けて返す
export function inspect(toolName: unknown, input: unknown): Inspection {
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const { written, command } = textsToInspect(toolName, record)
  const texts = [...written, ...command]
  if (isExempt(record.file_path, texts)) return { block: null, warn: [] }

  const reason = checkDescription(toolName, input)
  const notation = written.flatMap((text) => checkNotation(text))
  return {
    block: reason ?? (notation.length > 0 ? notation.join('\n') : null),
    warn: [
      ...texts.flatMap((text) => checkVocabulary(text)),
      ...command.flatMap((text) => checkNotation(text)),
    ],
  }
}

// 出力の先頭に付ける識別子 あとから transcript を検索して集計できるようにする
const AUDIT_BLOCK = '[ja-style-guard:block]'
const AUDIT_WARN = '[ja-style-guard:warn]'

// 警告を Claude へ届ける JSON を組み立てる
// permissionDecision は付けず 通常の許可の流れに任せる (止めたい場合は exit 2 を使う)
export function warningPayload(warn: string[]): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: [`${AUDIT_WARN} 日本語の表現に指摘がある`, ...warn].join('\n'),
    },
  })
}

// ブロックの理由を stderr へ出す文言を組み立てる
export function blockMessage(reason: string): string {
  return `${AUDIT_BLOCK} ${reason}`
}

// 直接実行時は stdin の hook payload を検査する
// payload が読めない場合は許可する (hook 自体の不具合でツール実行を止めないため)
if (import.meta.main) {
  try {
    const payload = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Record<
      string,
      unknown
    >
    const result = inspect(payload.tool_name, payload.tool_input)
    if (result.block !== null) {
      process.stderr.write(blockMessage(result.block))
      process.exit(2)
    }
    if (result.warn.length > 0) {
      process.stdout.write(warningPayload(result.warn))
    }
  } catch {
    // 解析失敗は許可として扱う
  }
}
