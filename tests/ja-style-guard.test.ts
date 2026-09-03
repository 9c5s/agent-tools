import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'bun:test'
import { checkDescription, checkNotation, checkVocabulary, inspect, warningPayload } from '../.claude/hooks/ja-style-guard'

test('checkDescription は日本語の description を許可する', () => {
  expect(checkDescription('Bash', { command: 'ls', description: 'ファイル一覧を表示' })).toBeNull()
})

test('checkDescription はカタカナのみの description を許可する', () => {
  expect(checkDescription('Bash', { command: 'bun test', description: 'テスト' })).toBeNull()
})

test('checkDescription は技術用語混じりの日本語を許可する', () => {
  expect(checkDescription('PowerShell', { command: 'gh pr view 1', description: 'PR #1 を確認' })).toBeNull()
})

test('checkDescription は英語のみの description を拒否する', () => {
  const reason = checkDescription('Bash', { command: 'ls', description: 'List files' })
  expect(reason).toContain('日本語で書き直す')
  expect(reason).toContain('List files')
})

test('checkDescription は日本語の約物だけを含む英文を拒否する', () => {
  expect(checkDescription('Bash', { command: 'ls', description: 'List files ・' })).toContain(
    '日本語で書き直す',
  )
  expect(checkDescription('Bash', { command: 'ls', description: 'APIーCLI bridge' })).toContain(
    '日本語で書き直す',
  )
})

test('checkDescription は Bash の description 欠落を拒否する', () => {
  expect(checkDescription('Bash', { command: 'ls' })).toContain('日本語のコマンド説明')
})

test('checkDescription は PowerShell の空白のみの description を欠落として拒否する', () => {
  expect(checkDescription('PowerShell', { command: 'ls', description: '  ' })).toContain(
    '日本語のコマンド説明',
  )
})

test('checkDescription は Bash 以外の description 欠落を許可する', () => {
  expect(checkDescription('Read', { file_path: 'x.ts' })).toBeNull()
})

test('checkDescription は Bash 以外でも英語の description は拒否する', () => {
  expect(checkDescription('Agent', { prompt: 'x', description: 'Investigate logs' })).toContain(
    '日本語で書き直す',
  )
})

test('checkDescription は tool_input が無くても異常終了しない', () => {
  expect(checkDescription('Read', undefined)).toBeNull()
  expect(checkDescription(undefined, null)).toBeNull()
})

test('checkNotation は日本語文中の半角ピリオドを検知する', () => {
  expect(checkNotation('この関数は値を返す.').join('')).toContain('句読点')
})

test('checkNotation は日本語文中の半角カンマを検知する', () => {
  expect(checkNotation('値を検証し, 結果を返す').join('')).toContain('句読点')
})

test('checkNotation はファイル拡張子の半角ピリオドを検知しない', () => {
  expect(checkNotation('設定は config.json に置く')).toEqual([])
})

test('checkNotation は英文だけの行を検知しない', () => {
  expect(checkNotation('Read the file. Then write it.')).toEqual([])
})

test('checkVocabulary は日英境界のスペース抜けを警告する', () => {
  expect(checkVocabulary('2回目の実行で再現する').join('')).toContain('半角スペース')
})

test('checkNotation は日英境界のスペース抜けをブロック理由にしない', () => {
  expect(checkNotation('2回目の実行で再現する')).toEqual([])
})

test('checkVocabulary は半角スペースのある日英境界を警告しない', () => {
  expect(checkVocabulary('2 回目の実行で config.json を読む')).toEqual([])
})

test('checkNotation は日本語の地の文の em ダッシュを検知する', () => {
  expect(checkNotation('この方式——分割して扱う方法——を採る').join('')).toContain('ダッシュ')
})

test('checkNotation は英文だけの行の em ダッシュを検知しない', () => {
  expect(checkNotation('Curry—Howard correspondence')).toEqual([])
})

test('checkNotation は複数の中黒による並列を検知する', () => {
  expect(checkNotation('太字・矢印・中黒を直す').join('')).toContain('中黒')
})

test('checkNotation は中黒が 1 つだけの行を検知しない', () => {
  expect(checkNotation('アイドルマスター・シンデレラガールズを起動する')).toEqual([])
})

test('checkVocabulary は擬人化した動詞を検知する', () => {
  expect(checkVocabulary('接続が落ちる場合がある').join('')).toContain('落ちる')
})

test('checkVocabulary は「落ち着く」を擬人化として検知しない', () => {
  expect(checkVocabulary('値が落ち着くまで待つ')).toEqual([])
})

test('checkVocabulary は「見落とし」を擬人化として検知しない', () => {
  expect(checkVocabulary('境界条件の見落としがある')).toEqual([])
})

test('checkVocabulary は LLM っぽい前置きを検知する', () => {
  expect(checkVocabulary('重要なのは順序である').join('')).toContain('重要なのは')
})

test('checkVocabulary は過剰な丁寧語を検知する', () => {
  expect(checkVocabulary('確認いたします').join('')).toContain('いたします')
})

test('checkVocabulary は英文だけの行を検知しない', () => {
  expect(checkVocabulary('This will fall back to the default handler')).toEqual([])
})

test('checkNotation は Markdown のコードブロックの中を検査しない', () => {
  const text = ['変更の内容を書く', '```', '出力: 2回目の試行.', '```'].join('\n')
  expect(checkNotation(text)).toEqual([])
})

test('checkVocabulary は Markdown のコードブロックの中を検査しない', () => {
  const text = ['変更の内容を書く', '```', 'エラー: 接続が落ちる', '```'].join('\n')
  expect(checkVocabulary(text)).toEqual([])
})

test('inspect は description の日本語判定をブロック理由にする', () => {
  expect(inspect('Bash', { command: 'ls', description: 'List files' }).block).toContain(
    '日本語で書き直す',
  )
})

test('inspect は Write の内容の表記違反をブロック理由にする', () => {
  const result = inspect('Write', { file_path: 'a.md', content: '実行の結果を記録する.' })
  expect(result.block).toContain('句読点')
})

test('inspect は日英境界のスペース抜けを警告にとどめる', () => {
  const result = inspect('Write', { file_path: 'a.md', content: '2回目の実行を記録する' })
  expect(result.block).toBeNull()
  expect(result.warn.join('')).toContain('半角スペース')
})

test('inspect は Write の内容の語彙を警告にとどめる', () => {
  const result = inspect('Write', { file_path: 'a.md', content: '接続が落ちる場合の処理' })
  expect(result.block).toBeNull()
  expect(result.warn.join('')).toContain('落ちる')
})

test('inspect は Edit の new_string を検査する', () => {
  const result = inspect('Edit', {
    file_path: 'a.md',
    old_string: 'x',
    new_string: '接続が落ちる場合',
  })
  expect(result.warn.join('')).toContain('落ちる')
})

test('inspect は Edit の old_string を検査しない', () => {
  const result = inspect('Edit', {
    file_path: 'a.md',
    old_string: '接続が落ちる場合',
    new_string: '接続が切断される場合',
  })
  expect(result.warn).toEqual([])
})

test('inspect は Read のような対象外のツールを検査しない', () => {
  const result = inspect('Read', { file_path: 'a.md' })
  expect(result.block).toBeNull()
  expect(result.warn).toEqual([])
})

test('inspect は除外マーカーのある内容を検査しない', () => {
  const result = inspect('Write', {
    file_path: 'a.md',
    content: '<!-- ja-style-guard: off -->\n2回目の実行で接続が落ちる',
  })
  expect(result.block).toBeNull()
  expect(result.warn).toEqual([])
})

test('inspect は除外マーカーのあるファイルへの Edit を検査しない', () => {
  const path = join(tmpdir(), `ja-style-guard-${Date.now()}.md`)
  writeFileSync(path, '<!-- ja-style-guard: off -->\n既存の内容\n', 'utf8')
  try {
    const result = inspect('Edit', {
      file_path: path,
      old_string: '既存の内容',
      new_string: '接続が落ちる場合',
    })
    expect(result.warn).toEqual([])
  } finally {
    rmSync(path)
  }
})

test('warningPayload は additionalContext を持つ PreToolUse の JSON を返す', () => {
  const payload = JSON.parse(warningPayload(['指摘 A', '指摘 B']))
  expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(payload.hookSpecificOutput.additionalContext).toContain('指摘 A')
  expect(payload.hookSpecificOutput.additionalContext).toContain('指摘 B')
})

test('warningPayload は permissionDecision を含めない', () => {
  const payload = JSON.parse(warningPayload(['指摘 A']))
  expect(payload.hookSpecificOutput.permissionDecision).toBeUndefined()
})
