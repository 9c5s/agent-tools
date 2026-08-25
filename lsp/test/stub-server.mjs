// 結合テスト用のスタブ言語サーバー
// LSP 仕様どおり Content-Length を厳密にバイト長として解析し、
// 受信した各メッセージを {"echo": <メッセージ>} で応答する。
// 解析はプロキシと独立に実装し、プロキシ出力の検証器として機能させる。
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const match = /Content-Length: (\d+)/i.exec(
      buffer.subarray(0, headerEnd).toString('ascii'),
    );
    if (!match) {
      process.exit(1);
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    const reply = Buffer.from(JSON.stringify({ echo: JSON.parse(body) }), 'utf8');
    process.stdout.write(`Content-Length: ${reply.byteLength}\r\n\r\n`);
    process.stdout.write(reply);
  }
});
