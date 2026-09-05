// ja-style-guard: off

import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blockMessage,
  checkDescription,
  checkNotation,
  checkVocabulary,
  inspect,
  warningPayload,
} from '../.claude/hooks/ja-style-guard'

test('checkDescription は日本語の description を許可する', () => {
  expect(checkDescription('Bash', { command: 'ls', description: 'ファイル一覧を表示' })).toBeNull()
})

test('checkDescription はカタカナのみの description を許可する', () => {
  expect(checkDescription('Bash', { command: 'bun test', description: 'テスト' })).toBeNull()
})

test('checkDescription は技術用語混じりの日本語を許可する', () => {
  expect(
    checkDescription('PowerShell', { command: 'gh pr view 1', description: 'PR #1 を確認' }),
  ).toBeNull()
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

test('checkNotation は箇条書きのラベル区切りの em ダッシュを検知しない', () => {
  expect(checkNotation('- [規約](feedback_style.md) — 文体の規約')).toEqual([])
  expect(checkNotation('- 「変更内容を簡潔に」 — 冗長な語を刈る')).toEqual([])
})

test('checkNotation は箇条書きでも 2 倍ダッシュを検知する', () => {
  expect(checkNotation('- この方式——分割して扱う方法——を採る').join('')).toContain('ダッシュ')
})

test('checkNotation は箇条書きでない行の em ダッシュを検知する', () => {
  expect(checkNotation('この方式 — 分割して扱う方法 — を採る').join('')).toContain('ダッシュ')
})

test('checkNotation は複数の中黒による並列を検知する', () => {
  expect(checkNotation('太字・矢印・中黒を直す').join('')).toContain('中黒')
})

test('checkNotation は中黒が 1 つだけの行を検知しない', () => {
  expect(checkNotation('アイドルマスター・シンデレラガールズを起動する')).toEqual([])
})

test('checkNotation は離れた位置にある別語の中黒を並列として検知しない', () => {
  expect(
    checkNotation('応答は敬体（です・ます調）を基本とし、コメントは「だ・である調」で書く'),
  ).toEqual([])
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

test('checkVocabulary は「落とし穴」を擬人化として検知しない', () => {
  expect(checkVocabulary('運用でよくある落とし穴を挙げる')).toEqual([])
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

test('checkNotation はインラインコードの中を検査しない', () => {
  expect(checkNotation('書式は `項目: 値, 値, 値` のように並べる')).toEqual([])
  expect(checkNotation('引数は `f(self=攻撃側, command, side)` である')).toEqual([])
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

test('warningPayload は監査で追えるマーカーを先頭に付ける', () => {
  const payload = JSON.parse(warningPayload(['指摘 A']))
  expect(payload.hookSpecificOutput.additionalContext.startsWith('[ja-style-guard:warn]')).toBe(
    true,
  )
})

test('blockMessage は監査で追えるマーカーを先頭に付ける', () => {
  const message = blockMessage('中黒 (・) を日本語の並列で使わない')
  expect(message.startsWith('[ja-style-guard:block]')).toBe(true)
  expect(message).toContain('中黒')
})

test('warningPayload は permissionDecision を含めない', () => {
  const payload = JSON.parse(warningPayload(['指摘 A']))
  expect(payload.hookSpecificOutput.permissionDecision).toBeUndefined()
})

test('inspect は Bash の command を検査する', () => {
  const result = inspect('Bash', {
    command: 'echo "接続が落ちる" >> memo.md',
    description: 'メモに追記する',
  })
  expect(result.warn.join('')).toContain('落ちる')
})

test('inspect は PowerShell の command を検査する', () => {
  const result = inspect('PowerShell', {
    command: 'Set-Content memo.md "接続が落ちる"',
    description: 'メモを書き出す',
  })
  expect(result.warn.join('')).toContain('落ちる')
})

test('inspect は command の表記違反を警告にとどめる', () => {
  const result = inspect('Bash', {
    command: 'echo "実行の結果を記録する." >> memo.md',
    description: 'メモに追記する',
  })
  expect(result.block).toBeNull()
  expect(result.warn.join('')).toContain('句読点')
})

test('inspect は command の検索パターンでブロックしない', () => {
  const result = inspect('Bash', {
    command: 'grep "太字・矢印・中黒" doc.md',
    description: '表記を検索する',
  })
  expect(result.block).toBeNull()
})

test('checkVocabulary は設計文書で置換された口語動詞を検知する', () => {
  expect(checkVocabulary('設定が効く場合がある').join('')).toContain('効く')
  expect(checkVocabulary('順序が食い違う').join('')).toContain('食い違')
  expect(checkVocabulary('画面に載る値を確かめる').join('')).toContain('載る')
  expect(checkVocabulary('索引が壊れる').join('')).toContain('壊れる')
})

test('checkVocabulary は文書から除かれた口語動詞を検知する', () => {
  expect(checkVocabulary('リクエストを撃つ').join('')).toContain('撃つ')
  expect(checkVocabulary('ログを流す').join('')).toContain('流す')
  expect(checkVocabulary('処理が詰まる').join('')).toContain('詰まる')
  expect(checkVocabulary('設定が飛ぶ').join('')).toContain('飛ぶ')
})

test('checkVocabulary は LLM っぽい予告と総括を検知する', () => {
  expect(checkVocabulary('本章では設計を扱う').join('')).toContain('本章では')
  expect(checkVocabulary('まとめると次のとおりである').join('')).toContain('まとめると')
  expect(checkVocabulary('有効だと言えるだろう').join('')).toContain('言えるだろう')
})

test('checkVocabulary は地の文の矢印と等号を検知する', () => {
  expect(checkVocabulary('退避 → 削除 → 再導入の順に進める').join('')).toContain('矢印')
  expect(checkVocabulary('速度＝距離を時間で割った値である').join('')).toContain('＝')
})

test('checkVocabulary はコードブロックの矢印を検知しない', () => {
  const text = ['状態の遷移を書く', '```', 'idle → running → done', '```'].join('\n')
  expect(checkVocabulary(text)).toEqual([])
})

test('checkVocabulary は破壊と崩壊を口語動詞として検知しない', () => {
  expect(checkVocabulary('データを破壊する')).toEqual([])
  expect(checkVocabulary('構造が崩壊する')).toEqual([])
})

test('checkVocabulary は記載と流用を口語動詞として検知しない', () => {
  expect(checkVocabulary('経緯を記載する')).toEqual([])
  expect(checkVocabulary('設定を流用する')).toEqual([])
})

test('checkNotation は括弧の内側の列挙の半角カンマを検知しない', () => {
  expect(checkNotation('(幅, 高さ) を px で返す')).toEqual([])
  expect(checkNotation('いま押せるボタン一覧（idx, x,y, 階層パス, ラベル）')).toEqual([])
  expect(checkNotation('Min(値, 定数マスター STAR_RATE_MAX = 3000) でクリップする')).toEqual([])
})

test('checkNotation は括弧の外側の半角カンマは検知する', () => {
  expect(checkNotation('(幅, 高さ) を返し, 呼び出し元で使う').join('')).toContain('句読点')
})

test('checkNotation は日本語の直後の省略記号を検知しない', () => {
  expect(checkNotation('raw <文字列...>  任意のコマンド文字列を送る')).toEqual([])
})

test('checkNotation はコメント見出しのラベル区切りの em ダッシュを検知しない', () => {
  expect(checkNotation('// control.h — 制御ソケット: 画面状態を問い合わせる')).toEqual([])
  expect(checkNotation('# build_mod_arm64.py — Mod の APK を生成する')).toEqual([])
})

test('checkNotation はコメント行でも 2 倍ダッシュを検知する', () => {
  expect(checkNotation('// この方式——分割して扱う方法——を採る').join('')).toContain('ダッシュ')
})

test('checkVocabulary はエスケープシーケンスの直後の日本語を境界の違反にしない', () => {
  expect(checkVocabulary('print(f"\\n完了: {out}")')).toEqual([])
})

test('checkVocabulary は巡回と周回を口語動詞として検知しない', () => {
  expect(checkVocabulary('押すたびに表示が巡回する')).toEqual([])
  expect(checkVocabulary('同じクエストを周回する')).toEqual([])
})

test('checkVocabulary は「回す」を口語動詞として検知する', () => {
  expect(checkVocabulary('検証を回すための道具').join('')).toContain('回す')
  expect(checkVocabulary('行を使い回すプール式').join('')).toContain('回す')
})

test('checkVocabulary は欠落と合流と前倒しを口語動詞として検知しない', () => {
  expect(checkVocabulary('無ければ欠落として拒否する')).toEqual([])
  expect(checkVocabulary('既存の誘導に合流する')).toEqual([])
  expect(checkVocabulary('Task 1 を前倒しで進める')).toEqual([])
})

test('checkVocabulary は Python の定義名の内部の境界を警告しない', () => {
  expect(checkVocabulary('def test_期限内はTrueを返す(self) -> None:')).toEqual([])
  expect(
    checkVocabulary(
      '    def test_daily_budgetが実POST試行を打ち切る(self, tmp_path: Path) -> None:',
    ),
  ).toEqual([])
})

test('checkVocabulary は定義行でもコメントの境界は警告する', () => {
  expect(checkVocabulary('def run(self):  # fileを返す').join('')).toContain('境界')
})
