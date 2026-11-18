// ja-style-guard: off

import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blockMessage,
  checkDescription,
  checkNotation,
  checkVocabulary,
  consumeHidden,
  displayPayload,
  englishLines,
  hideEnglishLines,
  inspect,
  inspectDisplay,
  inspectReply,
  inspectStop,
  stopPayload,
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

test('checkNotation は角括弧の内側の列挙の半角カンマを検知しない', () => {
  expect(checkNotation('[10分, 30分] の一様分布で待つ')).toEqual([])
})

test('checkNotation は docstring と番号付きリストのラベル区切りの em ダッシュを検知しない', () => {
  expect(
    checkNotation('"""api モジュールのテスト — 保存した実レスポンスのパースを検証する。"""'),
  ).toEqual([])
  expect(checkNotation('2. **dryrun でレポート生成** — 以下を出力する')).toEqual([])
})

test('checkNotation は表のセルだけの em ダッシュを検知しない', () => {
  expect(checkNotation('| `filePath` | 対応 | — | 限定 |')).toEqual([])
})

test('checkVocabulary は漢字に続く回を熟語として検知しない', () => {
  expect(checkVocabulary('機体が旋回する')).toEqual([])
  expect(checkVocabulary('発言を撤回した')).toEqual([])
  expect(checkVocabulary('何回したか数える')).toEqual([])
})

test('checkVocabulary は年月日時分秒の直前の数字を境界の違反にしない', () => {
  expect(checkVocabulary('2000年1月1日に始める')).toEqual([])
  expect(checkVocabulary('5秒後')).toEqual([])
  expect(checkVocabulary('10分待つ')).toEqual([])
})

test('checkVocabulary は年月日時分秒以外の助数詞の直前の数字は境界の違反にする', () => {
  expect(checkVocabulary('3回押す').join('')).toContain('境界')
  expect(checkVocabulary('162バイト読む').join('')).toContain('境界')
})

test('checkVocabulary は真因と配線を造語として警告する', () => {
  expect(checkVocabulary('真因を特定する').join('')).toContain('真因')
  expect(checkVocabulary('モジュール間の配線を確認する').join('')).toContain('配線')
})

test('englishLines は英語の文の行を返す', () => {
  expect(englishLines('Now confirm the dialog with 決定.')).toEqual([
    'Now confirm the dialog with 決定.',
  ])
  expect(
    englishLines(
      'I ran one quest with the support in slot 3, and ギルガメッシュ gained +9,713 while オリオン gained +8,146.',
    ),
  ).toHaveLength(1)
  expect(englishLines('Let me check the tests.')).toEqual(['Let me check the tests.'])
})

test('englishLines は機能語が少なくても句読点で終わる 2 語以上の行を英語の文とみなす', () => {
  expect(englishLines('Checking the file.')).toEqual(['Checking the file.'])
  expect(englishLines('Next, update the hook:')).toEqual(['Next, update the hook:'])
  expect(englishLines('Menu closed. Start state B comparison.')).toHaveLength(1)
  expect(englishLines('Tests passed.')).toEqual(['Tests passed.'])
  expect(englishLines('Launch 7.2.16 now.')).toEqual(['Launch 7.2.16 now.'])
})

test('englishLines は識別子とファイル名のラベル行を英語の文とみなさない', () => {
  expect(englishLines('- **fgo.py**:')).toEqual([])
  expect(englishLines('- **preset-fade**:')).toEqual([])
  expect(englishLines('- **ja-style-guard.ts**:')).toEqual([])
  expect(englishLines('- **control.h（2229 行）:**')).toEqual([])
})

test('englishLines は日本語の語句を含んでも英語が大半を占める行を英語の文とみなす', () => {
  expect(
    englishLines(
      "Next, I'll write the two spec decisions from the 実機確認 35 振り分け (Syphon の 2 個目, 変動する初期値) as an md and send it.",
    ),
  ).toHaveLength(1)
})

test('englishLines は日本語の応答に混ざった英語の行だけを返す', () => {
  const text = '設定を確認しました。\nNow I will update the README.\n次に進みます。'
  expect(englishLines(text)).toEqual(['Now I will update the README.'])
})

test('englishLines は識別子やパスや固有名の多い日本語の行を英語の文とみなさない', () => {
  expect(
    englishLines('Memory の参照切れと不一致を直すため、置換スクリプトを書いて一括で適用します。'),
  ).toEqual([])
  expect(
    englishLines(
      '`fgo.py` の party --swap 2:5 で並びを変え、D:\\projects\\fgo\\modkit\\scripts\\ops\\fgo.py の結果を https://api.atlasacademy.io/nice/JP/quest/94150847/1 と比べました。',
    ),
  ).toEqual([])
  expect(englishLines('Claude in Chrome と Adobe for creativity を使います。')).toEqual([])
  expect(englishLines('Claude in Chrome と Adobe for creativity の比較。')).toEqual([])
  expect(englishLines('from oldValue to newValue に変更。')).toEqual([])
  expect(englishLines('The Lord of the Rings の比較。')).toEqual([])
  expect(englishLines('- Claude in Chrome と Adobe for creativity の比較')).toEqual([])
  expect(englishLines('Claude in Chrome と Adobe for creativity のレビュー')).toEqual([])
  expect(englishLines('Claude in Chrome と Adobe for creativity の比較！')).toEqual([])
  expect(englishLines('Adobe for creativity と Claude in Chrome')).toEqual([])
  expect(englishLines('Adobe for creativity（Claude in Chrome との比較）')).toEqual([])
  expect(englishLines('Adobe for creativity (Claude in Chrome との比較)')).toEqual([])
})

test('englishLines は英語が主の括弧を英文の一部として判定する', () => {
  expect(englishLines('(Note: the build is still running.)')).toHaveLength(1)
  expect(englishLines('Now 大手門 (伊織 required + 1 own max, NPC 2).')).toHaveLength(1)
})

test('englishLines は日本語のラベルを含む英文を英語の文とみなす', () => {
  expect(englishLines('Please press the はい button to continue.')).toHaveLength(1)
  expect(englishLines('Now click the はい button.')).toHaveLength(1)
  expect(englishLines('I will select 決定')).toHaveLength(1)
  expect(englishLines('I will run the tests。')).toHaveLength(1)
  expect(englishLines('I will inspect `設定`')).toHaveLength(1)
  expect(englishLines('I will inspect 「設定」')).toHaveLength(1)
})

test('englishLines は機能語を含まない行と句読点で終わらない名前の行を英語の文とみなさない', () => {
  expect(englishLines('PreToolUse PostToolUse Stop MessageDisplay')).toEqual([])
  expect(englishLines('- Claude Code for VS Code')).toEqual([])
  expect(englishLines('- **k1-generator-a**: K1 の PR A')).toEqual([])
  expect(englishLines('Done.')).toEqual([])
})

test('englishLines はコードブロックとインラインコードと引用を判定しない', () => {
  expect(
    englishLines('次のとおりです。\n```sh\n# Install the deps and run the tests.\nbun test\n```'),
  ).toEqual([])
  expect(englishLines('`git commit -m "fix the bug in the parser"` を実行します。')).toEqual([])
  expect(englishLines('> The stored message is untouched by the hook.')).toEqual([])
  expect(englishLines('- 誤: 「Now I will add the test for the limit.」')).toEqual([])
  expect(
    englishLines('- [Moving from WinMM to WMS](https://microsoft.github.io/MIDI/kb/x/)'),
  ).toEqual([])
  expect(englishLines('- 出力: "All tests passed and the build is green"')).toEqual([])
})

test('englishLines は入れ子のフェンスとチルダのフェンスの内側を判定しない', () => {
  const nested = '例です。\n````md\n```sh\n# Install the deps and run the tests.\n```\n````'
  expect(englishLines(nested)).toEqual([])
  expect(englishLines('~~~sh\n# Install the deps and run the tests.\n~~~')).toEqual([])
  expect(englishLines('```sh\nbun test\n```\nLet me check the output.')).toEqual([
    'Let me check the output.',
  ])
})

test('englishLines は箇条書きの中のフェンスの内側を判定せず その後の英語の文を判定する', () => {
  const listed = '- ```sh\n  # Install the deps and run the tests.\n  ```\nLet me check the output.'
  expect(englishLines(listed)).toEqual(['Let me check the output.'])
  expect(englishLines('1. ```sh\n   # Install the deps and run the tests.\n   ```')).toEqual([])
})

test('englishLines はコードブロックの中の箇条書きの記号付きのフェンスで閉じない', () => {
  const inner = '```md\n- ```\n# Install the deps and run the tests.\n```\nLet me check the output.'
  expect(englishLines(inner)).toEqual(['Let me check the output.'])
})

test('englishLines は強調や行末のパスの後ろの句読点でも文末とみなす', () => {
  expect(englishLines('**Checking the file.**')).toHaveLength(1)
  expect(englishLines('Updating tests in src/foo.ts.')).toHaveLength(1)
})

test('hideEnglishLines は英語の文の行を除いた表示内容と除いた行数を返す', () => {
  expect(hideEnglishLines('Let me check the tests.\n確認します。\n', null)).toEqual({
    content: '確認します。\n',
    hidden: 1,
  })
  expect(hideEnglishLines('Let me check the tests.\n', null)).toEqual({ content: '', hidden: 1 })
})

test('hideEnglishLines はコードブロックの内側から始まる差分のコードを残す', () => {
  const delta = '# Install the deps and run the tests.\n```\nLet me check the output.\n'
  expect(hideEnglishLines(delta, { char: '`', length: 3 })?.content).toBe(
    '# Install the deps and run the tests.\n```\n',
  )
  const nested = '```\n# Install the deps and run the tests.\n````\nLet me check the output.\n'
  expect(hideEnglishLines(nested, { char: '`', length: 4 })?.content).toBe(
    '```\n# Install the deps and run the tests.\n````\n',
  )
})

test('hideEnglishLines は除く行が無ければ null を返す', () => {
  expect(hideEnglishLines('確認します。\n', null)).toBeNull()
})

// 隠した行数の記録を置く一時ディレクトリで fn を実行する
function withStateDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ja-style-state-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true })
  }
}

// 1 回の入力の中の hook の payload に共通する値
const turn = { session_id: 's-1', prompt_id: 'p-1' }

// 英語の 1 行を MessageDisplay で隠す
const hideLetMeCheck = (dir: string, ids: Record<string, string> = turn) =>
  inspectDisplay(
    { ...ids, message_id: `m-${ids.prompt_id}`, index: 0, delta: 'Let me check.\n' },
    dir,
  )

test('inspectDisplay はコードブロックの開閉を前の差分から引き継いで英語の文を隠す', () => {
  withStateDir((dir) => {
    const display = (index: number, delta: string, final = false) =>
      inspectDisplay({ ...turn, message_id: 'm-1', index, delta, final }, dir, 0)
    expect(display(0, '確認します。\n```sh\n')).toBeNull()
    expect(
      display(1, '# Install the deps and run the tests.\nbun test\n```\nLet me check.\n'),
    ).toBe('# Install the deps and run the tests.\nbun test\n```\n')
    expect(display(2, '', true)).toBeNull()
  })
})

test('inspectDisplay は隠した行数を入力ごとに足して記録する', () => {
  withStateDir((dir) => {
    inspectDisplay({ ...turn, message_id: 'm-1', index: 0, delta: 'Let me check.\n' }, dir)
    inspectDisplay(
      { ...turn, message_id: 'm-2', index: 0, delta: 'Now run it.\nAnd the tests.\n' },
      dir,
    )
    inspectDisplay(
      { session_id: 's-2', prompt_id: 'p-9', message_id: 'm-3', index: 0, delta: '確認します。\n' },
      dir,
    )
    expect(consumeHidden(dir, turn)).toBe(3)
    expect(consumeHidden(dir, turn)).toBe(0)
    expect(consumeHidden(dir, { session_id: 's-2', prompt_id: 'p-9' })).toBe(0)
  })
})

test('consumeHidden は公開前の記録を消費せず 消費の後に書かれた記録を次の消費に残す', () => {
  withStateDir((dir) => {
    const unpublished = join(dir, 's-1.p-1.english.m-9-0.tmp')
    writeFileSync(unpublished, '5')
    expect(consumeHidden(dir, turn)).toBe(0)
    expect(readdirSync(dir)).toContain('s-1.p-1.english.m-9-0.tmp')
    hideLetMeCheck(dir)
    expect(consumeHidden(dir, turn)).toBe(1)
    hideLetMeCheck(dir)
    expect(consumeHidden(dir, turn)).toBe(1)
  })
})

test('inspectDisplay は前の差分が読めない場合と不正な message_id を元の表示に任せる', () => {
  withStateDir((dir) => {
    expect(
      inspectDisplay({ ...turn, message_id: 'm-2', index: 1, delta: 'Let me check.\n' }, dir, 0),
    ).toBeNull()
    expect(
      inspectDisplay({ ...turn, message_id: '../m', index: 0, delta: 'Let me check.\n' }, dir, 0),
    ).toBeNull()
    expect(consumeHidden(dir, turn)).toBe(0)
  })
})

test('consumeHidden は不正な session_id と prompt_id を扱わない', () => {
  withStateDir((dir) => {
    expect(consumeHidden(dir, { session_id: '../s', prompt_id: 'p-1' })).toBe(0)
    expect(consumeHidden(dir, { session_id: 's-1', prompt_id: '../p' })).toBe(0)
    expect(consumeHidden(dir, {})).toBe(0)
  })
})

test('inspectReply は直前に英語の文を隠していればツール呼び出しを一度だけ差し止める', () => {
  withStateDir((dir) => {
    expect(inspectReply(turn, dir)).toBeNull()
    hideLetMeCheck(dir)
    const reason = inspectReply(turn, dir)
    expect(reason).toContain('1 行')
    expect(reason).toContain('ツールを呼び直す前に')
    expect(reason).toContain('日本語の敬体')
    expect(reason).toContain('前置き')
    expect(reason).not.toContain('Let me check')
    expect(inspectReply(turn, dir)).toBeNull()
  })
})

test('inspectReply は前の入力で隠した英語の行を次の入力に持ち越さない', () => {
  withStateDir((dir) => {
    hideLetMeCheck(dir)
    expect(inspectReply({ session_id: 's-1', prompt_id: 'p-2' }, dir)).toBeNull()
  })
})

test('inspectReply はサブエージェントの呼び出しで本体の記録を消費しない', () => {
  withStateDir((dir) => {
    hideLetMeCheck(dir)
    expect(inspectReply({ ...turn, agent_id: 'a1' }, dir)).toBeNull()
    expect(inspectReply(turn, dir)).toContain('1 行')
  })
})

test('inspectDisplay は処理中の印を処理の後に消す', () => {
  withStateDir((dir) => {
    hideLetMeCheck(dir)
    expect(readdirSync(dir).filter((name) => name.includes('.pending-'))).toEqual([])
  })
})

test('inspectReply は処理中の MessageDisplay が記録を書き終えるまで待ってから消費する', () => {
  withStateDir((dir) => {
    // 並行する MessageDisplay の hook を別プロセスで再現する (印を置き 150 ms 後に記録して印を消す)
    const pending = join(dir, 's-1.pending-m-1-0')
    writeFileSync(pending, '')
    const record = join(dir, 's-1.p-1.english.m-1-0')
    Bun.spawn([
      process.execPath,
      '-e',
      `Bun.sleepSync(150); require('node:fs').writeFileSync(${JSON.stringify(record)}, '1'); require('node:fs').rmSync(${JSON.stringify(pending)})`,
    ])
    expect(inspectReply(turn, dir)).toContain('1 行')
  })
})

test('inspectReply は古い処理中の印を待たない', () => {
  withStateDir((dir) => {
    const pending = join(dir, 's-1.pending-m-1-0')
    writeFileSync(pending, '')
    const past = new Date(Date.now() - 60_000)
    utimesSync(pending, past, past)
    const started = Date.now()
    expect(inspectReply(turn, dir)).toBeNull()
    expect(Date.now() - started).toBeLessThan(300)
  })
})

test('inspectStop は last_assistant_message の英語の文で書き直しを求める', () => {
  withStateDir((dir) => {
    const reason = inspectStop(
      { ...turn, last_assistant_message: 'Now the edits are applied to the file.' },
      dir,
    )
    expect(reason).toContain('日本語の敬体')
    expect(reason).toContain('前置き')
    expect(reason).not.toContain('Now the edits')
    expect(JSON.parse(stopPayload(reason ?? ''))).toEqual({
      decision: 'block',
      reason: blockMessage(reason ?? ''),
    })
  })
})

test('inspectStop は記録された英語の行でも書き直しを求め 記録を消費する', () => {
  withStateDir((dir) => {
    hideLetMeCheck(dir)
    expect(inspectStop({ ...turn, last_assistant_message: '編集を反映しました。' }, dir)).toContain(
      '1 行',
    )
    expect(consumeHidden(dir, turn)).toBe(0)
  })
})

test('inspectStop は日本語の応答を許可する', () => {
  withStateDir((dir) => {
    expect(inspectStop({ ...turn, last_assistant_message: '編集を反映しました。' }, dir)).toBeNull()
  })
})

test('inspectStop は書き直しも英語なら差し止め 1 回の入力で 2 回までに限る', () => {
  withStateDir((dir) => {
    const english = { ...turn, last_assistant_message: 'Let me check the tests.' }
    expect(inspectStop(english, dir)).toContain('1 行')
    expect(inspectStop({ ...english, stop_hook_active: true }, dir)).toContain('1 行')
    expect(inspectStop({ ...english, stop_hook_active: true }, dir)).toBeNull()
    // 次の入力では数え直す
    expect(inspectStop({ ...english, prompt_id: 'p-2' }, dir)).toContain('1 行')
  })
})

test('inspectDisplay は Stop の差し止めが上限に達した入力の応答を隠さずに表示する', () => {
  withStateDir((dir) => {
    const english = { ...turn, last_assistant_message: 'Let me check the tests.' }
    inspectStop(english, dir)
    inspectStop({ ...english, stop_hook_active: true }, dir)
    expect(hideLetMeCheck(dir)).toBeNull()
    expect(consumeHidden(dir, turn)).toBe(0)
    expect(inspectStop({ ...english, stop_hook_active: true }, dir)).toBeNull()
    // 次の入力では再び隠す
    expect(hideLetMeCheck(dir, { ...turn, prompt_id: 'p-2' })).toBe('')
  })
})

test('inspectDisplay は書き直しを求める記録を残せない不正な prompt_id の応答を隠さない', () => {
  withStateDir((dir) => {
    const display = { message_id: 'm-1', index: 0, delta: 'Let me check.\n' }
    expect(inspectDisplay({ ...display, session_id: 's-1', prompt_id: '../p' }, dir)).toBeNull()
  })
})

test('displayPayload は表示の置き換えを MessageDisplay の出力として組み立てる', () => {
  expect(JSON.parse(displayPayload(''))).toEqual({
    hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: '' },
  })
})

// hook をプロセスとして起動し 終了コードと出力を返す
async function runHook(payload: unknown) {
  const script = join(import.meta.dir, '..', '.claude', 'hooks', 'ja-style-guard.ts')
  const child = Bun.spawn([process.execPath, script], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test('MessageDisplay で英語の文を隠すと 次の PreToolUse がツール呼び出しを exit 2 で差し止める', async () => {
  const id = `test-${Date.now()}`
  const stateDir = join(homedir(), '.cache', 'ja-style-guard')
  try {
    const display = await runHook({
      hook_event_name: 'MessageDisplay',
      session_id: id,
      prompt_id: id,
      message_id: id,
      index: 0,
      final: true,
      delta: 'Let me check the tests.\n確認します。\n',
    })
    expect(display.code).toBe(0)
    expect(JSON.parse(display.stdout).hookSpecificOutput.displayContent).toBe('確認します。\n')

    const tool = await runHook({
      hook_event_name: 'PreToolUse',
      session_id: id,
      prompt_id: id,
      tool_name: 'Bash',
      tool_input: { command: 'ls', description: 'ファイル一覧を表示' },
    })
    expect(tool.code).toBe(2)
    expect(tool.stderr).toContain('[ja-style-guard:block]')
    expect(tool.stderr).toContain('ツールを呼び直す前に')
  } finally {
    for (const name of readdirSync(stateDir).filter((name) => name.startsWith(id))) {
      rmSync(join(stateDir, name), { recursive: true, force: true })
    }
  }
})
