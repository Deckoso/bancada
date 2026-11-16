// Imagens para o Claude (BP-2026-11-05-001 E4): print colado (⌘V) ou foto do celular vira arquivo em
// anexos/AAAA-MM-DD/<id>.<ext> (0600) e o caminho é colado no terminal. Só imagem de verdade (confere a assinatura).
// Limpeza: pastas com mais de 14 dias são apagadas ao abrir o app e, com ele aberto, a cada 6 h (um timer só).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 50 * 1000 * 1000;   // ~50 MP: acima disso a imagem nem é decodificada (teto de memória)
const KEEP_DAYS = 14;

function sniff(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// largura × altura lidas do cabeçalho (PNG IHDR, JPEG SOFn, GIF, WebP VP8/VP8L/VP8X), sem decodificar; null = não deu
function imageSize(buf) {
  try {
    const t = sniff(buf);
    if (t === 'png') return buf.length >= 24 && buf.subarray(12, 16).toString('latin1') === 'IHDR' ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
    if (t === 'gif') return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null;
    if (t === 'webp') {
      const kind = buf.subarray(12, 16).toString('latin1');
      if (kind === 'VP8X' && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
      if (kind === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (t === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
  } catch {}
  return null;
}
function tooManyPixels(buf) { const d = imageSize(buf); return !!d && d.width * d.height > MAX_PIXELS; }
const PIXELS_MSG = 'imagem grande demais (máx. 50 megapixels)';

function bad(msg, code = 'INVALID') { const e = new Error(msg); e.code = code; return e; }

function save(dir, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('imagem vazia');
  if (buf.length > MAX_BYTES) throw bad('imagem grande demais (máx. 20 MB)');
  const ext = sniff(buf);
  if (!ext) throw bad('isso não é uma imagem PNG, JPG, GIF ou WebP');
  if (tooManyPixels(buf)) throw bad(PIXELS_MSG);
  const day = new Date().toISOString().slice(0, 10);
  const d = path.join(dir, day);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const file = path.join(d, `${crypto.randomUUID().slice(0, 8)}.${ext}`);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return file;
}

// v0.8 recorte de tela: caminho novo (gerado aqui, nunca vindo da página) para um programa do sistema gravar a imagem
function reserve(dir, ext = 'png') {
  const day = new Date().toISOString().slice(0, 10);
  const d = path.join(dir, day);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return path.join(d, `${crypto.randomUUID().slice(0, 8)}.${ext}`);
}
// adota o arquivo que o programa gravou: imagem de verdade, até 20 MB, 0600. Senão apaga e recusa.
function adopt(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) { try { fs.unlinkSync(file); } catch {} if (st.isFile()) throw bad('imagem grande demais (máx. 20 MB)'); return null; }
  let buf; try { buf = fs.readFileSync(file); } catch { return null; }
  if (!buf.length) { try { fs.unlinkSync(file); } catch {} return null; }
  if (buf.length > MAX_BYTES || !sniff(buf)) { try { fs.unlinkSync(file); } catch {} throw bad(buf.length > MAX_BYTES ? 'imagem grande demais (máx. 20 MB)' : 'o recorte não gerou uma imagem válida'); }
  if (tooManyPixels(buf)) { try { fs.unlinkSync(file); } catch {} throw bad(PIXELS_MSG); }
  fs.chmodSync(file, 0o600);
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

// miniatura segura: só decodifica se o cabeçalho disser que cabe no teto
function fitsForDecode(file) { try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(256 * 1024); const n = fs.readSync(fd, b, 0, b.length, 0); const head = b.subarray(0, n); return !!sniff(head) && !tooManyPixels(head); } finally { fs.closeSync(fd); } } catch { return false; } }

// limpeza periódica com o app aberto (fechar a janela só esconde a Bancada): um intervalo, unref, parado ao sair
const CLEAN_EVERY_MS = 6 * 3600 * 1000;
function scheduleCleanup(dir, { every = CLEAN_EVERY_MS, timers = { setInterval, clearInterval }, now = Date.now } = {}) {
  const t = timers.setInterval(() => { try { cleanup(dir, now()); } catch {} }, every);
  if (t && t.unref) t.unref();
  return () => timers.clearInterval(t);
}

module.exports = { save, fromBase64, cleanup, scheduleCleanup, CLEAN_EVERY_MS, sniff, reserve, adopt, imageSize, tooManyPixels, fitsForDecode, MAX_BYTES, MAX_PIXELS };
