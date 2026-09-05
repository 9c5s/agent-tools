// Claude Code の statusline 用スクリプト
// statusline フックから stdin で受け取った JSON を、プロジェクト情報やレートリミットの行に整形して出力する
// 入力 JSON の構造: https://code.claude.com/docs/en/statusline

// stdin の JSON はこの型で受け取り、各セグメントが必要なフィールドの型を検査する
export type Input = Record<string, unknown>

export type Icons = {
  folder: string
  branch: string
  model: string
  chart: string
  pencil: string
  clock: string
  calendar: string
  reset: string
  money: string
}

export const ICONS_EMOJI: Icons = {
  folder: '📁',
  branch: '🔀',
  model: '🤖',
  chart: '📊',
  pencil: '✏️',
  clock: '⏰',
  calendar: '📅',
  reset: '🔁',
  money: '💰',
}

export const ICONS_NERD: Icons = {
  folder: '\uf07b', // nf-fa-folder
  branch: '\ue725', // nf-dev-git_branch
  model: '\u{f167a}', // nf-md-robot_outline
  chart: '\uf201', // nf-fa-line_chart
  pencil: '\u{f03eb}', // nf-md-pencil
  clock: '\uf017', // nf-fa-clock_o
  calendar: '\ueab0', // nf-cod-calendar
  reset: '\uf0e2', // nf-fa-undo
  money: '\uefca', // nf-fa-money_check_dollar
}

// ANSI の色番号
export const Color = { red: 31, green: 32, yellow: 33, blue: 34 } as const
export type Color = (typeof Color)[keyof typeof Color]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 数値と数値文字列だけを number にする (空文字や真偽値は null)
export function safeFloat(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isNaN(n) ? null : n
  }
  return null
}

// 整数にできる値だけを number にする (小数は切り捨て、小数の文字列は null)
export function safeInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return Number.parseInt(value, 10)
  return null
}

export function colorize(text: string, color: Color): string {
  return `\x1b[${color}m${text}\x1b[0m`
}

// 利用率の色分け (60 未満は緑、80 未満は黄、それ以上は赤)
export function colorForUtilization(pct: number): Color {
  if (pct >= 80) return Color.red
  if (pct >= 60) return Color.yellow
  return Color.green
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(ts: number): Date | null {
  const date = new Date(ts * 1000)
  return Number.isNaN(date.getTime()) ? null : date
}

// リセット時刻を "H:MM" にする (時は 0 埋めしない)
export function formatResetTimeShort(ts: number): string | null {
  const date = localDate(ts)
  return date ? `${date.getHours()}:${pad2(date.getMinutes())}` : null
}

// リセット時刻を "M/D H:MM" にする (月日時は 0 埋めしない)
export function formatResetDate(ts: number): string | null {
  const date = localDate(ts)
  if (!date) return null
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${pad2(date.getMinutes())}`
}

// OSC 8 のクリック可能なリンクにする (非対応の端末では text だけが表示される)
export function osc8Link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}

// git のリモート URL (SSH 形式と HTTPS 形式) を https の URL にする
export function remoteToHttps(remoteUrl: string): string | null {
  let url = remoteUrl.trim()
  if (url.startsWith('git@')) url = url.replace(':', '/').replace('git@', 'https://')
  if (url.endsWith('.git')) url = url.slice(0, -'.git'.length)
  return url.startsWith('https://') ? url : null
}

// モデル ID からバージョンを取り出す ("claude-opus-4-6" は "4.6")
// 4 桁以上の数字は日付なので、そこで打ち切る
export function extractVersion(modelId: string): string {
  const rest = modelId.startsWith('claude-') ? modelId.slice('claude-'.length) : modelId
  const parts = rest.split('-')
  if (parts.length < 2) return ''
  const digits: string[] = []
  for (const part of parts.slice(1)) {
    if (/^\d+$/.test(part)) {
      if (part.length >= 4) break
      digits.push(part)
      if (digits.length >= 2) break
    } else if (digits.length > 0) {
      break
    }
  }
  return digits.join('.')
}

// Python の Path.as_uri と同じ規則で file URL にする
// 英数字と - . _ ~ と区切りの / 以外はすべてパーセント符号化する
function quotePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function fileUri(absPath: string): string {
  const drive = /^[A-Za-z]:/.exec(absPath)?.[0] ?? ''
  const rest = absPath.slice(drive.length).replaceAll('\\', '/')
  const quoted = rest.split('/').map(quotePathSegment).join('/')
  return `file://${drive ? `/${drive}` : ''}${quoted}`
}

// 丁度中間の値だけ偶数へ丸め、それ以外は toFixed と同じ結果にする
// toFixed(100) は倍精度の値を 10 進で正確に展開するので、中間かどうかをその桁で判定する
function fixedHalfEven(value: number, decimals: number): string {
  const exact = value.toFixed(100)
  const cut = exact.indexOf('.') + 1 + decimals
  if (!/^50*$/.test(exact.slice(cut))) return value.toFixed(decimals)
  const truncated = exact.slice(0, cut).replace(/\.$/, '')
  if (Number(truncated.at(-1)) % 2 === 0) return truncated
  const step = (value < 0 ? -1 : 1) / 10 ** decimals
  return (Number(truncated) + step).toFixed(decimals)
}

// Python の format(x, ',.Nf') と同じ文字列にする
export function formatAmount(value: number, decimals: number): string {
  const [intPart = '', fracPart] = fixedHalfEven(value, decimals).split('.')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fracPart === undefined ? grouped : `${grouped}.${fracPart}`
}
