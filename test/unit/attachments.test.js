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
