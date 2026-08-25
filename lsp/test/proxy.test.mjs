// proxy.mjs の要件テスト
// 検証対象の要件:
//   1. .cmd/.bat ラッパーの解決と起動 (Windows の spawn ENOENT 問題)
//   2. ファイル URI の正規形への統一 (didOpen とクエリ操作の形式不整合問題)
//   3. Content-Length のバイト精度処理 (文字数計算によるメッセージ破損問題)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LspMessageReader,
  frameMessage,
  normalizeUri,
  normalizeUrisDeep,
  resolveCommandWin32,
} from '../proxy.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const proxyPath = path.join(testDir, '..', 'proxy.mjs');
const stubPath = path.join(testDir, 'stub-server.mjs');

describe('normalizeUri', () => {
  test('didOpen 形式 (スラッシュ 2 つ + バックスラッシュ) を正規形に変換する', () => {
    assert.equal(
      normalizeUri('file://D:\\proj\\src\\main.ts'),
      'file:///D:/proj/src/main.ts',
    );
  });

  test('スラッシュ 2 つ + フォワードスラッシュを正規形に変換する', () => {
    assert.equal(normalizeUri('file://D:/proj/a.ts'), 'file:///D:/proj/a.ts');
  });

  test('正規形は変更しない (冪等性)', () => {
    assert.equal(normalizeUri('file:///D:/proj/a.ts'), 'file:///D:/proj/a.ts');
  });

  test('正規形に混入したバックスラッシュを変換する', () => {
    assert.equal(normalizeUri('file:///D:\\proj\\a.ts'), 'file:///D:/proj/a.ts');
  });

  test('UNC 形式 (authority 付き) は変更しない', () => {
    assert.equal(
      normalizeUri('file://server/share/a.ts'),
      'file://server/share/a.ts',
    );
  });

  test('file 以外の URI は変更しない', () => {
    assert.equal(normalizeUri('untitled:Untitled-1'), 'untitled:Untitled-1');
    assert.equal(normalizeUri('https://example.com/a'), 'https://example.com/a');
  });

  test('URI でない文字列は変更しない', () => {
    assert.equal(normalizeUri('C:\\proj\\a.ts'), 'C:\\proj\\a.ts');
  });
});

describe('normalizeUrisDeep', () => {
  test('ネスト構造内のすべての URI を変換し、その他の値を保持する', () => {
    const input = {
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri: 'file://C:\\a b\\x.ts', text: 'const a = 1;' },
        related: [{ uri: 'file://C:\\y.ts' }, 'file://C:\\z.ts'],
      },
      id: 42,
      flag: true,
      nothing: null,
    };
    assert.deepEqual(normalizeUrisDeep(input), {
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri: 'file:///C:/a b/x.ts', text: 'const a = 1;' },
        related: [{ uri: 'file:///C:/y.ts' }, 'file:///C:/z.ts'],
      },
      id: 42,
      flag: true,
      nothing: null,
    });
  });
});

describe('frameMessage', () => {
  test('Content-Length はマルチバイト本文のバイト長になる', () => {
    const framed = frameMessage({ text: 'あいう' });
    const body = Buffer.from(JSON.stringify({ text: 'あいう' }), 'utf8');
    assert.equal(
      framed.toString('utf8'),
      `Content-Length: ${body.byteLength}\r\n\r\n${body.toString('utf8')}`,
    );
  });
});

// バイト長で正しくフレーミングしたメッセージを作る
function frameByBytes(json) {
  return frameMessage(json);
}

// Claude Code の不具合を再現し、文字数 (UTF-16 コード単位) で誤ったフレーミングをする
function frameByChars(json) {
  const body = JSON.stringify(json);
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    Buffer.from(body, 'utf8'),
  ]);
}

describe('LspMessageReader', () => {
  test('正しいバイト数の ASCII メッセージを解析する', () => {
    const reader = new LspMessageReader();
    const messages = reader.push(frameByBytes({ id: 1, method: 'x' }));
    assert.deepEqual(messages, [{ id: 1, method: 'x' }]);
  });

  test('正しいバイト数のマルチバイトメッセージを解析する', () => {
    const reader = new LspMessageReader();
    const messages = reader.push(frameByBytes({ text: 'あいう漢字🎉' }));
    assert.deepEqual(messages, [{ text: 'あいう漢字🎉' }]);
  });

  test('文字数で誤計算された Content-Length を復元する', () => {
    const reader = new LspMessageReader();
    const broken = { method: 'didOpen', text: 'あいう漢字🎉のテキスト' };
    const messages = reader.push(frameByChars(broken));
    assert.deepEqual(messages, [broken]);
  });

  test('誤計算メッセージの後続メッセージも脱落しない', () => {
    const reader = new LspMessageReader();
    const first = { text: '日本語テキスト' };
    const second = { id: 2, method: 'next' };
    const messages = reader.push(
      Buffer.concat([frameByChars(first), frameByBytes(second)]),
    );
    assert.deepEqual(messages, [first, second]);
  });

  test('1 バイトずつ分割して供給しても解析できる', () => {
    const reader = new LspMessageReader();
    const expected = { text: 'あいう' };
    const framed = frameByChars(expected);
    const messages = [];
    for (const byte of framed) {
      messages.push(...reader.push(Buffer.from([byte])));
    }
    assert.deepEqual(messages, [expected]);
  });

  test('1 チャンク内の複数メッセージをすべて解析する', () => {
    const reader = new LspMessageReader();
    const messages = reader.push(
      Buffer.concat([frameByBytes({ id: 1 }), frameByBytes({ id: 2 })]),
    );
    assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
  });
});

describe('resolveCommandWin32', () => {
  // 検索対象のダミー実行ファイル群を一時ディレクトリに用意する
  function makeDirs(t, spec) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-resolve-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const dirs = {};
    for (const [dir, files] of Object.entries(spec)) {
      const abs = path.join(base, dir);
      fs.mkdirSync(abs);
      for (const file of files) fs.writeFileSync(path.join(abs, file), '');
      dirs[dir] = abs;
    }
    return dirs;
  }

  const PATHEXT = '.COM;.EXE;.BAT;.CMD';

  test('同一ディレクトリでは PATHEXT の順に解決する (.exe が .cmd に優先)', (t) => {
    const dirs = makeDirs(t, { a: ['foo.exe', 'foo.cmd'] });
    const resolved = resolveCommandWin32('foo', { PATH: dirs.a, PATHEXT });
    assert.equal(resolved, path.join(dirs.a, 'foo.exe'));
  });

  test('ディレクトリの順序が拡張子の順序に優先する', (t) => {
    const dirs = makeDirs(t, { a: ['foo.cmd'], b: ['foo.exe'] });
    const resolved = resolveCommandWin32('foo', {
      PATH: `${dirs.a};${dirs.b}`,
      PATHEXT,
    });
    assert.equal(resolved, path.join(dirs.a, 'foo.cmd'));
  });

  test('拡張子付きの指定はそのままの名前で解決する', (t) => {
    const dirs = makeDirs(t, { a: ['foo.cmd'] });
    const resolved = resolveCommandWin32('foo.cmd', { PATH: dirs.a, PATHEXT });
    assert.equal(resolved, path.join(dirs.a, 'foo.cmd'));
  });

  test('見つからない場合は入力をそのまま返す', () => {
    const resolved = resolveCommandWin32('no-such-cmd', { PATH: '', PATHEXT });
    assert.equal(resolved, 'no-such-cmd');
  });
});

// プロキシをサブプロセスとして起動し、スタブサーバーからのエコー応答を収集する
function runProxy(t, args, { input, env = {}, expectedEchoes = 1 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [proxyPath, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    t.after(() => child.kill());
    const chunks = [];
    const echoes = [];
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      reject(new Error(`応答待ちがタイムアウトした。stdout: ${Buffer.concat(chunks)}`));
    }, 15000);
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      // スタブは厳密なバイト長でフレーミングして応答するため、そのとおりに解析する
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const length = Number(
          /Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd))?.[1],
        );
        if (buffer.length < headerEnd + 4 + length) break;
        echoes.push(
          JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length)),
        );
        buffer = buffer.subarray(headerEnd + 4 + length);
      }
      if (echoes.length >= expectedEchoes) {
        clearTimeout(timer);
        resolve(echoes);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(input);
  });
}

describe('結合テスト (win32)', { skip: process.platform !== 'win32' }, () => {
  test('破損フレーミングと URI 不整合がプロキシで修正される', async (t) => {
    const broken = {
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file://C:\\proj\\日本語.ts',
          text: 'const 挨拶 = "こんにちは";',
        },
      },
    };
    const [echo] = await runProxy(t, [process.execPath, stubPath], {
      input: frameByChars(broken),
    });
    // スタブが厳密なバイト解析で受理できたこと自体がフレーミング修正の証明になる
    assert.equal(echo.echo.params.textDocument.uri, 'file:///C:/proj/日本語.ts');
    assert.equal(echo.echo.params.textDocument.text, 'const 挨拶 = "こんにちは";');
  });

  test('.cmd ラッパー経由でサーバーを起動できる', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cmd-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(dir, 'stubsrv.cmd'),
      `@echo off\r\nnode "${stubPath}" %*\r\n`,
    );
    const message = { id: 1, method: 'initialize' };
    const [echo] = await runProxy(t, ['stubsrv'], {
      input: frameByBytes(message),
      env: { PATH: `${dir};${process.env.PATH}` },
    });
    assert.deepEqual(echo.echo, message);
  });
});
