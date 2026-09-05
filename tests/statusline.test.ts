import { describe, expect, test } from 'bun:test'
import * as sl from '../.claude/scripts/statusline'

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
