// Claude Code の statusline 用スクリプト
// statusline フックから stdin で受け取った JSON を、プロジェクト情報やレートリミットの行に整形して出力する
// 入力 JSON の構造: https://code.claude.com/docs/en/statusline

import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

const SUBPROCESS_TIMEOUT_MS = 3000

export type RefreshSpawnOptions = { windowsHide?: boolean; detached?: boolean }

// 副作用の入口。テストは一時ディレクトリと偽の関数を差し込む
export type Env = {
  now: () => number // epoch 秒 (キャッシュの _cached_at や resets_at と単位を揃える)
  tmpDir: () => string
  homeDir: () => string
  locale: () => string // BCP 47
  realpath: (path: string) => string
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  spawnSync: (cmd: string[], cwd?: string) => { exitCode: number; stdout: string }
  spawn: (cmd: string[], options: RefreshSpawnOptions) => void
  stderr: (text: string) => void
}

export const defaultEnv: Env = {
  now: () => Date.now() / 1000,
  tmpDir: () => tmpdir(),
  homeDir: () => homedir(),
  locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
  realpath: (path) => realpathSync.native(path),
  fetch: (input, init) => fetch(input, init),
  spawnSync: (cmd, cwd) => {
    const result = Bun.spawnSync(cmd, {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: SUBPROCESS_TIMEOUT_MS,
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString() }
  },
  spawn: (cmd, options) => {
    Bun.spawn(cmd, { ...options, stdio: ['ignore', 'ignore', 'ignore'] }).unref()
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

// 表示の設定。main が引数から組み立てて各セグメントへ渡す
export type Ctx = { icons: Icons; currency: string; env: Env }

// キャッシュのファイル名は Python 版と同じにし、既存のファイルを引き継ぐ
export const CACHE_FILES = {
  git: 'claude-git-cache.json',
  exchange: 'claude-exchange-cache.json',
  sessionCost: 'claude-session-cost.json',
  dailyCost: 'claude-daily-cost.json',
  modelUsage: 'claude-model-usage.json',
} as const

export function cachePath(env: Env, name: (typeof CACHE_FILES)[keyof typeof CACHE_FILES]): string {
  return join(env.tmpDir(), name)
}

// ローカル日付を YYYY-MM-DD にする
export function today(env: Env): string {
  const date = new Date(env.now() * 1000)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export type CacheObject = Record<string, unknown>

// キャッシュファイルを読む (無い、解析できない場合は空のオブジェクト)
export function readCacheObject(path: string): CacheObject {
  try {
    const obj: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(obj) ? obj : {}
  } catch {
    return {}
  }
}

export function cacheKeyMatches(cache: CacheObject, cacheKey?: Record<string, string>): boolean {
  if (!cacheKey) return true
  return Object.entries(cacheKey).every(([key, value]) => cache[key] === value)
}

// 一時ファイルに書いてから rename する (書き込み途中の内容を他プロセスに読ませない)
export function writeCache(path: string, obj: CacheObject): void {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const tmp = join(dirname(path), `claude-cache-${suffix}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(obj), 'utf8')
    renameSync(tmp, path)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // 一時ファイルが作れていなければ消すものも無い
    }
    return
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    // 権限を変えられないファイルシステムでは無視する
  }
}

// <path>.lock を排他的に作って read-modify-write を直列化する
// timeoutMs 内に取得できなければ、可用性を優先してロック無しで実行する
export function withFileLock<T>(path: string, fn: () => T, timeoutMs = 1000): T {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + timeoutMs
  let fd: number | null = null
  while (Date.now() < deadline) {
    try {
      fd = openSync(lockPath, 'wx')
      break
    } catch {
      Bun.sleepSync(10)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 閉じられなくても解放は続ける
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // 既に無ければよい
      }
    }
  }
}

export type CachedFetchOptions<T> = {
  path: string
  ttl: number // 秒
  fetch: () => Promise<T | null>
  isValid: (value: unknown) => value is T
  cacheKey?: Record<string, string>
}

// TTL 内かつ cacheKey が一致するキャッシュを返し、無ければ取得して保存する
// 取得に失敗したときは期限切れのキャッシュを返す
export async function cachedFetch<T>(env: Env, options: CachedFetchOptions<T>): Promise<T | null> {
  const now = env.now()
  const cache = readCacheObject(options.path)
  const cached = cache.data
  let expired: T | null = null
  if (cacheKeyMatches(cache, options.cacheKey) && options.isValid(cached)) {
    expired = cached
    if (now - (safeFloat(cache._cached_at) ?? 0) < options.ttl) return cached
  }
  let data: T | null
  try {
    data = await options.fetch()
  } catch {
    return expired
  }
  if (data === null) return expired
  writeCache(options.path, { ...options.cacheKey, _cached_at: now, data })
  return data
}

const API_TIMEOUT_MS = 5000
const EXCHANGE_API_URL = 'https://api.frankfurter.app/latest?from=USD&to='

export type CurrencyInfo = { symbol: string; decimals: number }

export const CURRENCIES: Record<string, CurrencyInfo> = {
  USD: { symbol: '$', decimals: 2 },
  EUR: { symbol: '€', decimals: 2 },
  GBP: { symbol: '£', decimals: 2 },
  JPY: { symbol: '¥', decimals: 0 },
  CNY: { symbol: '¥', decimals: 2 },
  KRW: { symbol: '₩', decimals: 0 },
  INR: { symbol: '₹', decimals: 2 },
  CAD: { symbol: 'C$', decimals: 2 },
  AUD: { symbol: 'A$', decimals: 2 },
  CHF: { symbol: 'CHF', decimals: 2 },
  BRL: { symbol: 'R$', decimals: 2 },
  SEK: { symbol: 'kr', decimals: 2 },
  NOK: { symbol: 'kr', decimals: 2 },
  DKK: { symbol: 'kr', decimals: 2 },
  PLN: { symbol: 'zł', decimals: 2 },
  CZK: { symbol: 'Kč', decimals: 2 },
  SGD: { symbol: 'S$', decimals: 2 },
  HKD: { symbol: 'HK$', decimals: 2 },
  MXN: { symbol: 'MX$', decimals: 2 },
  HUF: { symbol: 'Ft', decimals: 0 },
  IDR: { symbol: 'Rp', decimals: 0 },
  ILS: { symbol: '₪', decimals: 2 },
  ISK: { symbol: 'kr', decimals: 0 },
  MYR: { symbol: 'RM', decimals: 2 },
  NZD: { symbol: 'NZ$', decimals: 2 },
  PHP: { symbol: '₱', decimals: 2 },
  RON: { symbol: 'lei', decimals: 2 },
  THB: { symbol: '฿', decimals: 2 },
  TRY: { symbol: '₺', decimals: 2 },
  ZAR: { symbol: 'R', decimals: 2 },
}

export const LOCALE_TO_CURRENCY: Record<string, string> = {
  JP: 'JPY',
  US: 'USD',
  GB: 'GBP',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  FI: 'EUR',
  IE: 'EUR',
  PT: 'EUR',
  GR: 'EUR',
  LU: 'EUR',
  CN: 'CNY',
  KR: 'KRW',
  IN: 'INR',
  CA: 'CAD',
  AU: 'AUD',
  CH: 'CHF',
  BR: 'BRL',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  CZ: 'CZK',
  SG: 'SGD',
  HK: 'HKD',
  MX: 'MXN',
  HU: 'HUF',
  ID: 'IDR',
  IL: 'ILS',
  IS: 'ISK',
  MY: 'MYR',
  NZ: 'NZD',
  PH: 'PHP',
  RO: 'RON',
  TH: 'THB',
  TR: 'TRY',
  ZA: 'ZAR',
}

// BCP 47 のロケール ("ja-JP" など) の地域から通貨コードを決める (決まらなければ USD)
export function currencyFromLocale(locale: string): string {
  const region = locale
    .split(/[-_.]/)
    .slice(1)
    .find((part) => /^[A-Za-z]{2}$/.test(part))
  const currency = region === undefined ? undefined : LOCALE_TO_CURRENCY[region.toUpperCase()]
  return currency ?? 'USD'
}

// 優先順位は CLI 引数、ロケール、USD
export function resolveCurrency(arg: string | undefined, env: Env): string {
  if (arg !== undefined && Object.hasOwn(CURRENCIES, arg)) return arg
  const fromLocale = currencyFromLocale(env.locale())
  return Object.hasOwn(CURRENCIES, fromLocale) ? fromLocale : 'USD'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

// USD から指定通貨への為替レート (日付が変わるまでキャッシュする)
export async function getExchangeRate(currency: string, env: Env): Promise<number | null> {
  if (currency === 'USD') return null
  return cachedFetch(env, {
    path: cachePath(env, CACHE_FILES.exchange),
    ttl: Number.POSITIVE_INFINITY,
    cacheKey: { currency, date: today(env) },
    isValid: isNumber,
    fetch: async () => {
      const res = await env.fetch(`${EXCHANGE_API_URL}${currency}`, {
        headers: { 'User-Agent': 'statusline/1.0' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`exchange api returned ${res.status}`)
      const body: unknown = await res.json()
      const rate = isRecord(body) && isRecord(body.rates) ? safeFloat(body.rates[currency]) : null
      if (rate === null) throw new Error(`rate not found for ${currency}`)
      return rate
    },
  })
}

// コストを ctx の通貨で整形する (レートが取れないときは USD のまま)
export async function formatCost(costUsd: number, ctx: Ctx): Promise<string> {
  const usd = `$${formatAmount(costUsd, 2)}`
  if (ctx.currency === 'USD') return usd
  const info = CURRENCIES[ctx.currency]
  if (info === undefined) return usd
  const rate = await getExchangeRate(ctx.currency, ctx.env)
  if (rate === null) return usd
  return `${info.symbol}${formatAmount(costUsd * rate, info.decimals)}`
}

const GIT_CACHE_TTL = 5

export type GitInfo = { branch: string; remote_url?: string }

function isGitInfo(value: unknown): value is GitInfo {
  return (
    isRecord(value) &&
    typeof value.branch === 'string' &&
    (value.remote_url === undefined || typeof value.remote_url === 'string')
  )
}

// git のブランチ名 (detached HEAD では短縮ハッシュ) とリモート URL を取る
export function fetchGitInfo(cwd: string, env: Env): GitInfo {
  const run = (...args: string[]): string => {
    const result = env.spawnSync(['git', ...args], cwd || undefined)
    return result.exitCode === 0 ? result.stdout.trim() : ''
  }
  let branch = run('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') branch = run('rev-parse', '--short', 'HEAD')
  if (!branch) throw new Error('git branch not detected')
  const remote = run('remote', 'get-url', 'origin')
  return remote ? { branch, remote_url: remote } : { branch }
}

// cwd をキーに 5 秒キャッシュする
export function getGitInfo(cwd: string, env: Env): Promise<GitInfo | null> {
  return cachedFetch(env, {
    path: cachePath(env, CACHE_FILES.git),
    ttl: GIT_CACHE_TTL,
    cacheKey: { cwd },
    isValid: isGitInfo,
    fetch: async () => fetchGitInfo(cwd, env),
  })
}

// cost.total_cost_usd を数値で取る (無い、数値でない場合は null)
function totalCostUsd(data: Input): number | null {
  const cost = data.cost
  if (!isRecord(cost) || cost.total_cost_usd === undefined || cost.total_cost_usd === null) {
    return null
  }
  return safeFloat(cost.total_cost_usd)
}

// キャッシュの sessions を数値の辞書として読む (数値でない値は捨てる)
function readSessions(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const sessions: Record<string, number> = {}
  for (const [id, total] of Object.entries(value)) {
    const n = safeFloat(total)
    if (n !== null) sessions[id] = n
  }
  return sessions
}

// セッション開始時の合計を基準値として記録し、そこからの差分を返す
// (Claude Code の再起動で session_id が変わらずコストが引き継がれる場合に備える)
export function getSessionCost(data: Input, env: Env): number | null {
  const total = totalCostUsd(data)
  if (total === null) return null
  const sessionId = data.session_id
  if (typeof sessionId !== 'string' || sessionId === '') return total
  const path = cachePath(env, CACHE_FILES.sessionCost)
  return withFileLock(path, () => {
    const sessions = readSessions(readCacheObject(path).sessions)
    const baseline = sessions[sessionId]
    if (baseline !== undefined) return total - baseline
    sessions[sessionId] = total
    writeCache(path, { sessions })
    return 0
  })
}

// セッションごとの前回値との増分を日次で累積する (日付が変わればすべてリセットする)
// 新しいセッションは前回値の記録だけ行い、日をまたいだセッションの前日分を含めない
export function getDailyCost(data: Input, env: Env): number | null {
  const total = totalCostUsd(data)
  if (total === null) return null
  const sessionId = typeof data.session_id === 'string' ? data.session_id : ''
  const date = today(env)
  const path = cachePath(env, CACHE_FILES.dailyCost)
  return withFileLock(path, () => {
    const cache = readCacheObject(path)
    let accumulated = 0
    let sessions: Record<string, number> = {}
    if (cache.date === date) {
      accumulated = safeFloat(cache.accumulated) ?? 0
      sessions = readSessions(cache.sessions)
    }
    const last = sessions[sessionId]
    if (last !== undefined && total - last > 0) accumulated += total - last
    if (last !== total) {
      sessions[sessionId] = total
      writeCache(path, { date, sessions, accumulated })
    }
    return accumulated
  })
}
