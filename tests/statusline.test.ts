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

  test('空のテキストでも壊れない', () => {
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

  test('無い、壊れている、オブジェクトでない場合は空のオブジェクト', () => {
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
