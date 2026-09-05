import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sl from '../.claude/scripts/statusline'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-test-'))
  tempDirs.push(dir)
  return dir
}

// 2025-06-15T15:06:40Z
const NOW = 1_750_000_000

// 既定では HTTP と git は失敗し、子プロセスは起動せず、stderr は捨てる
function makeEnv(overrides: Partial<sl.Env> = {}): sl.Env {
  const dir = makeDir()
  return {
    now: () => NOW,
    tmpDir: () => dir,
    homeDir: () => dir,
    locale: () => 'en-US',
    realpath: sl.defaultEnv.realpath,
    fetch: () => Promise.reject(new Error('network disabled')),
    spawnSync: () => {
      throw new Error('git disabled')
    },
    spawn: () => undefined,
    stderr: () => undefined,
    ...overrides,
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('safeFloat', () => {
  test('数値と数値文字列を受け付ける', () => {
    expect(sl.safeFloat(1.5)).toBe(1.5)
    expect(sl.safeFloat('12.5')).toBe(12.5)
    expect(sl.safeFloat(' 3 ')).toBe(3)
  })

  test('数値にならない値は null を返す', () => {
    expect(sl.safeFloat('abc')).toBeNull()
    expect(sl.safeFloat('')).toBeNull()
    expect(sl.safeFloat(null)).toBeNull()
    expect(sl.safeFloat(undefined)).toBeNull()
    expect(sl.safeFloat(true)).toBeNull()
    expect(sl.safeFloat({})).toBeNull()
  })

  test('NaN の数値はそのまま返す (有限性は呼び出し側が判定する)', () => {
    expect(sl.safeFloat(Number.NaN)).toBeNaN()
  })
})

describe('safeInt', () => {
  test('数値は小数部を切り捨てる', () => {
    expect(sl.safeInt(12.9)).toBe(12)
    expect(sl.safeInt(-3.7)).toBe(-3)
    expect(sl.safeInt(0)).toBe(0)
  })

  test('整数の文字列を受け付ける', () => {
    expect(sl.safeInt('42')).toBe(42)
    expect(sl.safeInt(' -7 ')).toBe(-7)
  })

  test('小数の文字列や数値でない値は null を返す', () => {
    expect(sl.safeInt('12.5')).toBeNull()
    expect(sl.safeInt('abc')).toBeNull()
    expect(sl.safeInt(null)).toBeNull()
    expect(sl.safeInt(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('colorize', () => {
  test('ANSI のエスケープで色を付ける', () => {
    expect(sl.colorize('hello', sl.Color.red)).toBe('\x1b[31mhello\x1b[0m')
    expect(sl.colorize('ok', sl.Color.green)).toBe('\x1b[32mok\x1b[0m')
    expect(sl.colorize('', sl.Color.blue)).toBe('\x1b[34m\x1b[0m')
  })
})

describe('colorForUtilization', () => {
  test('60 未満は緑、80 未満は黄、80 以上は赤', () => {
    expect(sl.colorForUtilization(0)).toBe(sl.Color.green)
    expect(sl.colorForUtilization(59)).toBe(sl.Color.green)
    expect(sl.colorForUtilization(60)).toBe(sl.Color.yellow)
    expect(sl.colorForUtilization(79)).toBe(sl.Color.yellow)
    expect(sl.colorForUtilization(80)).toBe(sl.Color.red)
    expect(sl.colorForUtilization(100)).toBe(sl.Color.red)
  })
})

describe('formatResetTimeShort', () => {
  test('ローカル時刻を H:MM にし時は 0 埋めしない', () => {
    const local = new Date(2025, 0, 15, 9, 5)
    expect(sl.formatResetTimeShort(local.getTime() / 1000)).toBe('9:05')
  })

  test('14 時 30 分は 14:30 になる', () => {
    const local = new Date(2025, 0, 15, 14, 30)
    expect(sl.formatResetTimeShort(local.getTime() / 1000)).toBe('14:30')
  })

  test('0 時は 0:00 になる', () => {
    const local = new Date(2025, 0, 15, 0, 0)
    expect(sl.formatResetTimeShort(local.getTime() / 1000)).toBe('0:00')
  })

  test('Date にできない時刻は null を返す', () => {
    expect(sl.formatResetTimeShort(1e20)).toBeNull()
    expect(sl.formatResetTimeShort(Number.NaN)).toBeNull()
  })
})

describe('formatResetDate', () => {
  test('ローカル時刻を M/D H:MM にし月日時は 0 埋めしない', () => {
    const local = new Date(2025, 2, 5, 9, 5)
    expect(sl.formatResetDate(local.getTime() / 1000)).toBe('3/5 9:05')
  })

  test('1 月 15 日 14 時 30 分は 1/15 14:30 になる', () => {
    const local = new Date(2025, 0, 15, 14, 30)
    expect(sl.formatResetDate(local.getTime() / 1000)).toBe('1/15 14:30')
  })

  test('Date にできない時刻は null を返す', () => {
    expect(sl.formatResetDate(1e20)).toBeNull()
  })
})

describe('osc8Link', () => {
  test('OSC 8 のシーケンスで包む', () => {
    expect(sl.osc8Link('https://example.com', 'text')).toBe(
      '\x1b]8;;https://example.com\x07text\x1b]8;;\x07',
    )
  })

  test('空のテキストでも同じ形式になる', () => {
    expect(sl.osc8Link('https://example.com', '')).toBe(
      '\x1b]8;;https://example.com\x07\x1b]8;;\x07',
    )
  })
})

describe('remoteToHttps', () => {
  test.each([
    ['git@github.com:user/repo.git', 'https://github.com/user/repo'],
    ['https://github.com/user/repo.git', 'https://github.com/user/repo'],
    ['https://github.com/user/repo', 'https://github.com/user/repo'],
    ['svn://example.com/repo', null],
    ['  https://github.com/user/repo  ', 'https://github.com/user/repo'],
  ])('%s は %s になる', (input, expected) => {
    expect(sl.remoteToHttps(input)).toBe(expected)
  })
})

describe('extractVersion', () => {
  test.each([
    ['claude-opus-4-6', '4.6'],
    ['claude-sonnet-4-5-20250514', '4.5'],
    ['claude-haiku-3-5-20241022', '3.5'],
    ['', ''],
    ['unknown', ''],
    ['claude-opus-4', '4'],
    ['claude-opus-20250514', ''],
    ['claude-opus-4-beta', '4'],
    ['claude-opus-abc', ''],
  ])('%s のバージョンは %s', (modelId, expected) => {
    expect(sl.extractVersion(modelId)).toBe(expected)
  })
})

describe('fileUri', () => {
  test('POSIX の絶対パスを file URL にする', () => {
    expect(sl.fileUri('/home/user/my project')).toBe('file:///home/user/my%20project')
  })

  test('Windows のドライブ付きパスを file URL にする', () => {
    expect(sl.fileUri('D:\\projects\\agent-tools')).toBe('file:///D:/projects/agent-tools')
  })

  test('Python の as_uri と同じく括弧と引用符も符号化する', () => {
    expect(sl.fileUri("/a/b(1)'c!*")).toBe('file:///a/b%281%29%27c%21%2A')
    expect(sl.fileUri('/x,y;z=w&q$p+@')).toBe('file:///x%2Cy%3Bz%3Dw%26q%24p%2B%40')
    expect(sl.fileUri('/keep~_.-')).toBe('file:///keep~_.-')
  })

  test('非 ASCII を UTF-8 のパーセント符号化にする', () => {
    expect(sl.fileUri('/home/日本')).toBe('file:///home/%E6%97%A5%E6%9C%AC')
  })

  test('ルートだけのパスも扱える', () => {
    expect(sl.fileUri('/')).toBe('file:///')
    expect(sl.fileUri('D:\\')).toBe('file:///D:/')
  })
})

describe('formatAmount', () => {
  test('3 桁区切りと桁数を Python の format と同じにする', () => {
    expect(sl.formatAmount(1234.56, 2)).toBe('1,234.56')
    expect(sl.formatAmount(1500, 0)).toBe('1,500')
    expect(sl.formatAmount(1840, 2)).toBe('1,840.00')
    expect(sl.formatAmount(0.92, 2)).toBe('0.92')
    expect(sl.formatAmount(1234567.891, 2)).toBe('1,234,567.89')
  })

  test('丁度中間の値は偶数へ丸める', () => {
    expect(sl.formatAmount(184.5, 0)).toBe('184')
    expect(sl.formatAmount(185.5, 0)).toBe('186')
    expect(sl.formatAmount(0.125, 2)).toBe('0.12')
    expect(sl.formatAmount(0.375, 2)).toBe('0.38')
  })

  test('2 進数で中間に届かない値は真の値で丸める', () => {
    expect(sl.formatAmount(2.675, 2)).toBe('2.67')
    expect(sl.formatAmount(1.005, 2)).toBe('1.00')
  })

  test('負の値も扱える', () => {
    expect(sl.formatAmount(-1234.5, 2)).toBe('-1,234.50')
  })
})

describe('today', () => {
  test('env.now のローカル日付を YYYY-MM-DD にする', () => {
    const local = new Date(2026, 5, 26, 12, 0)
    const env = makeEnv({ now: () => local.getTime() / 1000 })
    expect(sl.today(env)).toBe('2026-06-26')
  })
})

describe('cachePath', () => {
  test('env.tmpDir の下にキャッシュファイルを置く', () => {
    const env = makeEnv()
    expect(sl.cachePath(env, sl.CACHE_FILES.git)).toBe(join(env.tmpDir(), 'claude-git-cache.json'))
  })
})

describe('readCacheObject', () => {
  test('JSON オブジェクトを返す', () => {
    const path = join(makeDir(), 'c.json')
    writeJson(path, { a: 1 })
    expect(sl.readCacheObject(path)).toEqual({ a: 1 })
  })

  test('無い、解析できない、オブジェクトでない場合は空のオブジェクト', () => {
    const dir = makeDir()
    expect(sl.readCacheObject(join(dir, 'absent.json'))).toEqual({})
    writeFileSync(join(dir, 'broken.json'), '{oops', 'utf8')
    expect(sl.readCacheObject(join(dir, 'broken.json'))).toEqual({})
    writeJson(join(dir, 'list.json'), [1, 2])
    expect(sl.readCacheObject(join(dir, 'list.json'))).toEqual({})
  })
})

describe('cacheKeyMatches', () => {
  test('キーが無ければ常に一致', () => {
    expect(sl.cacheKeyMatches({ a: 'x' })).toBe(true)
    expect(sl.cacheKeyMatches({ a: 'x' }, {})).toBe(true)
  })

  test('すべての値が一致すれば true', () => {
    expect(sl.cacheKeyMatches({ a: 'x', b: 'y', c: 1 }, { a: 'x', b: 'y' })).toBe(true)
  })

  test('値が違う、または欠けていれば false', () => {
    expect(sl.cacheKeyMatches({ a: 'x' }, { a: 'z' })).toBe(false)
    expect(sl.cacheKeyMatches({ a: 'x' }, { a: 'x', b: 'y' })).toBe(false)
  })
})

describe('writeCache', () => {
  test('JSON を書き、既存のファイルを置き換える', () => {
    const path = join(makeDir(), 'c.json')
    sl.writeCache(path, { v: 1 })
    sl.writeCache(path, { v: 2 })
    expect(readJson(path)).toEqual({ v: 2 })
  })

  test('rename に失敗したら一時ファイルを残さない', () => {
    const dir = makeDir()
    // 同名のディレクトリがあると rename に失敗する
    const target = join(dir, 'cache.json')
    mkdirSync(target)
    sl.writeCache(target, { key: 'value' })
    expect(readdirSync(dir).filter((name) => name.startsWith('claude-cache-'))).toEqual([])
  })
})

describe('withFileLock', () => {
  test('ロックを作り、関数の戻り値を返し、終了時に消す', () => {
    const path = join(makeDir(), 'cache.json')
    const lock = `${path}.lock`
    const result = sl.withFileLock(path, () => {
      expect(existsSync(lock)).toBe(true)
      return 42
    })
    expect(result).toBe(42)
    expect(existsSync(lock)).toBe(false)
  })

  test('既存のロックがあるとタイムアウト後に実行し、そのロックは消さない', () => {
    const path = join(makeDir(), 'cache.json')
    const lock = `${path}.lock`
    writeFileSync(lock, '', 'utf8')
    const fn = mock(() => 'ran')
    expect(sl.withFileLock(path, fn, 50)).toBe('ran')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(existsSync(lock)).toBe(true)
  })

  test('関数が例外を投げてもロックを消す', () => {
    const path = join(makeDir(), 'cache.json')
    expect(() =>
      sl.withFileLock(path, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(`${path}.lock`)).toBe(false)
  })
})

describe('cachedFetch', () => {
  const isNumber = (v: unknown): v is number => typeof v === 'number'

  function options(
    path: string,
    fetch: () => Promise<number | null>,
    cacheKey?: Record<string, string>,
  ) {
    return { path, ttl: 60, fetch, isValid: isNumber, cacheKey }
  }

  test('キャッシュが無ければ取得して保存する', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    expect(
      await sl.cachedFetch(
        env,
        options(path, async () => 7),
      ),
    ).toBe(7)
    expect(readJson(path)).toEqual({ _cached_at: NOW, data: 7 })
  })

  test('TTL 内のキャッシュを返し取得しない', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    writeJson(path, { _cached_at: NOW - 10, data: 5 })
    const fetch = mock(async () => 9)
    expect(await sl.cachedFetch(env, options(path, fetch))).toBe(5)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('TTL 切れなら取得し直す', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    writeJson(path, { _cached_at: NOW - 120, data: 5 })
    expect(
      await sl.cachedFetch(
        env,
        options(path, async () => 9),
      ),
    ).toBe(9)
  })

  test('取得に失敗したら期限切れのキャッシュを返す', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    writeJson(path, { _cached_at: NOW - 120, data: 5 })
    const failing = async (): Promise<number | null> => {
      throw new Error('fail')
    }
    expect(await sl.cachedFetch(env, options(path, failing))).toBe(5)
  })

  test('取得に失敗しキャッシュも無ければ null', async () => {
    const env = makeEnv()
    const failing = async (): Promise<number | null> => {
      throw new Error('fail')
    }
    expect(await sl.cachedFetch(env, options(join(env.tmpDir(), 'c.json'), failing))).toBeNull()
  })

  test('取得が null を返したら期限切れのキャッシュを返す', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    writeJson(path, { _cached_at: NOW - 120, data: 5 })
    expect(
      await sl.cachedFetch(
        env,
        options(path, async () => null),
      ),
    ).toBe(5)
  })

  test('cacheKey が一致しなければ取得し直す', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    writeJson(path, { _cached_at: NOW, data: 5, k: 'old' })
    expect(
      await sl.cachedFetch(
        env,
        options(path, async () => 9, { k: 'new' }),
      ),
    ).toBe(9)
    expect(readJson(path)).toEqual({ k: 'new', _cached_at: NOW, data: 9 })
  })

  test('cacheKey が一致すればキャッシュを返す', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    writeJson(path, { _cached_at: NOW, data: 5, k: 'same' })
    const fetch = mock(async () => 9)
    expect(await sl.cachedFetch(env, options(path, fetch, { k: 'same' }))).toBe(5)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('検証に通らないキャッシュは無いものとして扱う', async () => {
    const env = makeEnv()
    const path = join(env.tmpDir(), 'c.json')
    writeJson(path, { _cached_at: NOW, data: 'not a number' })
    expect(
      await sl.cachedFetch(
        env,
        options(path, async () => 9),
      ),
    ).toBe(9)
  })
})

function makeCtx(overrides: Partial<sl.Ctx> = {}): sl.Ctx {
  return { icons: sl.ICONS_EMOJI, currency: 'USD', env: makeEnv(), ...overrides }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('currencyFromLocale', () => {
  test.each([
    ['ja-JP', 'JPY'],
    ['en-US', 'USD'],
    ['en-GB', 'GBP'],
    ['de-DE', 'EUR'],
    ['ko-KR', 'KRW'],
    ['ja_JP.UTF-8', 'JPY'],
    ['sr-Latn-RS', 'USD'],
    ['xx-XX', 'USD'],
    ['ja', 'USD'],
    ['', 'USD'],
  ])('%s は %s', (locale, expected) => {
    expect(sl.currencyFromLocale(locale)).toBe(expected)
  })
})

describe('CURRENCIES と LOCALE_TO_CURRENCY', () => {
  test('主要通貨の記号と桁数を持つ', () => {
    expect(sl.CURRENCIES.USD).toEqual({ symbol: '$', decimals: 2 })
    expect(sl.CURRENCIES.JPY).toEqual({ symbol: '¥', decimals: 0 })
    expect(sl.CURRENCIES.THB).toEqual({ symbol: '฿', decimals: 2 })
    expect(sl.CURRENCIES.TRY).toEqual({ symbol: '₺', decimals: 2 })
    expect(sl.CURRENCIES.TWD).toBeUndefined()
  })

  test('ロケールの地域から通貨へ対応づける', () => {
    expect(sl.LOCALE_TO_CURRENCY.JP).toBe('JPY')
    expect(sl.LOCALE_TO_CURRENCY.US).toBe('USD')
    expect(sl.LOCALE_TO_CURRENCY.TW).toBeUndefined()
  })

  test('対応づけ先の通貨はすべて CURRENCIES にある', () => {
    for (const code of Object.values(sl.LOCALE_TO_CURRENCY)) {
      expect(sl.CURRENCIES[code]).toBeDefined()
    }
  })
})

describe('resolveCurrency', () => {
  test('引数の通貨が対応していればそれを使う', () => {
    expect(sl.resolveCurrency('JPY', makeEnv({ locale: () => 'en-US' }))).toBe('JPY')
  })

  test('引数の通貨が未対応ならロケールで決める', () => {
    expect(sl.resolveCurrency('XXX', makeEnv({ locale: () => 'de-DE' }))).toBe('EUR')
  })

  test('引数が無ければロケールで決める', () => {
    expect(sl.resolveCurrency(undefined, makeEnv({ locale: () => 'ja-JP' }))).toBe('JPY')
  })

  test('ロケールからも決まらなければ USD', () => {
    expect(sl.resolveCurrency(undefined, makeEnv({ locale: () => 'xx' }))).toBe('USD')
  })

  test('プロトタイプのキーは通貨として扱わない', () => {
    expect(sl.resolveCurrency('constructor', makeEnv({ locale: () => 'en-US' }))).toBe('USD')
  })
})

describe('getExchangeRate', () => {
  test('USD は変換不要なので null', async () => {
    expect(await sl.getExchangeRate('USD', makeEnv())).toBeNull()
  })

  test('API からレートを取り、通貨と日付をキーに保存する', async () => {
    const fetch = mock(async (_input: string | URL | Request) =>
      jsonResponse({ rates: { JPY: 150.5 } }),
    )
    const env = makeEnv({ fetch })
    expect(await sl.getExchangeRate('JPY', env)).toBe(150.5)
    const url = String(fetch.mock.calls[0]?.[0])
    expect(url).toBe('https://api.frankfurter.app/latest?from=USD&to=JPY')
    expect(readJson(sl.cachePath(env, sl.CACHE_FILES.exchange))).toEqual({
      currency: 'JPY',
      date: sl.today(env),
      _cached_at: NOW,
      data: 150.5,
    })
  })

  test('同じ日の同じ通貨のキャッシュがあれば API を呼ばない', async () => {
    const fetch = mock(async () => jsonResponse({ rates: { JPY: 1 } }))
    const env = makeEnv({ fetch })
    writeJson(sl.cachePath(env, sl.CACHE_FILES.exchange), {
      _cached_at: NOW - 86_400 * 30,
      data: 149,
      currency: 'JPY',
      date: sl.today(env),
    })
    expect(await sl.getExchangeRate('JPY', env)).toBe(149)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('API に失敗したら期限切れ (別の日) のキャッシュを返す', async () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.exchange), {
      _cached_at: 0,
      data: 148,
      currency: 'JPY',
      date: sl.today(env),
    })
    expect(await sl.getExchangeRate('JPY', env)).toBe(148)
  })

  test('API に失敗しキャッシュも無ければ null', async () => {
    expect(await sl.getExchangeRate('JPY', makeEnv())).toBeNull()
  })

  test('応答にレートが無ければ null', async () => {
    const env = makeEnv({ fetch: async () => jsonResponse({ rates: {} }) })
    expect(await sl.getExchangeRate('JPY', env)).toBeNull()
  })

  test('応答がエラーなら null', async () => {
    const env = makeEnv({ fetch: async () => jsonResponse({}, 500) })
    expect(await sl.getExchangeRate('JPY', env)).toBeNull()
  })

  test('通貨が違うキャッシュは無視して取り直す', async () => {
    const env = makeEnv({ fetch: async () => jsonResponse({ rates: { JPY: 150 } }) })
    writeJson(sl.cachePath(env, sl.CACHE_FILES.exchange), {
      _cached_at: NOW,
      data: 0.92,
      currency: 'EUR',
      date: sl.today(env),
    })
    expect(await sl.getExchangeRate('JPY', env)).toBe(150)
  })
})

describe('formatCost', () => {
  function ctxWithRate(currency: string, rate: number): sl.Ctx {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.exchange), {
      _cached_at: NOW,
      data: rate,
      currency,
      date: sl.today(env),
    })
    return makeCtx({ currency, env })
  }

  test('USD はそのまま $ 表示', async () => {
    expect(await sl.formatCost(1.23, makeCtx())).toBe('$1.23')
    expect(await sl.formatCost(1234.56, makeCtx())).toBe('$1,234.56')
  })

  test('JPY は小数なしで、184.5 円は偶数丸めで ¥184', async () => {
    expect(await sl.formatCost(1.23, ctxWithRate('JPY', 150))).toBe('¥184')
    expect(await sl.formatCost(10, ctxWithRate('JPY', 150))).toBe('¥1,500')
  })

  test('EUR は小数 2 桁', async () => {
    expect(await sl.formatCost(1, ctxWithRate('EUR', 0.92))).toBe('€0.92')
    expect(await sl.formatCost(2000, ctxWithRate('EUR', 0.92))).toBe('€1,840.00')
  })

  test('レートが取れなければ USD 表示', async () => {
    expect(await sl.formatCost(1.23, makeCtx({ currency: 'JPY' }))).toBe('$1.23')
  })

  test('未知の通貨は USD 表示', async () => {
    expect(await sl.formatCost(1.23, ctxWithRate('XYZ', 1.5))).toBe('$1.23')
  })
})

// git のサブコマンド ("rev-parse --abbrev-ref HEAD" など) ごとの結果を返す偽の spawnSync
function fakeGit(responses: Record<string, { exitCode: number; stdout: string }>) {
  const calls: string[][] = []
  const spawnSync: sl.Env['spawnSync'] = (cmd) => {
    calls.push(cmd)
    return responses[cmd.slice(1).join(' ')] ?? { exitCode: 128, stdout: '' }
  }
  return { calls, spawnSync }
}

describe('fetchGitInfo', () => {
  test('ブランチ名とリモート URL を返す', () => {
    const git = fakeGit({
      'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'main\n' },
      'remote get-url origin': { exitCode: 0, stdout: 'https://github.com/user/repo.git\n' },
    })
    const env = makeEnv({ spawnSync: git.spawnSync })
    expect(sl.fetchGitInfo('/some/path', env)).toEqual({
      branch: 'main',
      remote_url: 'https://github.com/user/repo.git',
    })
    expect(git.calls[0]).toEqual(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  })

  test('detached HEAD では短縮ハッシュを使う', () => {
    const git = fakeGit({
      'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'HEAD\n' },
      'rev-parse --short HEAD': { exitCode: 0, stdout: 'abc1234\n' },
    })
    expect(sl.fetchGitInfo('/some/path', makeEnv({ spawnSync: git.spawnSync }))).toEqual({
      branch: 'abc1234',
    })
  })

  test('ブランチが取れなければ例外を投げる', () => {
    const git = fakeGit({})
    expect(() => sl.fetchGitInfo('/some/path', makeEnv({ spawnSync: git.spawnSync }))).toThrow(
      'git branch not detected',
    )
  })

  test('リモートが無ければ remote_url を持たない', () => {
    const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'feature\n' } })
    const info = sl.fetchGitInfo('/some/path', makeEnv({ spawnSync: git.spawnSync }))
    expect(info).toEqual({ branch: 'feature' })
    expect('remote_url' in info).toBe(false)
  })

  test('cwd が空なら spawnSync に undefined を渡す', () => {
    const cwds: (string | undefined)[] = []
    const env = makeEnv({
      spawnSync: (_cmd, cwd) => {
        cwds.push(cwd)
        return { exitCode: 0, stdout: 'main\n' }
      },
    })
    sl.fetchGitInfo('', env)
    expect(cwds[0]).toBeUndefined()
  })
})

describe('getGitInfo', () => {
  test('取得した情報を cwd をキーに保存して返す', async () => {
    const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'main\n' } })
    const env = makeEnv({ spawnSync: git.spawnSync })
    expect(await sl.getGitInfo('/some/path', env)).toEqual({ branch: 'main' })
    expect(readJson(sl.cachePath(env, sl.CACHE_FILES.git))).toEqual({
      cwd: '/some/path',
      _cached_at: NOW,
      data: { branch: 'main' },
    })
  })

  test('有効なキャッシュがあれば git を実行しない', async () => {
    const git = fakeGit({})
    const env = makeEnv({ spawnSync: git.spawnSync })
    writeJson(sl.cachePath(env, sl.CACHE_FILES.git), {
      _cached_at: NOW,
      data: { branch: 'cached-branch' },
      cwd: '/some/path',
    })
    expect(await sl.getGitInfo('/some/path', env)).toEqual({ branch: 'cached-branch' })
    expect(git.calls).toEqual([])
  })

  test('cwd が違えばキャッシュを無効にして取り直す', async () => {
    const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'new-branch\n' } })
    const env = makeEnv({ spawnSync: git.spawnSync })
    writeJson(sl.cachePath(env, sl.CACHE_FILES.git), {
      _cached_at: NOW,
      data: { branch: 'old-branch' },
      cwd: '/old/path',
    })
    expect(await sl.getGitInfo('/new/path', env)).toEqual({ branch: 'new-branch' })
  })

  test('git が無くキャッシュも無ければ null', async () => {
    expect(await sl.getGitInfo('/some/path', makeEnv())).toBeNull()
  })
})

describe('getSessionCost', () => {
  const costData = (total: number | string, sessionId?: string): sl.Input => ({
    cost: { total_cost_usd: total },
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  })

  test('cost が無い、total_cost_usd が無い、数値でない場合は null', () => {
    const env = makeEnv()
    expect(sl.getSessionCost({}, env)).toBeNull()
    expect(sl.getSessionCost({ cost: {} }, env)).toBeNull()
    expect(sl.getSessionCost({ cost: 'x' }, env)).toBeNull()
    expect(sl.getSessionCost(costData('abc'), env)).toBeNull()
  })

  test('session_id が無ければ合計をそのまま返す', () => {
    expect(sl.getSessionCost(costData(1.5), makeEnv())).toBe(1.5)
  })

  test('新しいセッションは基準値を記録して 0 を返す', () => {
    const env = makeEnv()
    expect(sl.getSessionCost(costData(2.5, 's1'), env)).toBe(0)
    expect(readJson(sl.cachePath(env, sl.CACHE_FILES.sessionCost))).toEqual({
      sessions: { s1: 2.5 },
    })
  })

  test('既知のセッションは基準値との差分を返す', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.sessionCost), { sessions: { s1: 2.5 } })
    expect(sl.getSessionCost(costData(4, 's1'), env)).toBeCloseTo(1.5)
  })

  test('別のセッションの基準値を保つ', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.sessionCost), { sessions: { s1: 2.5 } })
    sl.getSessionCost(costData(1, 's2'), env)
    expect(readJson(sl.cachePath(env, sl.CACHE_FILES.sessionCost))).toEqual({
      sessions: { s1: 2.5, s2: 1 },
    })
  })

  test('解析できないキャッシュは空として扱う', () => {
    const env = makeEnv()
    writeFileSync(sl.cachePath(env, sl.CACHE_FILES.sessionCost), '{broken', 'utf8')
    expect(sl.getSessionCost(costData(3, 's1'), env)).toBe(0)
  })
})

describe('getDailyCost', () => {
  const dailyData = (total: number | string, sessionId = 'sess-a'): sl.Input => ({
    cost: { total_cost_usd: total },
    session_id: sessionId,
  })

  test('初回はセッションを記録して 0 を返す', () => {
    const env = makeEnv()
    expect(sl.getDailyCost(dailyData(0), env)).toBe(0)
    expect(readJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost))).toEqual({
      date: sl.today(env),
      sessions: { 'sess-a': 0 },
      accumulated: 0,
    })
  })

  test('同じセッションの増分を累積する', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost), {
      date: sl.today(env),
      sessions: { 'sess-a': 2 },
      accumulated: 3,
    })
    expect(sl.getDailyCost(dailyData(5), env)).toBeCloseTo(6)
  })

  test('新しいセッションは記録だけして累積しない', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost), {
      date: sl.today(env),
      sessions: { 'sess-a': 10 },
      accumulated: 15,
    })
    expect(sl.getDailyCost(dailyData(0.5, 'sess-b'), env)).toBeCloseTo(15)
    const cache = readJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost))
    expect(cache.sessions).toEqual({ 'sess-a': 10, 'sess-b': 0.5 })
  })

  test('日付が変わるとセッションの追跡と累積をリセットする', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost), {
      date: '1999-01-01',
      sessions: { 'old-sess': 50 },
      accumulated: 100,
    })
    expect(sl.getDailyCost(dailyData(2), env)).toBe(0)
    const cache = readJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost))
    expect(cache.date).toBe(sl.today(env))
    expect(cache.sessions).toEqual({ 'sess-a': 2 })
  })

  test('cost が無い、total_cost_usd が無い、数値でない場合は null', () => {
    const env = makeEnv()
    expect(sl.getDailyCost({}, env)).toBeNull()
    expect(sl.getDailyCost({ cost: {} }, env)).toBeNull()
    expect(sl.getDailyCost(dailyData('abc'), env)).toBeNull()
  })

  test('解析できないキャッシュは空として扱う', () => {
    const env = makeEnv()
    writeFileSync(sl.cachePath(env, sl.CACHE_FILES.dailyCost), '{broken', 'utf8')
    expect(sl.getDailyCost(dailyData(1), env)).toBe(0)
  })

  test('1 日に複数のセッションのコストを累積する', () => {
    const env = makeEnv()
    expect(sl.getDailyCost(dailyData(0, 's1'), env)).toBe(0)
    expect(sl.getDailyCost(dailyData(3, 's1'), env)).toBeCloseTo(3)
    expect(sl.getDailyCost(dailyData(5, 's1'), env)).toBeCloseTo(5)
    expect(sl.getDailyCost(dailyData(0, 's2'), env)).toBeCloseTo(5)
    expect(sl.getDailyCost(dailyData(2, 's2'), env)).toBeCloseTo(7)
  })

  test('複数のセッションが交互に呼んでも値が行き来しない', () => {
    const env = makeEnv()
    sl.getDailyCost(dailyData(0, 'a'), env)
    sl.getDailyCost(dailyData(0, 'b'), env)
    sl.getDailyCost(dailyData(3, 'a'), env)
    sl.getDailyCost(dailyData(2, 'b'), env)
    sl.getDailyCost(dailyData(4, 'a'), env)
    sl.getDailyCost(dailyData(2.5, 'b'), env)
    sl.getDailyCost(dailyData(5, 'a'), env)
    expect(sl.getDailyCost(dailyData(3, 'b'), env)).toBeCloseTo(8)
  })
})

const USAGE_API_SAMPLE = {
  five_hour: { utilization: 28.0, resets_at: '2026-08-22T07:19:59+00:00' },
  seven_day: { utilization: 51.0, resets_at: '2026-08-23T02:59:59+00:00' },
  seven_day_opus: null,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 28,
      resets_at: '2026-08-22T07:19:59+00:00',
      scope: null,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 51,
      resets_at: '2026-08-23T02:59:59+00:00',
      scope: null,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 87,
      resets_at: '2026-08-23T02:59:59+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
}

const WEEKLY_RESETS_AT = Date.UTC(2026, 7, 23, 2, 59, 59) / 1000

function writeCredentials(
  env: sl.Env,
  options: { token?: string; expiresInMs?: number } = {},
): void {
  mkdirSync(join(env.homeDir(), '.claude'), { recursive: true })
  writeJson(join(env.homeDir(), '.claude', '.credentials.json'), {
    claudeAiOauth: {
      accessToken: options.token ?? 'tok-abc',
      expiresAt: env.now() * 1000 + (options.expiresInMs ?? 3_600_000),
      subscriptionType: 'max',
    },
  })
}

const ENTRY: sl.ModelUsageEntry = { display_name: 'Fable', percent: 87, resets_at: null }
const WEEKLY: sl.RateBucket = { used_percentage: 51, resets_at: 1787454000 }

describe('readAccessToken', () => {
  test('期限内のトークンを返す', () => {
    const env = makeEnv()
    writeCredentials(env)
    expect(sl.readAccessToken(env)).toBe('tok-abc')
  })

  test('期限切れなら null', () => {
    const env = makeEnv()
    writeCredentials(env, { expiresInMs: -1000 })
    expect(sl.readAccessToken(env)).toBeNull()
  })

  test('ファイルが無い、JSON でない、oauth の節が無い場合は null', () => {
    const env = makeEnv()
    expect(sl.readAccessToken(env)).toBeNull()
    mkdirSync(join(env.homeDir(), '.claude'), { recursive: true })
    writeFileSync(join(env.homeDir(), '.claude', '.credentials.json'), '{broken', 'utf8')
    expect(sl.readAccessToken(env)).toBeNull()
    writeJson(join(env.homeDir(), '.claude', '.credentials.json'), { other: {} })
    expect(sl.readAccessToken(env)).toBeNull()
  })
})

describe('parseIsoTimestamp', () => {
  test('ISO 8601 を epoch 秒にする', () => {
    expect(sl.parseIsoTimestamp('2026-08-23T02:59:59+00:00')).toBe(WEEKLY_RESETS_AT)
  })

  test('文字列でない、解釈できない値は null', () => {
    expect(sl.parseIsoTimestamp(null)).toBeNull()
    expect(sl.parseIsoTimestamp(123)).toBeNull()
    expect(sl.parseIsoTimestamp('not a date')).toBeNull()
  })
})

describe('fetchUsageSnapshot', () => {
  function envWithUsage(body: unknown, status = 200): sl.Env {
    const env = makeEnv({ fetch: async () => jsonResponse(body, status) })
    writeCredentials(env)
    return env
  }

  test('weekly_all を週次バケットとして取り出す', async () => {
    const snapshot = await sl.fetchUsageSnapshot(envWithUsage(USAGE_API_SAMPLE))
    expect(snapshot?.weekly).toEqual({ used_percentage: 51, resets_at: WEEKLY_RESETS_AT })
  })

  test('weekly_all が無い、リセット時刻が無い場合は weekly が null', async () => {
    const withoutWeekly = { limits: [USAGE_API_SAMPLE.limits[2]] }
    expect((await sl.fetchUsageSnapshot(envWithUsage(withoutWeekly)))?.weekly).toBeNull()
    const withoutReset = { limits: [{ kind: 'weekly_all', percent: 51, resets_at: null }] }
    expect((await sl.fetchUsageSnapshot(envWithUsage(withoutReset)))?.weekly).toBeNull()
  })

  test('weekly_scoped をモデル別のエントリに射影する', async () => {
    const snapshot = await sl.fetchUsageSnapshot(envWithUsage(USAGE_API_SAMPLE))
    expect(snapshot?.model_scoped).toEqual([
      { display_name: 'Fable', percent: 87, resets_at: WEEKLY_RESETS_AT },
    ])
  })

  test('モデルの scope が無い weekly_scoped は除く', async () => {
    const body = { limits: [{ kind: 'weekly_scoped', percent: 10, resets_at: null, scope: null }] }
    expect((await sl.fetchUsageSnapshot(envWithUsage(body)))?.model_scoped).toEqual([])
  })

  test('resets_at が null のエントリは残す', async () => {
    const body = {
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 10,
          resets_at: null,
          scope: { model: { display_name: 'Sonnet' } },
        },
      ],
    }
    expect((await sl.fetchUsageSnapshot(envWithUsage(body)))?.model_scoped).toEqual([
      { display_name: 'Sonnet', percent: 10, resets_at: null },
    ])
  })

  test('limits が無ければ空のスナップショット', async () => {
    expect(await sl.fetchUsageSnapshot(envWithUsage({}))).toEqual({
      weekly: null,
      model_scoped: [],
    })
  })

  test('トークンが無ければ null で fetch を呼ばない', async () => {
    const fetch = mock(async (_input: string | URL | Request) => jsonResponse(USAGE_API_SAMPLE))
    expect(await sl.fetchUsageSnapshot(makeEnv({ fetch }))).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('HTTP エラーや通信の失敗は null', async () => {
    expect(await sl.fetchUsageSnapshot(envWithUsage({}, 500))).toBeNull()
    const env = makeEnv()
    writeCredentials(env)
    expect(await sl.fetchUsageSnapshot(env)).toBeNull()
  })

  test('Authorization ヘッダにトークンを付ける', async () => {
    const fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(USAGE_API_SAMPLE),
    )
    const env = makeEnv({ fetch })
    writeCredentials(env, { token: 'tok-xyz' })
    await sl.fetchUsageSnapshot(env)
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBe('Bearer tok-xyz')
  })
})

describe('refreshSpawnOptions', () => {
  test('Windows ではコンソール窓を隠すだけでデタッチしない', () => {
    expect(sl.refreshSpawnOptions('win32')).toEqual({ windowsHide: true })
  })

  test('それ以外では新しいセッションで起動する', () => {
    expect(sl.refreshSpawnOptions('linux')).toEqual({ detached: true })
    expect(sl.refreshSpawnOptions('darwin')).toEqual({ detached: true })
  })
})

describe('spawnUsageRefresh', () => {
  test('自分自身を --refresh-usage で起動する', () => {
    const spawn = mock((_cmd: string[], _options: sl.RefreshSpawnOptions) => undefined)
    sl.spawnUsageRefresh(makeEnv({ spawn }))
    const cmd = spawn.mock.calls[0]?.[0] ?? []
    expect(cmd[0]).toBe(process.execPath)
    expect(cmd[1]?.endsWith('statusline.ts')).toBe(true)
    expect(cmd[2]).toBe('--refresh-usage')
    expect(spawn.mock.calls[0]?.[1]).toEqual(sl.refreshSpawnOptions(process.platform))
  })

  test('起動に失敗しても例外を外に出さない', () => {
    const env = makeEnv({
      spawn: () => {
        throw new Error('spawn failed')
      },
    })
    expect(() => sl.spawnUsageRefresh(env)).not.toThrow()
  })
})

describe('getModelUsage', () => {
  function writeUsageCache(env: sl.Env, cachedAt: number, attemptedAt: number): void {
    writeJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage), {
      _cached_at: cachedAt,
      _attempted_at: attemptedAt,
      data: [ENTRY],
      weekly: WEEKLY,
    })
  }

  test('TTL 内はキャッシュを返し更新を起動しない', () => {
    const spawn = mock(() => undefined)
    const env = makeEnv({ spawn })
    writeUsageCache(env, NOW, NOW)
    expect(sl.getModelUsage(env)).toEqual({ entries: [ENTRY], weekly: WEEKLY })
    expect(spawn).not.toHaveBeenCalled()
  })

  test('TTL 切れでは期限切れの値を返しつつ更新を起動する', () => {
    const spawn = mock(() => undefined)
    const env = makeEnv({ spawn })
    writeUsageCache(env, NOW - 600, NOW - 600)
    expect(sl.getModelUsage(env)).toEqual({ entries: [ENTRY], weekly: WEEKLY })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('STALE を超えて更新できていない値は返さない', () => {
    const env = makeEnv()
    writeUsageCache(env, NOW - 10_000, NOW)
    expect(sl.getModelUsage(env)).toEqual({ entries: null, weekly: null })
  })

  test('起動前に試行時刻を記録し、直後の呼び出しでは重複起動しない', () => {
    const spawn = mock(() => undefined)
    const env = makeEnv({ spawn })
    writeUsageCache(env, NOW - 600, NOW - 600)
    sl.getModelUsage(env)
    sl.getModelUsage(env)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(readJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage))._attempted_at).toBe(NOW)
  })

  test('直近に試行済みなら再試行を起動しない', () => {
    const spawn = mock(() => undefined)
    const env = makeEnv({ spawn })
    writeUsageCache(env, NOW - 10_000, NOW)
    sl.getModelUsage(env)
    expect(spawn).not.toHaveBeenCalled()
  })

  test('キャッシュが無ければ null を返して更新を起動する', () => {
    const spawn = mock(() => undefined)
    expect(sl.getModelUsage(makeEnv({ spawn }))).toEqual({ entries: null, weekly: null })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('表示の経路では HTTP を発行しない', () => {
    const fetch = mock(async (_input: string | URL | Request) => jsonResponse(USAGE_API_SAMPLE))
    sl.getModelUsage(makeEnv({ fetch }))
    expect(fetch).not.toHaveBeenCalled()
  })

  test('形の合わない weekly は null にする', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage), {
      _cached_at: NOW,
      _attempted_at: NOW,
      data: [ENTRY],
      weekly: { used_percentage: 'x' },
    })
    expect(sl.getModelUsage(env).weekly).toBeNull()
  })
})

describe('refreshModelUsage', () => {
  test('取得に成功したら週次値とモデル別枠と時刻を書く', async () => {
    const env = makeEnv({ fetch: async () => jsonResponse(USAGE_API_SAMPLE) })
    writeCredentials(env)
    await sl.refreshModelUsage(env)
    const cache = readJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage))
    expect(cache.data).toEqual([
      { display_name: 'Fable', percent: 87, resets_at: WEEKLY_RESETS_AT },
    ])
    expect(cache.weekly).toEqual({ used_percentage: 51, resets_at: WEEKLY_RESETS_AT })
    expect(cache._cached_at).toBe(NOW)
    expect(cache._attempted_at).toBe(NOW)
  })

  test('取得に失敗したら既存の値を保ち試行時刻だけ更新する', async () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage), {
      _cached_at: 100,
      _attempted_at: 100,
      data: [ENTRY],
      weekly: WEEKLY,
    })
    await sl.refreshModelUsage(env)
    const cache = readJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage))
    expect(cache.data).toEqual([ENTRY])
    expect(cache.weekly).toEqual(WEEKLY)
    expect(cache._cached_at).toBe(100)
    expect(cache._attempted_at).toBe(NOW)
  })
})

describe('getCwd', () => {
  test('workspace.current_dir を優先する', () => {
    expect(sl.getCwd({ cwd: '/a', workspace: { current_dir: '/b' } })).toBe('/b')
  })

  test('current_dir が無い、workspace がオブジェクトでない場合は cwd', () => {
    expect(sl.getCwd({ cwd: '/a', workspace: {} })).toBe('/a')
    expect(sl.getCwd({ cwd: '/a', workspace: 'x' })).toBe('/a')
    expect(sl.getCwd({ cwd: '/a' })).toBe('/a')
  })

  test('どちらも無ければ空文字', () => {
    expect(sl.getCwd({})).toBe('')
    expect(sl.getCwd({ cwd: 123 })).toBe('')
  })
})

describe('segProject', () => {
  test('ディレクトリ名を file URL へのリンクにして青で表示する', () => {
    const dir = join(makeDir(), 'myproject')
    mkdirSync(dir)
    const ctx = makeCtx()
    const text = sl.segProject({ cwd: dir }, ctx)
    expect(text).toContain('myproject')
    expect(text).toContain(sl.fileUri(ctx.env.realpath(dir)))
    expect(text.startsWith(`\x1b[34m${sl.ICONS_EMOJI.folder} `)).toBe(true)
  })

  test('相対パスは実行時のカレントディレクトリ基準で絶対化する', () => {
    const text = sl.segProject({ cwd: 'relative/path/myproject' }, makeCtx())
    expect(text).toContain('myproject')
    expect(text).toContain('file://')
  })

  test('cwd が空なら unknown でリンク無し', () => {
    const text = sl.segProject({}, makeCtx())
    expect(text).toContain('unknown')
    expect(text).not.toContain('file://')
  })

  test('. と .. は絶対化した後の名前を表示する', () => {
    expect(sl.segProject({ cwd: '.' }, makeCtx())).toContain(sl.fileUri(process.cwd()))
    const parentName = process.cwd().split(/[\\/]/).slice(0, -1).pop() ?? ''
    expect(sl.segProject({ cwd: '..' }, makeCtx())).toContain(parentName)
  })

  test('存在しないパスは絶対化だけしてリンクを付ける', () => {
    const missing = join(makeDir(), 'missing', 'proj')
    const stderr = mock((_text: string) => undefined)
    const text = sl.segProject({ cwd: missing }, makeCtx({ env: makeEnv({ stderr }) }))
    expect(text).toContain('proj')
    expect(text).toContain('file://')
    expect(stderr).not.toHaveBeenCalled()
  })

  test('realpath がそれ以外の理由で失敗したら stderr に診断を出しリンクを付けない', () => {
    const stderr = mock((_text: string) => undefined)
    const env = makeEnv({
      stderr,
      realpath: () => {
        throw new Error('uri build error')
      },
    })
    const text = sl.segProject({ cwd: join(makeDir(), 'myproject') }, makeCtx({ env }))
    expect(text).toContain('myproject')
    expect(text).not.toContain('file://')
    const message = stderr.mock.calls[0]?.[0] ?? ''
    expect(message).toContain('statusline:')
    expect(message).toContain('uri build error')
  })

  test('成功時は stderr に何も出さない', () => {
    const stderr = mock((_text: string) => undefined)
    sl.segProject({ cwd: makeDir() }, makeCtx({ env: makeEnv({ stderr }) }))
    expect(stderr).not.toHaveBeenCalled()
  })
})

describe('segBranch', () => {
  test('ブランチ名を黄で表示し、リモートがあればブランチページへのリンクにする', async () => {
    const git = fakeGit({
      'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'main\n' },
      'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:user/repo.git\n' },
    })
    const ctx = makeCtx({ env: makeEnv({ spawnSync: git.spawnSync }) })
    const text = await sl.segBranch({ cwd: '/some/path' }, ctx)
    expect(text).toBe(
      sl.colorize(
        `${sl.ICONS_EMOJI.branch} ${sl.osc8Link('https://github.com/user/repo/tree/main', 'main')}`,
        sl.Color.yellow,
      ),
    )
  })

  test('リモートが無い、または対応しないプロトコルならリンク無し', async () => {
    const noRemote = fakeGit({ 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'main\n' } })
    expect(
      await sl.segBranch(
        { cwd: '/p' },
        makeCtx({ env: makeEnv({ spawnSync: noRemote.spawnSync }) }),
      ),
    ).toBe(sl.colorize(`${sl.ICONS_EMOJI.branch} main`, sl.Color.yellow))
    const svn = fakeGit({
      'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'main\n' },
      'remote get-url origin': { exitCode: 0, stdout: 'svn://example.com/repo\n' },
    })
    expect(
      await sl.segBranch({ cwd: '/p' }, makeCtx({ env: makeEnv({ spawnSync: svn.spawnSync }) })),
    ).not.toContain('\x1b]8;;')
  })

  test('cwd が無い、git が無い場合は null', async () => {
    expect(await sl.segBranch({}, makeCtx())).toBeNull()
    expect(await sl.segBranch({ cwd: '/p' }, makeCtx())).toBeNull()
  })

  test('キャッシュがあれば git を実行しない', async () => {
    const git = fakeGit({})
    const env = makeEnv({ spawnSync: git.spawnSync })
    writeJson(sl.cachePath(env, sl.CACHE_FILES.git), {
      _cached_at: NOW,
      data: { branch: 'cached' },
      cwd: '/p',
    })
    expect(await sl.segBranch({ cwd: '/p' }, makeCtx({ env }))).toContain('cached')
    expect(git.calls).toEqual([])
  })
})

describe('segModel', () => {
  const model = (displayName: string, id: string, effort?: unknown): sl.Input => ({
    model: { display_name: displayName, id },
    ...(effort === undefined ? {} : { effort }),
  })

  test('display_name とバージョンを表示する', () => {
    expect(sl.segModel(model('Opus', 'claude-opus-4-6'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} Opus 4.6`,
    )
  })

  test('model が無い、オブジェクトでない、display_name が無い場合は null', () => {
    expect(sl.segModel({}, makeCtx())).toBeNull()
    expect(sl.segModel({ model: 'string' }, makeCtx())).toBeNull()
    expect(sl.segModel({ model: { id: 'claude-opus-4-6' } }, makeCtx())).toBeNull()
  })

  test('display_name にバージョンが含まれていれば重複させない', () => {
    expect(sl.segModel(model('Opus 4.6', 'claude-opus-4-6'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} Opus 4.6`,
    )
  })

  test('" context)" で終わる括弧は表示しない', () => {
    expect(sl.segModel(model('Opus 4.6 (1M context)', 'claude-opus-4-6'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} Opus 4.6`,
    )
    expect(
      sl.segModel(model('Sonnet 4.5 (200K context)', 'claude-sonnet-4-5-20250514'), makeCtx()),
    ).toBe(`${sl.ICONS_EMOJI.model} Sonnet 4.5`)
    expect(sl.segModel(model('Opus (1M context context)', 'claude-opus-4-7'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} Opus 4.7`,
    )
  })

  test('それ以外の括弧は保つ', () => {
    expect(sl.segModel(model('Opus (preview)', 'claude-opus-4-7'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} Opus 4.7 (preview)`,
    )
  })

  test('バージョンが取れなければ display_name だけ', () => {
    expect(sl.segModel(model('CustomModel', 'custom'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} CustomModel`,
    )
  })

  test('effort.level を末尾に付ける', () => {
    expect(
      sl.segModel(model('Opus (1M context)', 'claude-opus-4-7', { level: 'high' }), makeCtx()),
    ).toBe(`${sl.ICONS_EMOJI.model} Opus 4.7 high`)
  })

  test('effort が無い、オブジェクトでない場合は付けない', () => {
    expect(sl.segModel(model('Sonnet', 'claude-sonnet-4-6'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} Sonnet 4.6`,
    )
    expect(sl.segModel(model('Opus', 'claude-opus-4-7', 'high'), makeCtx())).toBe(
      `${sl.ICONS_EMOJI.model} Opus 4.7`,
    )
  })
})

describe('segContext', () => {
  test('使用率を整数の % で色付きに表示する', () => {
    expect(sl.segContext({ context_window: { used_percentage: 45.7 } }, makeCtx())).toBe(
      `${sl.ICONS_EMOJI.chart} ${sl.colorize('45%', sl.Color.green)}`,
    )
  })

  test('利用率に応じて色が変わる', () => {
    expect(sl.segContext({ context_window: { used_percentage: 85 } }, makeCtx())).toContain(
      '\x1b[31m',
    )
    expect(sl.segContext({ context_window: { used_percentage: 65 } }, makeCtx())).toContain(
      '\x1b[33m',
    )
    expect(sl.segContext({ context_window: { used_percentage: 30 } }, makeCtx())).toContain(
      '\x1b[32m',
    )
  })

  test('context_window や used_percentage が無い、数値でない、有限でない場合は null', () => {
    expect(sl.segContext({}, makeCtx())).toBeNull()
    expect(sl.segContext({ context_window: 'x' }, makeCtx())).toBeNull()
    expect(sl.segContext({ context_window: {} }, makeCtx())).toBeNull()
    expect(sl.segContext({ context_window: { used_percentage: 'abc' } }, makeCtx())).toBeNull()
    expect(sl.segContext({ context_window: { used_percentage: Number.NaN } }, makeCtx())).toBeNull()
    expect(
      sl.segContext({ context_window: { used_percentage: Number.POSITIVE_INFINITY } }, makeCtx()),
    ).toBeNull()
  })
})

describe('segLines', () => {
  test('追加行を緑、削除行を赤で表示する', () => {
    const data = { cost: { total_lines_added: 156, total_lines_removed: 23 } }
    expect(sl.segLines(data, makeCtx())).toBe(
      `${sl.ICONS_EMOJI.pencil} ${sl.colorize('+156', sl.Color.green)}/${sl.colorize('-23', sl.Color.red)}`,
    )
  })

  test('片方だけでも表示する', () => {
    expect(sl.segLines({ cost: { total_lines_added: 10 } }, makeCtx())).toContain('+10')
    expect(sl.segLines({ cost: { total_lines_added: 10 } }, makeCtx())).toContain('-0')
  })

  test('変更が 0 行、cost が無い、オブジェクトでない、数値でない場合は null', () => {
    expect(
      sl.segLines({ cost: { total_lines_added: 0, total_lines_removed: 0 } }, makeCtx()),
    ).toBeNull()
    expect(sl.segLines({}, makeCtx())).toBeNull()
    expect(sl.segLines({ cost: 'x' }, makeCtx())).toBeNull()
    expect(sl.segLines({ cost: { total_lines_added: 'abc' } }, makeCtx())).toBeNull()
  })
})

describe('modelUsageSuffix', () => {
  test('最も高い利用率を括弧で色付きに返す', () => {
    const entries: sl.ModelUsageEntry[] = [
      { display_name: 'Sonnet', percent: 10, resets_at: null },
      { display_name: 'Fable', percent: 88, resets_at: null },
    ]
    expect(sl.modelUsageSuffix(entries)).toBe(`(${sl.colorize('88%', sl.Color.red)})`)
  })

  test('無い、空、有限でない場合は空文字', () => {
    expect(sl.modelUsageSuffix(null)).toBe('')
    expect(sl.modelUsageSuffix([])).toBe('')
    expect(sl.modelUsageSuffix([{ display_name: 'X', percent: Number.NaN, resets_at: null }])).toBe(
      '',
    )
  })
})

describe('segRate5h', () => {
  const data: sl.Input = {
    rate_limits: { five_hour: { used_percentage: 45.0, resets_at: 1736951400 } },
  }

  test('利用率とリセット時刻を表示する', () => {
    const reset = sl.formatResetTimeShort(1736951400)
    expect(sl.segRate5h(data, makeCtx())).toBe(
      `${sl.ICONS_EMOJI.clock} ${sl.colorize('45%', sl.Color.green)} ${sl.ICONS_EMOJI.reset} ${reset}`,
    )
  })

  test('80% 以上は赤', () => {
    const hot = { rate_limits: { five_hour: { used_percentage: 85, resets_at: 1736951400 } } }
    expect(sl.segRate5h(hot, makeCtx())).toContain('\x1b[31m85%')
  })

  test('rate_limits やバケットが無い、値が欠けている、数値でない、有限でない、時刻が不正なら null', () => {
    expect(sl.segRate5h({}, makeCtx())).toBeNull()
    expect(sl.segRate5h({ rate_limits: {} }, makeCtx())).toBeNull()
    expect(sl.segRate5h({ rate_limits: { five_hour: { resets_at: 1 } } }, makeCtx())).toBeNull()
    expect(
      sl.segRate5h(
        { rate_limits: { five_hour: { used_percentage: 'x', resets_at: 1 } } },
        makeCtx(),
      ),
    ).toBeNull()
    expect(
      sl.segRate5h({ rate_limits: { five_hour: { used_percentage: 45 } } }, makeCtx()),
    ).toBeNull()
    expect(
      sl.segRate5h(
        {
          rate_limits: { five_hour: { used_percentage: 45, resets_at: Number.POSITIVE_INFINITY } },
        },
        makeCtx(),
      ),
    ).toBeNull()
    expect(
      sl.segRate5h(
        { rate_limits: { five_hour: { used_percentage: 45, resets_at: 1e20 } } },
        makeCtx(),
      ),
    ).toBeNull()
  })

  test('モデル別の内訳は付けない', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage), {
      _cached_at: NOW,
      _attempted_at: NOW,
      data: [{ display_name: 'Fable', percent: 88, resets_at: null }],
    })
    expect(sl.segRate5h(data, makeCtx({ env }))).not.toContain('(')
  })
})

describe('segRate7d', () => {
  const data: sl.Input = {
    rate_limits: { seven_day: { used_percentage: 51, resets_at: 1787454000 } },
  }

  function envWithUsage(entries: sl.ModelUsageEntry[] | null, weekly?: sl.RateBucket): sl.Env {
    const env = makeEnv()
    if (entries !== null || weekly !== undefined) {
      writeJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage), {
        _cached_at: NOW,
        _attempted_at: NOW,
        data: entries ?? [],
        weekly: weekly ?? null,
      })
    }
    return env
  }

  test('利用率とリセット日時を表示する', () => {
    const reset = sl.formatResetDate(1787454000)
    const env = envWithUsage([])
    expect(sl.segRate7d(data, makeCtx({ env }))).toBe(
      `${sl.ICONS_EMOJI.calendar} ${sl.colorize('51%', sl.Color.green)} ${sl.ICONS_EMOJI.reset} ${reset}`,
    )
  })

  test('モデル別枠を利用率の直後へ括弧で付け、それぞれの利用率で色を付ける', () => {
    const env = envWithUsage([{ display_name: 'Fable', percent: 88, resets_at: null }])
    const text = sl.segRate7d(data, makeCtx({ env })) ?? ''
    expect(text).toContain(
      `${sl.colorize('51%', sl.Color.green)}(${sl.colorize('88%', sl.Color.red)})`,
    )
  })

  test('複数の枠では利用率が最も高いものを付ける', () => {
    const env = envWithUsage([
      { display_name: 'Sonnet', percent: 10, resets_at: null },
      { display_name: 'Fable', percent: 88, resets_at: null },
    ])
    const text = sl.segRate7d(data, makeCtx({ env })) ?? ''
    expect(text).toContain('88%')
    expect(text).not.toContain('10%')
  })

  test('モデル別枠が無ければ括弧を出さない', () => {
    expect(sl.segRate7d(data, makeCtx({ env: envWithUsage(null) }))).not.toContain('(')
  })

  test('キャッシュに週次値があれば stdin の値より優先する', () => {
    const env = envWithUsage([], { used_percentage: 60, resets_at: 1787454000 })
    const text = sl.segRate7d(data, makeCtx({ env })) ?? ''
    expect(text).toContain('60%')
    expect(text).not.toContain('51%')
  })

  test('キャッシュが STALE を超えていれば stdin の値を使う', () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.modelUsage), {
      _cached_at: NOW - 10_000,
      _attempted_at: NOW,
      data: [{ display_name: 'Fable', percent: 88, resets_at: null }],
      weekly: { used_percentage: 60, resets_at: 1787454000 },
    })
    const text = sl.segRate7d(data, makeCtx({ env })) ?? ''
    expect(text).toContain('51%')
    expect(text).not.toContain('60%')
    expect(text).not.toContain('(')
  })

  test('rate_limits が無ければ null でキャッシュにも触れない', () => {
    const spawn = mock(() => undefined)
    expect(sl.segRate7d({}, makeCtx({ env: makeEnv({ spawn }) }))).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  test('入力オブジェクトを書き換えない', () => {
    const env = envWithUsage([], { used_percentage: 60, resets_at: 1787454000 })
    const input = structuredClone(data)
    sl.segRate7d(input, makeCtx({ env }))
    expect(input).toEqual(data)
  })
})

describe('segSessionCost', () => {
  test('セッションコストを通貨で表示する', async () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.sessionCost), { sessions: { s1: 0 } })
    const data = { cost: { total_cost_usd: 1.23 }, session_id: 's1' }
    expect(await sl.segSessionCost(data, makeCtx({ env }))).toBe(
      `${sl.ICONS_EMOJI.money} $1.23 (session)`,
    )
  })

  test('JPY なら ¥ で表示する', async () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.exchange), {
      _cached_at: NOW,
      data: 150,
      currency: 'JPY',
      date: sl.today(env),
    })
    const data = { cost: { total_cost_usd: 1.23 } }
    expect(await sl.segSessionCost(data, makeCtx({ currency: 'JPY', env }))).toContain('¥184')
  })

  test('cost が無い、total_cost_usd が無い、数値でない場合は null', async () => {
    expect(await sl.segSessionCost({}, makeCtx())).toBeNull()
    expect(await sl.segSessionCost({ cost: {} }, makeCtx())).toBeNull()
    expect(await sl.segSessionCost({ cost: { total_cost_usd: 'abc' } }, makeCtx())).toBeNull()
  })
})

describe('segDailyCost', () => {
  test('日次コストを通貨で表示する', async () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost), {
      date: sl.today(env),
      sessions: { s1: 1 },
      accumulated: 2,
    })
    const data = { cost: { total_cost_usd: 1.5 }, session_id: 's1' }
    expect(await sl.segDailyCost(data, makeCtx({ env }))).toBe(
      `${sl.ICONS_EMOJI.money} $2.50 (daily)`,
    )
  })

  test('累積が 0 以下、または cost が無ければ null', async () => {
    const env = makeEnv()
    const first = { cost: { total_cost_usd: 1 }, session_id: 's1' }
    expect(await sl.segDailyCost(first, makeCtx({ env }))).toBeNull()
    expect(await sl.segDailyCost({}, makeCtx())).toBeNull()
  })

  test('JPY なら ¥ で表示する', async () => {
    const env = makeEnv()
    writeJson(sl.cachePath(env, sl.CACHE_FILES.exchange), {
      _cached_at: NOW,
      data: 150,
      currency: 'JPY',
      date: sl.today(env),
    })
    writeJson(sl.cachePath(env, sl.CACHE_FILES.dailyCost), {
      date: sl.today(env),
      sessions: { s1: 0 },
      accumulated: 0,
    })
    const data = { cost: { total_cost_usd: 1.23 }, session_id: 's1' }
    expect(await sl.segDailyCost(data, makeCtx({ currency: 'JPY', env }))).toContain('¥184')
  })
})
