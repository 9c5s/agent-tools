#!/usr/bin/env node
// LSP stdio プロキシ
//
// Windows 上の Claude Code が LSP サーバーと通信できない 3 つの原因を修正する。
//   1. spawn() が npm の .cmd ラッパーを起動できず ENOENT になる
//      → PATH + PATHEXT で実体を解決し、.cmd/.bat のみ cmd.exe 経由で起動する
//   2. ファイル URI の形式が操作により不整合になる (file://D:\... と file:///D:/...)
//      → クライアント → サーバー方向の URI を正規形 file:///X:/... に統一する
//   3. Content-Length をバイト数ではなく文字数で誤計算し、マルチバイト文字を含む
//      メッセージが破損する
//      → 文字数解釈で本文を復元し、バイト長で再フレーミングする
//
// 非 Windows では実体コマンドを直接起動し、入出力を無変換で素通しする。
// サーバー → クライアント方向は全プラットフォームで素通しする (不具合は送信側のみ)。
//
// 使用方法: node proxy.mjs <実体コマンド> [引数...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

// file URI のドライブレターパスを正規形 file:///X:/... に統一する。
// authority 付き (UNC 等) や file 以外の URI は変更しない。
export function normalizeUri(value) {
  if (!value.startsWith('file://')) return value;
  const rest = value.slice('file://'.length).replace(/^\/+/, '');
  if (!/^[A-Za-z]:/.test(rest)) return value;
  return `file:///${rest.replaceAll('\\', '/')}`;
}

// JSON 値を再帰的に走査し、文字列値の URI をすべて正規化する
export function normalizeUrisDeep(value) {
  if (typeof value === 'string') return normalizeUri(value);
  if (Array.isArray(value)) return value.map(normalizeUrisDeep);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = normalizeUrisDeep(child);
    }
    return result;
  }
  return value;
}

// JSON 値を正しいバイト長の Content-Length でフレーミングする
export function frameMessage(json) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// クライアント → サーバー方向のメッセージリーダー。
// Content-Length をまず仕様どおりバイト長として解釈し、JSON にならない場合は
// 文字数 (UTF-16 コード単位) の誤計算とみなして本文を復元する。
export class LspMessageReader {
  #buffer = Buffer.alloc(0);

  get pendingBytes() {
    return this.#buffer.length;
  }

  // チャンクを追加し、確定したメッセージの JSON 値を配列で返す
  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];
    for (;;) {
      const message = this.#next();
      if (message === undefined) return messages;
      messages.push(message);
    }
  }

  #next() {
    const headerEnd = this.#buffer.indexOf(HEADER_SEPARATOR);
    if (headerEnd === -1) return undefined;
    const header = this.#buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      throw new Error(`Content-Length ヘッダーがない: ${JSON.stringify(header)}`);
    }
    const declared = Number(match[1]);
    const bodyStart = headerEnd + HEADER_SEPARATOR.length;

    // 文字数解釈でも本文は最低 declared バイトを要するため、揃うまで待つ
    if (this.#buffer.length < bodyStart + declared) return undefined;

    const byteSlice = this.#buffer.subarray(bodyStart, bodyStart + declared);
    const byteParsed = tryParseJson(byteSlice.toString('utf8'));
    if (byteParsed !== undefined) {
      this.#buffer = this.#buffer.subarray(bodyStart + declared);
      return byteParsed;
    }

    // 文字数誤計算として復元する。StringDecoder は完全な文字のみ返すため、
    // チャンク境界で分断されたマルチバイト文字を数え違えることはない。
    const decoded = new StringDecoder('utf8').write(this.#buffer.subarray(bodyStart));
    if (decoded.length < declared) return undefined;
    const text = decoded.slice(0, declared);
    const charParsed = tryParseJson(text);
    if (charParsed === undefined) {
      throw new Error(
        `本文をバイト解釈でも文字数解釈でも JSON として解析できない (Content-Length: ${declared})`,
      );
    }
    this.#buffer = this.#buffer.subarray(bodyStart + Buffer.byteLength(text, 'utf8'));
    return charParsed;
  }
}

// PATH + PATHEXT からコマンドの実体を解決する。見つからなければ入力を返す
export function resolveCommandWin32(command, env) {
  if (path.isAbsolute(command)) return command;
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const hasExtension = path.extname(command) !== '';
  // PATHEXT は慣例的に大文字だが、実ファイル名の慣例に合わせて小文字で連結する
  // (Windows のファイルシステムは大文字小文字を区別しない)
  const extensions = hasExtension
    ? ['']
    : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
        .map((extension) => extension.toLowerCase());
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return command;
}

// cmd.exe のコマンドラインとして引用する (引数はプラグイン設定由来の固定値である前提)
function quoteForCmd(value) {
  if (value === '') return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function spawnServer(command, args) {
  const stdio = ['pipe', 'pipe', 'inherit'];
  if (process.platform !== 'win32') {
    return spawn(command, args, { stdio });
  }
  const resolved = resolveCommandWin32(command, process.env);
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') {
    return spawn(resolved, args, { stdio });
  }
  // .cmd/.bat は実行ファイルではないため cmd.exe 経由で起動する
  const commandLine = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(' ');
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
    stdio,
    windowsVerbatimArguments: true,
  });
}

const logEnabled = process.env.LSP_PROXY_LOG === '1';
const logFile = path.join(process.cwd(), 'lsp-proxy.log');

function log(tag, data) {
  if (!logEnabled) return;
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${tag}\n${data}\n\n`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    console.error('使用方法: node proxy.mjs <実体コマンド> [引数...]');
    process.exit(2);
  }

  const child = spawnServer(command, args);
  child.on('error', (error) => {
    console.error(`LSP サーバーを起動できない: ${command}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === null ? 0 : 1));
  });
  // サーバー側が先に終了した際の EPIPE で異常終了しないようにする
  // (直後に exit ハンドラーがサーバーの終了コードで終了する)
  child.stdin.on('error', () => {});

  child.stdout.on('data', (chunk) => {
    log('server -> client', chunk);
    process.stdout.write(chunk);
  });

  if (process.platform !== 'win32') {
    // 素通しモード: 既知の不具合は Windows でのみ顕在化するため変換しない
    process.stdin.on('data', (chunk) => {
      log('client -> server (passthrough)', chunk);
      child.stdin.write(chunk);
    });
    process.stdin.on('end', () => child.stdin.end());
    return;
  }

  const reader = new LspMessageReader();
  process.stdin.on('data', (chunk) => {
    log('client -> server (raw)', chunk);
    let messages;
    try {
      messages = reader.push(chunk);
    } catch (error) {
      console.error(`LSP メッセージを解析できない: ${error.message}`);
      process.exit(1);
    }
    for (const message of messages) {
      const framed = frameMessage(normalizeUrisDeep(message));
      log('client -> server (fixed)', framed);
      child.stdin.write(framed);
    }
  });
  process.stdin.on('end', () => {
    if (reader.pendingBytes > 0) {
      console.error(`未解析の受信データが ${reader.pendingBytes} バイト残っている`);
    }
    child.stdin.end();
  });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
