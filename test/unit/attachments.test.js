'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const att = require('../../app/main/attachments');
const meter = require('../../app/main/context-meter');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000105fe02fea70000000049454e44ae426082', 'hex');

test('CP-7: imagem vira arquivo 0600 em anexos/AAAA-MM-DD; não-imagem e grande demais são recusadas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anexos-'));
  const f = att.save(dir, PNG);
  assert.match(f, /\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}\.png$/);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.throws(() => att.save(dir, Buffer.from('#!/bin/sh\nrm -rf ~')), (e) => e.code === 'INVALID');
  assert.throws(() => att.save(dir, Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)])), /grande demais/);
  assert.ok(att.fromBase64(dir, PNG.toString('base64')).endsWith('.png'));
  assert.throws(() => att.fromBase64(dir, 'A'.repeat(15 * 1024 * 1024)), /grande demais/);
  assert.throws(() => att.fromBase64(dir, '<script>'), /inválida/);
});

test('limpeza apaga pastas com mais de 14 dias e mantém as recentes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anexos-'));
  const now = Date.parse('2026-11-20T12:00:00Z');
  for (const d of ['2026-11-01', '2026-11-10', 'nao-e-data']) { fs.mkdirSync(path.join(dir, d)); fs.writeFileSync(path.join(dir, d, 'x.png'), PNG); }
  assert.equal(att.cleanup(dir, now), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-11-10', 'nao-e-data']);
});

test('CP-8: medidor soma o usage da última resposta e só lê transcrição de ~/.claude/projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cproj-'));
  fs.mkdirSync(path.join(root, 'x'));
  const f = path.join(root, 'x', 's.jsonl');
  const asst = (u, extra = {}) => JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: u }, ...extra });
  fs.writeFileSync(f, [asst({ input_tokens: 5, cache_read_input_tokens: 1000 }), JSON.stringify({ type: 'user', message: { content: 'oi' } }),
    asst({ input_tokens: 2, cache_creation_input_tokens: 24093, cache_read_input_tokens: 159630, output_tokens: 319 }),
    asst({ input_tokens: 999999 }, { isSidechain: true })].join('\n') + '\n');
  const m = meter.measure(f, { root, model: 'opus' });
  assert.equal(m.tokens, 2 + 24093 + 159630, 'mesma conta da barra do Claude (sem saída)');
  assert.equal(m.window, 1000000, 'Opus 5.x = 1 M'); assert.equal(m.pct, 18);
  fs.writeFileSync(f, asst({ input_tokens: 150000 }).replace('claude-opus-5-5', 'claude-haiku-4-5') + '\n');
  assert.equal(meter.measure(f, { root, model: 'haiku' }).window, 200000);
  assert.equal(meter.measure(f, { root, model: 'opus[1m]' }).window, 1000000);
  const fora = path.join(os.tmpdir(), 'fora.jsonl'); fs.writeFileSync(fora, asst({ input_tokens: 1 }));
  assert.equal(meter.measure(fora, { root }), null);
  assert.equal(meter.measure('/etc/passwd', { root }), null);
});

test('teto de pixels pelo cabeçalho (PNG, JPEG, GIF, WebP) antes de decodificar: acima de ~50 MP recusa e apaga', () => {
  const att = require('../../app/main/attachments');
  const fsx = require('fs'); const osx = require('os'); const px = require('path');
  const png = (w, h) => { const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const jpg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = (w, h) => { const b = Buffer.alloc(16); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
  const webpx = (w, h) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBPVP8X', 8, 'latin1'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
  assert.deepEqual(att.imageSize(png(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(att.imageSize(jpg(4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(att.imageSize(gif(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(att.imageSize(webpx(5000, 4000)), { width: 5000, height: 4000 });
  for (const b of [png(20000, 20000), jpg(60000, 60000), gif(65535, 65535), webpx(16000, 16000)]) assert.equal(att.tooManyPixels(b), true);
  for (const b of [png(7680, 4320), jpg(6000, 4000)]) assert.equal(att.tooManyPixels(b), false, 'tela 8K e foto de 24 MP passam');
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), 'anexo-px-'));
  try {
    assert.throws(() => att.save(dir, png(20000, 20000)), /50 megapixels/);
    const f = att.reserve(dir); fsx.writeFileSync(f, png(20000, 20000));
    assert.throws(() => att.adopt(f), /50 megapixels/); assert.equal(fsx.existsSync(f), false, 'apagado');
    const ok = att.reserve(dir); fsx.writeFileSync(ok, png(1920, 1080));
    assert.equal(att.adopt(ok), ok, 'recorte comum aceito');
    assert.equal(att.fitsForDecode(ok), true);
    const big = att.reserve(dir); fsx.writeFileSync(big, png(20000, 20000)); assert.equal(att.fitsForDecode(big), false);
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test('limpeza de anexos/ também com o app aberto: a cada 6 h, um timer só, parado ao sair', () => {
  const att = require('../../app/main/attachments');
  const fsx = require('fs'); const osx = require('os'); const px = require('path');
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), 'anexo-limpa-'));
  try {
    let now = Date.parse('2026-11-16T12:00:00Z');
    fsx.mkdirSync(px.join(dir, '2026-11-10')); fsx.writeFileSync(px.join(dir, '2026-11-10', 'a.png'), 'x');
    const timers = { fns: new Map(), n: 0, setInterval(fn, ms) { this.ms = ms; const id = ++this.n; this.fns.set(id, fn); return id; }, clearInterval(id) { this.fns.delete(id); }, tick() { for (const f of this.fns.values()) f(); } };
    const stop = att.scheduleCleanup(dir, { timers, now: () => now });
    assert.equal(timers.ms, 6 * 3600 * 1000); assert.equal(timers.fns.size, 1);
    timers.tick(); assert.ok(fsx.existsSync(px.join(dir, '2026-11-10')), '6 dias: fica');
    now += 9 * 86400000; timers.tick(); assert.ok(!fsx.existsSync(px.join(dir, '2026-11-10')), '15 dias com o app aberto: apagada');
    stop(); assert.equal(timers.fns.size, 0);
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});
