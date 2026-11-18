// Claude Code の statusline 用スクリプト
// statusline フックから stdin で受け取った JSON を、プロジェクト情報やレートリミットの行に整形して出力する
// 入力 JSON の構造: https://code.claude.com/docs/en/statusline

import { Database, SQLiteError } from 'bun:sqlite'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs as parseNodeArgs } from 'node:util'

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
  if (drive) return `file:///${drive}${quoted}`
  // UNC パス (//server/share) はサーバー名を authority に置く
  return `${rest.startsWith('//') ? 'file:' : 'file://'}${quoted}`
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

// ローカル日付を YYYY-MM-DD にする
export function today(env: Env): string {
  const date = new Date(env.now() * 1000)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export type CacheObject = Record<string, unknown>

export function cacheKeyMatches(cache: CacheObject, cacheKey?: Record<string, string>): boolean {
  if (!cacheKey) return true
  return Object.entries(cacheKey).every(([key, value]) => cache[key] === value)
}

// キャッシュに記録した epoch 秒を返す。有限の数でなければ記録が無いとみなす
function cacheTime(value: unknown): number | null {
  const time = safeFloat(value)
  return time !== null && Number.isFinite(time) ? time : null
}

// キャッシュと、複数のプロセスが読み書きする状態は SQLite の 1 ファイルに置き、トランザクションで直列化する
// SQLite のロックはプロセスの終了時に OS が外すため、打ち切られたプロセスのロックが残らない
const STATE_DB_FILE = 'claude-statusline-state.sqlite'
const STATE_BUSY_TIMEOUT_MS = 1000
// SQLite の主エラーコード (拡張エラーコードの下位 8 ビット)
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

export const STATE_KEYS = {
  git: 'git',
  exchange: 'exchange',
  sessionCost: 'session-cost',
  dailyCost: 'daily-cost',
  modelUsage: 'model-usage',
} as const

export type StateKey = (typeof STATE_KEYS)[keyof typeof STATE_KEYS]

// value を呼び出し元へ返し、next があれば状態をそれで置き換える
export type StateUpdate<T> = { value: T; next?: CacheObject }

// 共有の一時ディレクトリでは他のユーザーが同じ名前のファイルや symlink を先に置けるため、
// DB はユーザーごとのディレクトリに置く (Windows には uid が無く、一時ディレクトリがユーザーごとにある)
export function statePath(env: Env): string {
  return join(env.tmpDir(), `claude-statusline-${process.getuid?.() ?? 'user'}`, STATE_DB_FILE)
}

// ディレクトリを 0700 で作り、symlink でなく自分だけが使えるディレクトリか確かめる
function ensureStateDir(dir: string): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if (!(isRecord(error) && error.code === 'EEXIST')) return false
  }
  const stat = lstatSync(dir)
  if (!stat.isDirectory()) return false
  const uid = process.getuid?.()
  return uid === undefined || (stat.uid === uid && (stat.mode & 0o077) === 0)
}

function openStateDb(path: string): Database {
  if (!ensureStateDir(dirname(path))) throw new Error(`unsafe state directory: ${dirname(path)}`)
  const db = new Database(path, { create: true })
  try {
    db.run(`PRAGMA busy_timeout = ${STATE_BUSY_TIMEOUT_MS}`)
    db.run('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, body TEXT NOT NULL)')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

// 破損した DB は、他のプロセスが使用中かもしれず消すと破損を広げるため、自動では作り直さない
// 削除の手順を stderr に案内する (stdout は表示に使う)
function reportCorruptDb(env: Env, path: string, error: unknown): void {
  if (!(error instanceof SQLiteError)) return
  const primary = error.errno & 0xff
  if (primary !== SQLITE_CORRUPT && primary !== SQLITE_NOTADB) return
  env.stderr(
    `statusline: 状態の DB が破損しているため使えません。Claude Code をすべて終了し、数秒待ってから ${path} を削除してください。次に起動したときに作り直します。\n`,
  )
}

// DB を開いて fn を実行する。開けない、ロックを待ちきれない、破損しているなどで実行できなければ null を返す
// fn の中の SQLite 以外の例外はプログラムの誤りなので外へ出す
function withStateDb<T>(env: Env, fn: (db: Database) => T): T | null {
  const path = statePath(env)
  let db: Database
  try {
    db = openStateDb(path)
  } catch (error) {
    reportCorruptDb(env, path, error)
    return null
  }
  try {
    return fn(db)
  } catch (error) {
    if (!(error instanceof SQLiteError)) throw error
    reportCorruptDb(env, path, error)
    return null
  } finally {
    db.close()
  }
}

function readStateRow(db: Database, key: StateKey): CacheObject {
  const row = db.query<{ body: string }, [string]>('SELECT body FROM state WHERE key = ?').get(key)
  if (row === null) return {}
  try {
    const obj: unknown = JSON.parse(row.body)
    return isRecord(obj) ? obj : {}
  } catch {
    return {}
  }
}

// key の状態を読む (無い、読めない場合は空のオブジェクト)
export function readState(env: Env, key: StateKey): CacheObject {
  return withStateDb(env, (db) => readStateRow(db, key)) ?? {}
}

// key の状態を BEGIN IMMEDIATE で排他して読み、update の結果に従って置き換える
// DB を使えないときは update を呼ばずに null を返す
export function updateState<T>(
  env: Env,
  key: StateKey,
  update: (state: CacheObject) => StateUpdate<T>,
): T | null {
  return withStateDb(env, (db) =>
    db
      .transaction(() => {
        const result = update(readStateRow(db, key))
        if (result.next !== undefined) {
          db.query(
            'INSERT INTO state (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body',
          ).run(key, JSON.stringify(result.next))
        }
        return result.value
      })
      .immediate(),
  )
}

export type CachedFetchOptions<T> = {
  key: StateKey
  ttl: number // 秒
  fetch: () => Promise<T | null>
  isValid: (value: unknown) => value is T
  cacheKey?: Record<string, string>
}

// TTL 内かつ cacheKey が一致するキャッシュを返し、無ければ取得して保存する
// 取得に失敗したときは期限切れのキャッシュを返す
// 取得はトランザクションの外で行う (並行して取得した書き手どうしは、最後に書いた値が残る)
export async function cachedFetch<T>(env: Env, options: CachedFetchOptions<T>): Promise<T | null> {
  const now = env.now()
  const cache = readState(env, options.key)
  const cached = cache.data
  let expired: T | null = null
  if (cacheKeyMatches(cache, options.cacheKey) && options.isValid(cached)) {
    expired = cached
    if (now - (cacheTime(cache._cached_at) ?? 0) < options.ttl) return cached
  }
  let data: T | null
  try {
    data = await options.fetch()
  } catch {
    return expired
  }
  if (data === null) return expired
  updateState(env, options.key, () => ({
    value: undefined,
    next: { ...options.cacheKey, _cached_at: now, data },
  }))
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
    key: STATE_KEYS.exchange,
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
    key: STATE_KEYS.git,
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
  return updateState(env, STATE_KEYS.sessionCost, (state) => {
    const sessions = readSessions(state.sessions)
    const baseline = sessions[sessionId]
    if (baseline !== undefined) return { value: total - baseline }
    sessions[sessionId] = total
    return { value: 0, next: { sessions } }
  })
}

// セッションごとの前回値との増分を日次で累積する (日付が変わればすべてリセットする)
// 新しいセッションは前回値の記録だけ行い、日をまたいだセッションの前日分を含めない
export function getDailyCost(data: Input, env: Env): number | null {
  const total = totalCostUsd(data)
  if (total === null) return null
  const sessionId = typeof data.session_id === 'string' ? data.session_id : ''
  const date = today(env)
  return updateState(env, STATE_KEYS.dailyCost, (state) => {
    let accumulated = 0
    let sessions: Record<string, number> = {}
    if (state.date === date) {
      accumulated = safeFloat(state.accumulated) ?? 0
      sessions = readSessions(state.sessions)
    }
    const last = sessions[sessionId]
    if (last !== undefined && total - last > 0) accumulated += total - last
    if (last === total) return { value: accumulated }
    sessions[sessionId] = total
    return { value: accumulated, next: { date, sessions, accumulated } }
  })
}

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'
const MODEL_USAGE_TTL = 300 // 秒。Claude Code 本体のキャッシュ TTL と揃える
const MODEL_USAGE_RETRY_INTERVAL = 60 // 秒。取得失敗時の再試行を抑える間隔
const MODEL_USAGE_STALE = 900 // 秒。これを超えて更新が止まったキャッシュは表示に使わない

export type ModelUsageEntry = { display_name: string; percent: number; resets_at: number | null }
export type RateBucket = { used_percentage: number; resets_at: number }
export type UsageSnapshot = { weekly: RateBucket | null; model_scoped: ModelUsageEntry[] }
export type ModelUsage = { entries: ModelUsageEntry[] | null; weekly: RateBucket | null }

function isModelUsageEntry(value: unknown): value is ModelUsageEntry {
  return (
    isRecord(value) &&
    typeof value.display_name === 'string' &&
    typeof value.percent === 'number' &&
    (value.resets_at === null || typeof value.resets_at === 'number')
  )
}

function isRateBucket(value: unknown): value is RateBucket {
  return (
    isRecord(value) &&
    typeof value.used_percentage === 'number' &&
    typeof value.resets_at === 'number'
  )
}

// Claude Code の認証情報から期限内の access token を読む
// トークンの更新は Claude Code 本体の責務なので、ここでは行わない
export function readAccessToken(env: Env): string | null {
  try {
    const path = join(env.homeDir(), '.claude', '.credentials.json')
    const creds: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const oauth = isRecord(creds) ? creds.claudeAiOauth : undefined
    if (!isRecord(oauth)) return null
    const token = oauth.accessToken
    if (typeof token !== 'string' || token === '') return null
    const expiresAt = safeFloat(oauth.expiresAt)
    if (expiresAt !== null && expiresAt <= env.now() * 1000) return null
    return token
  } catch {
    return null
  }
}

// ISO 8601 の文字列を epoch 秒にする (不正な値は null)
export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms / 1000
}

// limits 配列の 1 要素をモデル別の週次枠にする (weekly_scoped かつ scope.model を持つものだけ)
export function toModelUsageEntry(item: unknown): ModelUsageEntry | null {
  if (!isRecord(item) || item.kind !== 'weekly_scoped') return null
  const model = isRecord(item.scope) ? item.scope.model : undefined
  const name = isRecord(model) ? model.display_name : undefined
  const percent = safeFloat(item.percent)
  if (typeof name !== 'string' || name === '' || percent === null) return null
  return { display_name: name, percent, resets_at: parseIsoTimestamp(item.resets_at) }
}

// limits 配列の 1 要素を週次全体のバケットにする (weekly_all でリセット時刻を持つものだけ)
export function toWeeklyBucket(item: unknown): RateBucket | null {
  if (!isRecord(item) || item.kind !== 'weekly_all') return null
  const percent = safeFloat(item.percent)
  const ts = parseIsoTimestamp(item.resets_at)
  if (percent === null || ts === null) return null
  return { used_percentage: percent, resets_at: ts }
}

// 使用量 API から週次の使用状況を取る (statusline の stdin にはモデル別の枠が無い)
// 7d 全体も同じ応答から取り、括弧内の内訳と表示時点を揃える
export async function fetchUsageSnapshot(env: Env): Promise<UsageSnapshot | null> {
  const token = readAccessToken(env)
  if (token === null) return null
  let body: unknown
  try {
    const res = await env.fetch(USAGE_API_URL, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    if (!res.ok) return null
    body = await res.json()
  } catch {
    return null
  }
  if (!isRecord(body)) return null
  if (!Array.isArray(body.limits)) return { weekly: null, model_scoped: [] }
  let weekly: RateBucket | null = null
  const entries: ModelUsageEntry[] = []
  for (const item of body.limits) {
    const entry = toModelUsageEntry(item)
    if (entry) entries.push(entry)
    else if (weekly === null) weekly = toWeeklyBucket(item)
  }
  return { weekly, model_scoped: entries }
}

// 最後に取得できてから STALE 以内のキャッシュか
export function isUsageCacheUsable(cache: CacheObject, now: number): boolean {
  const cachedAt = cacheTime(cache._cached_at)
  return cachedAt !== null && now - cachedAt < MODEL_USAGE_STALE
}

// TTL 内の値が無く、直近に更新を試行していなければ更新が要る
function needsUsageRefresh(cache: CacheObject, now: number): boolean {
  const fresh =
    isUsageCacheUsable(cache, now) &&
    Array.isArray(cache.data) &&
    now - (cacheTime(cache._cached_at) ?? 0) < MODEL_USAGE_TTL
  return !fresh && now - (cacheTime(cache._attempted_at) ?? 0) >= MODEL_USAGE_RETRY_INTERVAL
}

// 更新を起動する権利を取る。トランザクションの中で読み直して判定し、試行時刻を保存できたら権利を得る
// 子プロセスの起動前に記録し、取得中の描画や並行する描画で重複起動させない
// DB を使えないときは、権利を与えない
export function claimUsageRefresh(env: Env, now: number): boolean {
  const claimed = updateState(env, STATE_KEYS.modelUsage, (state) =>
    needsUsageRefresh(state, now)
      ? { value: true, next: { ...state, _attempted_at: now } }
      : { value: false },
  )
  return claimed ?? false
}

// detached を付けないと Windows では親の終了時に子も終了させられる
// (デタッチしない子は親の job object に入り、親のハンドルが閉じると kill される)
export function refreshSpawnOptions(platform: string): RefreshSpawnOptions {
  return platform === 'win32' ? { detached: true, windowsHide: true } : { detached: true }
}

// 使用量キャッシュを更新する子プロセスを起動する (結果は待たず次回の描画で反映する)
export function spawnUsageRefresh(env: Env): void {
  try {
    env.spawn(
      [process.execPath, import.meta.path, '--refresh-usage'],
      refreshSpawnOptions(process.platform),
    )
  } catch {
    // 起動できなくても描画は続ける
  }
}

// 使用量キャッシュから週次バケットとモデル別の内訳を取る (この経路では HTTP を発行しない)
// TTL を超えていれば古い値を返しつつ更新を起動し、STALE を超えた値は返さない
export function getModelUsage(env: Env): ModelUsage {
  const cache = readState(env, STATE_KEYS.modelUsage)
  const now = env.now()
  const usable = isUsageCacheUsable(cache, now)
  const entries = usable && Array.isArray(cache.data) ? cache.data.filter(isModelUsageEntry) : null
  const weekly = usable && isRateBucket(cache.weekly) ? cache.weekly : null
  if (needsUsageRefresh(cache, now) && claimUsageRefresh(env, now)) spawnUsageRefresh(env)
  return { entries, weekly }
}

// 使用量 API を取ってキャッシュを更新する (--refresh-usage 用)
// HTTP はトランザクションの外で行い、失敗時は試行時刻だけ更新して既存の値を保つ
export async function refreshModelUsage(env: Env): Promise<void> {
  const snapshot = await fetchUsageSnapshot(env)
  const now = env.now()
  updateState(env, STATE_KEYS.modelUsage, (state) => {
    const fetched = snapshot
      ? { _cached_at: now, data: snapshot.model_scoped, weekly: snapshot.weekly }
      : {}
    return { value: undefined, next: { ...state, _attempted_at: now, ...fetched } }
  })
}

// workspace.current_dir を優先し、無ければ cwd を使う
export function getCwd(data: Input): string {
  const workspace = data.workspace
  if (isRecord(workspace) && typeof workspace.current_dir === 'string' && workspace.current_dir) {
    return workspace.current_dir
  }
  return typeof data.cwd === 'string' ? data.cwd : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 絶対化して symlink を解決する。存在しないパスは絶対化だけ行う
function resolveRealPath(path: string, env: Env): string {
  const absolute = resolve(path)
  try {
    return env.realpath(absolute)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return absolute
    throw error
  }
}

// プロジェクト名 (cwd の末尾) を file URL へのリンクにする
// URL を作れないときは stderr に診断を出し、リンク無しで表示する (stdout は表示に使う)
export function segProject(data: Input, ctx: Ctx): string {
  const cwd = getCwd(data)
  let name = basename(cwd) || 'unknown'
  let url: string | null = null
  if (cwd) {
    try {
      const resolved = resolveRealPath(cwd, ctx.env)
      url = fileUri(resolved)
      name = basename(resolved) || name
    } catch (error) {
      ctx.env.stderr(
        `statusline: cannot build file URI from cwd=${JSON.stringify(cwd)}: ${errorMessage(error)}\n`,
      )
    }
  }
  const label = url ? osc8Link(url, name) : name
  return colorize(`${ctx.icons.folder} ${label}`, Color.blue)
}

// ブランチ名を表示し、リモートがあればブランチページへのリンクにする
export async function segBranch(data: Input, ctx: Ctx): Promise<string | null> {
  const cwd = getCwd(data)
  if (!cwd) return null
  const git = await getGitInfo(cwd, ctx.env)
  if (!git?.branch) return null
  const repo = git.remote_url ? remoteToHttps(git.remote_url) : null
  const label = repo ? osc8Link(`${repo}/tree/${git.branch}`, git.branch) : git.branch
  return colorize(`${ctx.icons.branch} ${label}`, Color.yellow)
}

// "base version (paren) effort" の順で組み立てる
// " context)" で終わる括弧はコンテキスト長の表記なので表示しない
export function segModel(data: Input, ctx: Ctx): string | null {
  const model = data.model
  if (!isRecord(model)) return null
  const displayName = typeof model.display_name === 'string' ? model.display_name : ''
  const modelId = typeof model.id === 'string' ? model.id : ''
  if (!displayName) return null
  let base = displayName
  let paren = ''
  const parenIndex = displayName.indexOf('(')
  if (parenIndex >= 0) {
    base = displayName.slice(0, parenIndex).trimEnd()
    paren = displayName.slice(parenIndex)
    if (paren.endsWith(' context)')) paren = ''
  }
  const version = extractVersion(modelId)
  const parts = [base]
  if (version && !base.includes(version)) parts.push(version)
  if (paren) parts.push(paren)
  const effort = data.effort
  if (isRecord(effort) && effort.level) parts.push(String(effort.level))
  return `${ctx.icons.model} ${parts.join(' ')}`
}

// コンテキストウィンドウの使用率
export function segContext(data: Input, ctx: Ctx): string | null {
  const window = data.context_window
  if (
    !isRecord(window) ||
    window.used_percentage === undefined ||
    window.used_percentage === null
  ) {
    return null
  }
  const pct = safeFloat(window.used_percentage)
  if (pct === null || !Number.isFinite(pct)) return null
  return `${ctx.icons.chart} ${colorize(`${Math.trunc(pct)}%`, colorForUtilization(pct))}`
}

// 変更行数 (追加と削除の両方が 0 なら表示しない)
export function segLines(data: Input, ctx: Ctx): string | null {
  const cost = data.cost
  if (!isRecord(cost)) return null
  const added = safeInt(cost.total_lines_added === undefined ? 0 : cost.total_lines_added)
  const removed = safeInt(cost.total_lines_removed === undefined ? 0 : cost.total_lines_removed)
  if (added === null || removed === null) return null
  if (added === 0 && removed === 0) return null
  return `${ctx.icons.pencil} ${colorize(`+${added}`, Color.green)}/${colorize(`-${removed}`, Color.red)}`
}

// モデル別の週次枠のうち上限に最も近いものを括弧で返す (無ければ空文字)
export function modelUsageSuffix(entries: ModelUsageEntry[] | null): string {
  if (!entries || entries.length === 0) return ''
  const top = entries.reduce((a, b) => (b.percent > a.percent ? b : a))
  if (!Number.isFinite(top.percent)) return ''
  return `(${colorize(`${Math.trunc(top.percent)}%`, colorForUtilization(top.percent))})`
}

// レートリミットの 1 バケットを "icon pct%suffix reset time" に整形する
function rateSegment(
  bucket: unknown,
  icon: string,
  resetIcon: string,
  formatReset: (ts: number) => string | null,
  suffix = '',
): string | null {
  if (!isRecord(bucket)) return null
  const pct = safeFloat(bucket.used_percentage)
  const ts = safeFloat(bucket.resets_at)
  if (pct === null || ts === null || !Number.isFinite(pct) || !Number.isFinite(ts)) return null
  const reset = formatReset(ts)
  if (reset === null) return null
  const coloredPct = colorize(`${Math.trunc(pct)}%`, colorForUtilization(pct))
  return `${icon} ${coloredPct}${suffix} ${resetIcon} ${reset}`
}

// 5 時間のレートリミット
export function segRate5h(data: Input, ctx: Ctx): string | null {
  const limits = data.rate_limits
  if (!isRecord(limits)) return null
  return rateSegment(limits.five_hour, ctx.icons.clock, ctx.icons.reset, formatResetTimeShort)
}

// 7 日のレートリミット。モデル別の内訳を括弧で併記し、
// 内訳と表示時点を揃えるため通常値も使用量キャッシュにあればそちらを使う
export function segRate7d(data: Input, ctx: Ctx): string | null {
  const limits = data.rate_limits
  if (!isRecord(limits)) return null
  const usage = getModelUsage(ctx.env)
  return rateSegment(
    usage.weekly ?? limits.seven_day,
    ctx.icons.calendar,
    ctx.icons.reset,
    formatResetDate,
    modelUsageSuffix(usage.entries),
  )
}

export async function segSessionCost(data: Input, ctx: Ctx): Promise<string | null> {
  const cost = getSessionCost(data, ctx.env)
  if (cost === null) return null
  return `${ctx.icons.money} ${await formatCost(cost, ctx)} (session)`
}

export async function segDailyCost(data: Input, ctx: Ctx): Promise<string | null> {
  const daily = getDailyCost(data, ctx.env)
  if (daily === null || daily <= 0) return null
  return `${ctx.icons.money} ${await formatCost(daily, ctx)} (daily)`
}

const SEPARATOR = ' │ '

export type SegmentFn = (data: Input, ctx: Ctx) => string | null | Promise<string | null>

export const SEGMENT_REGISTRY: Record<string, SegmentFn> = {
  project: segProject,
  branch: segBranch,
  model: segModel,
  context: segContext,
  lines: segLines,
  rate_5h: segRate5h,
  rate_7d: segRate7d,
  session_cost: segSessionCost,
  daily_cost: segDailyCost,
}

export const DEFAULT_SEGMENTS =
  'project,branch|model,context,rate_5h,rate_7d|session_cost,daily_cost'

// "a,b|c" のような構成文字列を行ごとのセグメント関数の配列にする (不明な名前は飛ばす)
export function parseSegments(spec: string): SegmentFn[][] {
  if (!spec.trim()) return []
  const lines: SegmentFn[][] = []
  for (const line of spec.split('|')) {
    const fns: SegmentFn[] = []
    for (const rawName of line.split(',')) {
      const name = rawName.trim()
      const fn = Object.hasOwn(SEGMENT_REGISTRY, name) ? SEGMENT_REGISTRY[name] : undefined
      if (fn) fns.push(fn)
    }
    if (fns.length > 0) lines.push(fns)
  }
  return lines
}

export function renderLine(segments: string[]): string {
  return segments.join(SEPARATOR)
}

// 行ごとにセグメントを順に評価し、空でない行だけを返す
export async function buildLines(
  data: Input,
  ctx: Ctx,
  lines: SegmentFn[][] = parseSegments(DEFAULT_SEGMENTS),
): Promise<string[]> {
  const output: string[] = []
  for (const fns of lines) {
    const segments: string[] = []
    for (const fn of fns) {
      const text = await fn(data, ctx)
      if (text !== null) segments.push(text)
    }
    if (segments.length > 0) output.push(renderLine(segments))
  }
  return output
}

export type Args = {
  icons: string | undefined
  currency: string | undefined
  segments: string
  refreshUsage: boolean
}

// 不明なオプションは例外にする (入口が stderr に出して終了コード 2 で終わる)
export function parseArgs(argv: string[]): Args {
  const { values } = parseNodeArgs({
    args: argv,
    strict: true,
    options: {
      icons: { type: 'string' },
      currency: { type: 'string' },
      segments: { type: 'string', default: DEFAULT_SEGMENTS },
      'refresh-usage': { type: 'boolean', default: false },
    },
  })
  return {
    icons: values.icons,
    currency: values.currency?.toUpperCase(),
    segments: values.segments ?? DEFAULT_SEGMENTS,
    refreshUsage: values['refresh-usage'] ?? false,
  }
}

// stdin の JSON からステータス行を組み立てる。表示しない条件では空の配列を返す
// --refresh-usage では stdin を読まず、使用量キャッシュの更新だけを行う
export async function main(
  argv: string[],
  readStdin: () => Promise<string>,
  env: Env,
): Promise<string[]> {
  const args = parseArgs(argv)
  if (args.refreshUsage) {
    await refreshModelUsage(env)
    return []
  }
  const ctx: Ctx = {
    icons: args.icons === 'nerd' ? ICONS_NERD : ICONS_EMOJI,
    currency: resolveCurrency(args.currency, env),
    env,
  }
  let raw: string
  try {
    raw = await readStdin()
  } catch {
    return []
  }
  if (!raw.trim()) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(data)) return []
  return buildLines(data, ctx, parseSegments(args.segments))
}

if (import.meta.main) {
  try {
    const lines = await main(process.argv.slice(2), () => Bun.stdin.text(), defaultEnv)
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`)
  } catch (error) {
    process.stderr.write(`statusline: ${errorMessage(error)}\n`)
    process.exit(2)
  }
}
