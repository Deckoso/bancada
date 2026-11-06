// Imagens para o Claude (BP-2026-11-05-001 E4): print colado (⌘V) ou foto do celular vira arquivo em
// anexos/AAAA-MM-DD/<id>.<ext> (0600) e o caminho é colado no terminal. Só imagem de verdade (confere a assinatura).
// Limpeza: pastas com mais de 14 dias são apagadas ao abrir o app.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 20 * 1024 * 1024;
const KEEP_DAYS = 14;

function sniff(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function bad(msg, code = 'INVALID') { const e = new Error(msg); e.code = code; return e; }

function save(dir, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('imagem vazia');
  if (buf.length > MAX_BYTES) throw bad('imagem grande demais (máx. 20 MB)');
  const ext = sniff(buf);
  if (!ext) throw bad('isso não é uma imagem PNG, JPG, GIF ou WebP');
  const day = new Date().toISOString().slice(0, 10);
  const d = path.join(dir, day);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const file = path.join(d, `${crypto.randomUUID().slice(0, 8)}.${ext}`);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return file;
}

function fromBase64(dir, b64, maxBytes = 10 * 1024 * 1024) {
  if (typeof b64 !== 'string' || b64.length > Math.ceil(maxBytes / 3) * 4 + 8 || !/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw bad('imagem inválida ou grande demais (máx. 10 MB)');
  return save(dir, Buffer.from(b64, 'base64'));
}

function cleanup(dir, now = Date.now()) {
  let removed = 0;
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
    const t = Date.parse(e.name + 'T00:00:00Z');
    if (Number.isFinite(t) && now - t > KEEP_DAYS * 86400000) { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); removed++; }
  }
  return removed;
}

module.exports = { save, fromBase64, cleanup, sniff, MAX_BYTES };
