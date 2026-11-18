// ja-style-guard: off
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// PreToolUse hook. ツールに渡す日本語の文体と表記を検査する
// description の言語と表記の機械的な違反は exit 2 で止め stderr の理由が Claude に返る
// 語彙と言い回しは文脈で可否が変わるため止めず additionalContext で警告だけを返す
// 対象は description を持つ全ツールと Write の content Edit の new_string である
// MessageDisplay hook として呼ばれた場合は 英語の文の行を画面の表示から除き 除いた行数を記録する
// 記録があれば 次のツール呼び出しを差し止める
// Stop hook として呼ばれた場合は 記録か最後のテキスト応答に英語の文があれば終了を差し止める

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
// 年月日時分秒に接する数字は日付や時刻の表記とみなして見逃す
const JA_ASCII_RE =
  /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}](?<![年月日時分秒])[0-9A-Za-z]|(?<!\\)(?:[0-9](?![年月日時分秒])|[A-Za-z])[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/gu

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

// 箇条書き コメント見出し 番号付きリスト docstring のラベルと説明を区切る em ダッシュを取り除く
// 索引や項目の一覧 ファイル冒頭の見出しで広く使われている書式で 地の文のダッシュとは役割が違う
// 表のセルだけのダッシュは空欄の印なので同様に外す
// 2 倍ダッシュと それ以外の行のダッシュは残して検知させる
const LABEL_LINE_RE = /^\s*(?:(?:[-*]|\/\/|#+|\d+\.) |"""|''')/

function stripListLabelDash(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const cell = line.replace(/\|\s*—\s*(?=\|)/gu, '|')
      return LABEL_LINE_RE.test(cell) ? cell.replace(/(?<!—) — (?!—)/gu, ' ') : cell
    })
    .join('\n')
}

// 括弧と角括弧の内側の半角カンマを空白にする (タプルや配列や引数の列挙は日本語文の読点ではない)
function stripParenCommas(text: string): string {
  return text.replace(/[(（[][^()（）[\]]*[)）\]]/gu, (part) => part.replace(/,/gu, ' '))
}

// インラインコードを取り除く (識別子や書式例を地の文として検査しないため)
function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, '')
}

// def の直後の定義名を取り除く (日本語を含む関数名の内部は境界を分けられないため)
function stripDefinitionNames(text: string): string {
  return text.replace(/\bdef\s+[^\s(]+/gu, 'def')
}

// 日本語を含む行だけを検査の対象にする (コードや英文の行で誤検知しないため)
function japaneseLines(text: string): string[] {
  return stripDefinitionNames(stripInlineCode(stripCodeBlocks(text)))
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
      /落ち(る|た|て|ます)|(?<![見欠])落と(す|し|そう)(?!穴)|(?<!前)倒(す|れる|し)|潰(す|れる|し)|コケ(る|た)|クラッシュ|殺(す|し)|死ぬ|飛(ぶ|んで)|吹っ飛|弾(く|か|い)|叩(く|い)|(?<!\p{sc=Han})回(す|して|した)|撃(つ|って)|(?<!合)流(す|して|れる)|詰まる|素通し|張り付|(?<![破崩損])壊(す|れる|れた)|崩(れる|れた)|効く|載(る|って)|食い違/gu,
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
    pattern: /真因|配線/gu,
    hint: '比喩や直訳の造語を使わない (根本原因 接続 のような標準的な語に直す)',
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

// 応答の言語の検査 アシスタントがターミナルへ出したテキストから英語の文の行を探す

const JA_CHAR_RE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/gu
const HIRAGANA_RE = /\p{sc=Hiragana}/gu
const LATIN_RE = /[A-Za-z]/g
// 英単語 ドット ハイフン スラッシュ 数字に接する英字の並びは識別子やファイル名の一部なので数えない
const WORD_RE = /(?<![\w.\-/\\])[A-Za-z]+(?:'[A-Za-z]+)?(?![\w\-/\\]|\.\w)/g
// URL とファイルパスは英字の塊なので数えない
const URL_RE = /https?:\/\/\S+/g
const PATH_RE = /(?:[A-Za-z]:)?[\\/][\w.\\/-]+/g

// 英語を引用する書式 (Markdown のリンク 「」『』と二重引用符の内側) は英語の文として数えない
const QUOTED_RE = /\[[^\]\n]*\]\([^)\n]*\)|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|“[^”\n]*”/gu
// 文末の句読点 強調 括弧 引用符 インラインコードの閉じが後ろに続いてもよい
const SENTENCE_END_RE = /[.!?:][*_)\]」』"'”`]*\s*$/u
// 2 語の行はラベル (名前:) と区別するため コロンを文末とみなさない
const PERIOD_END_RE = /[.!?][*_)\]」』"'”`]*\s*$/u
// 日本語の文字の並び (長音記号と踊り字を含む)
const JA_RUN_RE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}ー々]+/gu
// 行末の日本語の文字の並び
const JA_TAIL_RE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}ー々]+$/u
// 英語の語句をつなぐ助詞
const PARTICLES = new Set([
  'と',
  'の',
  'を',
  'に',
  'で',
  'は',
  'が',
  'も',
  'や',
  'へ',
  'から',
  'まで',
  'より',
])
// 括弧で囲んだ補足
const PAREN_RE = /（[^（）\n]*）|\([^()\n]*\)/gu

// 括弧の中が日本語の注記かを判定する
// 全角の括弧と ひらがなを含むか日本語の文字が英字の半数以上ある半角の括弧が該当する
function isJapaneseNote(paren: string): boolean {
  if (paren.startsWith('（') || /\p{sc=Hiragana}/u.test(paren)) return true
  const ja = paren.match(JA_CHAR_RE)?.length ?? 0
  return ja > 0 && ja * 2 >= (paren.match(LATIN_RE)?.length ?? 0)
}

// 英語の語句を日本語の文法でつないだ行 (英語の名前を含む日本語の文) かを判定する
// 助詞だけの並びで英語の語句をつなぐ行と 英語の句読点で終わらずに ひらがなを含む日本語の語句で終わる行が該当する
function hasJapaneseGrammar(line: string, body: string): boolean {
  if ((body.match(JA_RUN_RE) ?? []).some((run) => PARTICLES.has(run))) return true
  if (PERIOD_END_RE.test(line)) return false
  const tail = JA_TAIL_RE.exec(body.replace(/[\s\p{P}\p{S}]+$/u, ''))
  return tail !== null && /\p{sc=Hiragana}/u.test(tail[0])
}

// 英語の文に現れる機能語 識別子や固有名だけの行と英語の文を見分けるために数える
// a は識別子の一部 (k1-generator-a) や記号 (プラン A) と区別できないため含めない
const STOPWORDS = new Set(
  `the an is are was were be been being am to of and or but in on at for with from by as into
  about this that these those it its i me my we our us you your they them their will would can
  could should shall might must do does did have has had not now then so if than there here what
  which who when where why how let just also all any some only very because while still already
  each other such after before i'm i'll i've i'd let's it's that's there's here's what's don't
  doesn't didn't isn't aren't wasn't can't won't we'll we're we've you're you've they're haven't
  hasn't`.split(/\s+/),
)

// 1 行が英語の文かを判定する (引用の行と 日本語の文字が英字の半数以上ある行は除く)
// 英語の語句を日本語の文法でつないだ行も除く
// ひらがなを 3 字以上含む行は助詞と述語を持つ日本語の文とみなし 英語の部分が大半を占める場合に限る
// それ以外は 機能語が 2 語以上 または句読点で終わる 2 語以上の行を英語の文とみなす
function isEnglishLine(line: string): boolean {
  if (/^\s*>/.test(line)) return false
  // 括弧の中の日本語の注記は 英文に挟んだ補足とも 日本語の文の説明とも読めるため判定から除く
  const body = stripInlineCode(line)
    .replace(QUOTED_RE, ' ')
    .replace(PAREN_RE, (paren) => (isJapaneseNote(paren) ? ' ' : paren))
    .replace(URL_RE, ' ')
    .replace(PATH_RE, ' ')
  const latin = body.match(LATIN_RE)?.length ?? 0
  const ja = body.match(JA_CHAR_RE)?.length ?? 0
  if (ja * 2 >= latin) return false
  if (hasJapaneseGrammar(line, body)) return false
  const words = body.match(WORD_RE) ?? []
  const stops = words.filter((word) => STOPWORDS.has(word.toLowerCase())).length
  const hiragana = body.match(HIRAGANA_RE)?.length ?? 0
  if (hiragana >= 3) return stops >= 3 && latin >= hiragana * 8
  // 文末は 除去で末尾が欠けないよう元の行で判定する
  return (
    stops >= 2 ||
    (words.length >= 3 && SENTENCE_END_RE.test(line)) ||
    (words.length === 2 && PERIOD_END_RE.test(line))
  )
}

// 開いているコードブロックのフェンスの文字と長さ (コードブロックの外なら null)
export type Fence = { char: string; length: number } | null

// 開きフェンスは箇条書きの記号の後に置いたものも認識する
const OPEN_FENCE_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/
// 閉じフェンスは記号を持たず 後ろに何も書かれていない行に限る
const CLOSE_FENCE_RE = /^\s*(`{3,}|~{3,})\s*$/

// 行がフェンスなら 行の後のフェンスの状態を返す (フェンスでなければ undefined)
// 閉じるのは開いたときと同じ文字で同じ長さ以上のフェンスに限る
function fenceAfter(line: string, open: Fence): Fence | undefined {
  if (open === null) {
    const match = OPEN_FENCE_RE.exec(line)
    if (!match) return undefined
    const [, marker = '', rest = ''] = match
    const char = marker.charAt(0)
    // バッククォートのフェンスの後ろにバッククォートがあればインラインコードである
    if (char === '`' && rest.includes('`')) return undefined
    return { char, length: marker.length }
  }
  const [, marker = ''] = CLOSE_FENCE_RE.exec(line) ?? []
  return marker.charAt(0) === open.char && marker.length >= open.length ? null : undefined
}

// 行ごとに英語の文かを判定する コードブロックの内側とフェンスの行は判定しない
// open は先頭の行の時点のフェンスの状態を表し 戻り値の open は末尾の状態を表す
function classifyLines(text: string, open: Fence): { english: boolean[]; open: Fence } {
  let fence = open
  const english = text.split('\n').map((line) => {
    const next = fenceAfter(line, fence)
    if (next !== undefined) {
      fence = next
      return false
    }
    return fence === null && isEnglishLine(line)
  })
  return { english, open: fence }
}

// 英語の文の行を返す
export function englishLines(text: string): string[] {
  const { english } = classifyLines(text, null)
  return text.split('\n').filter((_, i) => english[i])
}

// 表示する差分から英語の文の行を除き 除いた行数とともに返す (除く行が無ければ null)
export function hideEnglishLines(
  delta: string,
  open: Fence,
): { content: string; hidden: number } | null {
  const { english } = classifyLines(delta, open)
  const hidden = english.filter(Boolean).length
  if (hidden === 0) return null
  const content = delta
    .split('\n')
    .filter((_, i) => !english[i])
    .join('\n')
  return { content, hidden }
}

type Entry = Record<string, unknown>

// MessageDisplay hook の差分と 隠した行数の記録を置くディレクトリ
// 応答の本文を含むため 共有の一時ディレクトリを避ける
const STATE_DIR = join(homedir(), '.cache', 'ja-style-guard')
// この時間より古い差分と記録は消す
const STALE_MS = 60 * 60 * 1000
// message_id session_id prompt_id をファイル名に使うため 区切り文字を含む値は扱わない
const ID_RE = /^[\w-]+$/

// 有効な session_id を返す (ファイル名に使えなければ null)
function sessionOf(payload: Entry): string | null {
  const { session_id: session } = payload
  return typeof session === 'string' && ID_RE.test(session) ? session : null
}

// 記録のキー (session_id と prompt_id) を返す
// prompt_id は人の入力ごとに変わるため 中断したターンの記録を次の入力へ持ち越さない
// 最初の入力の前は prompt_id が無いため none とする
function recordKey(payload: Entry): string | null {
  const session = sessionOf(payload)
  const { prompt_id: prompt = 'none' } = payload
  if (session === null || typeof prompt !== 'string' || !ID_RE.test(prompt)) return null
  return `${session}.${prompt}`
}

// 隠した英語の行数の記録ファイル名の接頭辞 (記録は表示処理ごとに 1 ファイルとする)
function hiddenPrefix(key: string): string {
  return `${key}.english.`
}

// 隠した英語の行数を記録する
// 消費と競合しないよう 書き終えてから名前を付け替えて公開する
function recordHidden(dir: string, key: string, name: string, hidden: number) {
  const path = join(dir, `${hiddenPrefix(key)}${name}`)
  writeFileSync(`${path}.tmp`, String(hidden), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

// 公開済みの記録の行数の合計を返し 記録を消す (記録が無ければ 0)
// transcript には PreToolUse の時点で直前のテキストがまだ書かれていないため この記録で判定する
export function consumeHidden(dir: string, payload: Entry): number {
  const key = recordKey(payload)
  if (key === null) return 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let sum = 0
  for (const name of names) {
    if (!name.startsWith(hiddenPrefix(key)) || /\.(tmp|taken-\d+)$/.test(name)) continue
    // 並行する消費と同じ記録を二重に数えないよう 名前を付け替えて取得してから読む
    const taken = join(dir, `${name}.taken-${process.pid}`)
    try {
      renameSync(join(dir, name), taken)
    } catch {
      continue
    }
    try {
      sum += Number.parseInt(readFileSync(taken, 'utf8'), 10) || 0
    } finally {
      rmSync(taken, { force: true })
    }
  }
  return sum
}

// 英語の文の行があれば 書き直しを求める理由を返す
// 英語の行は MessageDisplay hook で画面から隠すため 理由にも本文を引用しない
function englishReason(count: number, timing: string): string | null {
  if (count === 0) return null
  return `テキスト応答の ${count} 行が英語の文で 画面には表示していない ${timing}その行の内容を日本語の敬体で書く 書き直しの前置き 謝罪 英語だったことへの言及 書き直しを示す見出しは書かず 内容だけを書く 英語を引用する場合は「」かインラインコードで囲む`
}

// MessageDisplay と PreToolUse はほぼ同時に起動されるため 起動からこの時間までは記録を待つ
const GRACE_MS = 120
// 処理中の MessageDisplay の hook を待つ上限
const PENDING_WAIT_MS = 500
// これより古い処理中の印は 異常終了した hook の残りとみなして待たない
const PENDING_STALE_MS = 2000

// MessageDisplay の hook が処理中であることを示す印のファイル名の接頭辞
function pendingPrefix(sessionId: string): string {
  return `${sessionId}.pending-`
}

// 処理中の MessageDisplay の hook があるかを返す
function hasPending(dir: string, sessionId: string): boolean {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  return names.some((name) => {
    if (!name.startsWith(pendingPrefix(sessionId))) return false
    try {
      return Date.now() - statSync(join(dir, name)).mtimeMs < PENDING_STALE_MS
    } catch {
      return false
    }
  })
}

// 並行して動く MessageDisplay の hook が記録を書き終えるまで待つ
function waitForDisplay(dir: string, payload: Entry) {
  const session = sessionOf(payload)
  if (session === null) return
  Bun.sleepSync(Math.max(0, GRACE_MS - performance.now()))
  const deadline = Date.now() + PENDING_WAIT_MS
  while (Date.now() < deadline && hasPending(dir, session)) Bun.sleepSync(10)
}

// PreToolUse の payload を検査して 直前に英語の文の行を隠していれば差し止める理由を返す
// サブエージェント内の呼び出し (agent_id あり) は 本体の記録を消費しないよう検査しない
export function inspectReply(payload: Entry, dir = STATE_DIR): string | null {
  if (payload.agent_id !== undefined) return null
  waitForDisplay(dir, payload)
  return englishReason(consumeHidden(dir, payload), 'ツールを呼び直す前に ')
}

// 1 回の入力で Stop が書き直しを求める回数の上限 (判定の誤りで終了できなくなるのを防ぐ)
const MAX_STOP_BLOCKS = 2

// Stop hook の payload を検査して 応答の終了を差し止める理由を返す (許可なら null)
// 書き直しの後 (stop_hook_active) も検査し 差し止めは 1 回の入力で MAX_STOP_BLOCKS 回までに限る
export function inspectStop(payload: Entry, dir = STATE_DIR): string | null {
  waitForDisplay(dir, payload)
  const hidden = consumeHidden(dir, payload)
  const last =
    typeof payload.last_assistant_message === 'string'
      ? englishLines(payload.last_assistant_message).length
      : 0
  const reason = englishReason(Math.max(hidden, last), '')
  const key = recordKey(payload)
  if (reason === null || key === null) {
    return payload.stop_hook_active === true ? null : reason
  }
  const path = join(dir, `${key}.stops`)
  let count = 0
  try {
    count = Number.parseInt(readFileSync(path, 'utf8'), 10) || 0
  } catch {
    // 記録が無ければ最初の差し止めとして扱う
  }
  if (count >= MAX_STOP_BLOCKS) return null
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, String(count + 1), { mode: 0o600 })
  return reason
}

// 同じメッセージの前の差分を index 順に返す (待っても揃わなければ null)
// 前の差分の hook は並行して動くため ファイルが書かれるまで waitMs だけ待つ
function readPreviousDeltas(dir: string, index: number, waitMs: number): string[] | null {
  const deadline = Date.now() + waitMs
  const deltas: string[] = []
  for (let i = 0; i < index; i++) {
    for (;;) {
      try {
        deltas.push(readFileSync(join(dir, String(i)), 'utf8'))
        break
      } catch {
        if (Date.now() >= deadline) return null
        Bun.sleepSync(10)
      }
    }
  }
  return deltas
}

// 古い差分と記録を消す
function removeStale(dir: string) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) {
        rmSync(path, { recursive: true, force: true })
      }
    } catch {
      // 並行する hook が先に消した場合は何もしない
    }
  }
}

// MessageDisplay の payload を検査して 英語の文の行を除いた表示内容を返す (元のまま表示するなら null)
// 差分はメッセージの途中から始まるため 前の差分からコードブロックの開閉を引き継ぐ
// 除いた行数はセッションごとに記録し 次の PreToolUse か Stop で書き直しを求める
export function inspectDisplay(payload: Entry, dir = STATE_DIR, waitMs = 1000): string | null {
  const { message_id: id, index, delta } = payload
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  if (typeof index !== 'number' || typeof delta !== 'string') return null
  const session = sessionOf(payload)
  const key = recordKey(payload)
  const messageDir = join(dir, id)
  mkdirSync(messageDir, { recursive: true, mode: 0o700 })
  // PreToolUse と Stop は この印が消えるまで記録の消費を待つ
  const pending = session === null ? null : join(dir, `${pendingPrefix(session)}${id}-${index}`)
  if (pending !== null) writeFileSync(pending, '', { mode: 0o600 })
  try {
    // 並行する hook が書きかけのファイルを読まないよう 書いてから名前を付け替える
    const path = join(messageDir, String(index))
    writeFileSync(`${path}.tmp`, delta, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    if (payload.final === true) removeStale(dir)
    const previous = readPreviousDeltas(messageDir, index, waitMs)
    if (previous === null) return null
    const open = previous.reduce<Fence>((state, text) => classifyLines(text, state).open, null)
    const result = hideEnglishLines(delta, open)
    if (result === null) return null
    if (key !== null) recordHidden(dir, key, `${id}-${index}`, result.hidden)
    return result.content
  } finally {
    if (pending !== null) rmSync(pending, { force: true })
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

// Stop hook で応答の終了を差し止める JSON を組み立てる (reason は Claude へ返り 書き直しを促す)
export function stopPayload(reason: string): string {
  return JSON.stringify({ decision: 'block', reason: blockMessage(reason) })
}

// MessageDisplay hook で画面に出す内容を差し替える JSON を組み立てる (保存される応答は変わらない)
export function displayPayload(content: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: content },
  })
}

// 直接実行時は stdin の hook payload を検査する
// payload が読めない場合は許可する (hook 自体の不具合でツール実行を止めないため)
if (import.meta.main) {
  try {
    const payload = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Record<
      string,
      unknown
    >
    if (payload.hook_event_name === 'Stop') {
      const reason = inspectStop(payload)
      if (reason !== null) process.stdout.write(stopPayload(reason))
      process.exit(0)
    }
    if (payload.hook_event_name === 'MessageDisplay') {
      const content = inspectDisplay(payload)
      if (content !== null) process.stdout.write(displayPayload(content))
      process.exit(0)
    }
    const result = inspect(payload.tool_name, payload.tool_input)
    const reasons = [inspectReply(payload), result.block].filter((reason) => reason !== null)
    if (reasons.length > 0) {
      process.stderr.write(blockMessage(reasons.join('\n')))
      process.exit(2)
    }
    if (result.warn.length > 0) {
      process.stdout.write(warningPayload(result.warn))
    }
  } catch {
    // 解析失敗は許可として扱う
  }
}
