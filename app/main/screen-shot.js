// Recorte de tela → terminal (v0.8, E7-T7.1). Nunca passa pela Área de Trabalho: a imagem vai direto para
// <dados>/anexos/AAAA-MM-DD/<id>.png (0600, limpeza de 14 dias) e o caminho é colado no terminal sem Enter.
//  · Mac: /usr/sbin/screencapture -i -x <arquivo gerado aqui> (seletor do sistema; Esc = nenhum arquivo = nada acontece).
//    A permissão de Gravação de Tela é pedida em nome da Bancada (processo responsável); sem ela o sistema grava só o
//    papel de parede — a tela avisa.
//  · Windows: abre a Ferramenta de Captura (ms-screenclip:) e vigia a área de transferência por até 30 s, com UM timer,
//    comparando com a imagem que já estava lá (programa comum não recebe a resposta da Ferramenta nem sabe se cancelou).
// Antes de colar, a tela mostra a miniatura (Enviar / Cancelar): o arquivo fica pendente por um token.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { imageSize } = require('./attachments');
const MAX_PIXELS = 50 * 1000 * 1000;

const SCREENCAPTURE = '/usr/sbin/screencapture';
const SCREENCLIP_URI = 'ms-screenclip:';
const MAC_TIMEOUT_MS = 3 * 60 * 1000;
const WATCH_MS = 30000;
const TICK_MS = 700;               // ≥ 700 ms: a vigia não fica decodificando imagem sem parar
const MAX_PENDING = 4;
const PENDING_TTL_MS = 10 * 60 * 1000;

function bad(msg, code = 'INVALID') { const e = new Error(msg); e.code = code; return e; }

function macArgs(file) { return ['-i', '-x', file]; }

// impressão digital barata de uma imagem (tamanho + miniatura 32×32): "é outra imagem?" sem guardar a imagem
function fingerprint(img) {
  if (!img || img.isEmpty()) return null;
  const s = img.getSize();
  return `${s.width}x${s.height}:` + crypto.createHash('sha1').update(img.resize({ width: 32, height: 32 }).toBitmap()).digest('hex');
}

// assinatura BARATA do que está na área de transferência, sem decodificar imagem: lista de formatos + resumo dos bytes
// PNG (comprimidos) quando o programa que copiou registrou o formato "PNG" (a Ferramenta de Captura registra)
function cheapSig(clipboard) {
  let formats = ''; try { formats = clipboard.availableFormats().join('|'); } catch {}
  let png = null; try { png = clipboard.readBuffer ? clipboard.readBuffer('PNG') : null; } catch {}
  const has = !!(png && png.length);
  const digest = has ? `${png.length}:` + crypto.createHash('sha1').update(png.subarray(0, 65536)).update(png.subarray(Math.max(0, png.length - 65536))).digest('hex') : '';
  return { sig: `${formats}#${digest}`, png: has ? png : null, image: /image\//i.test(formats) || has };
}
const tooBig = (d) => !!d && d.width * d.height > MAX_PIXELS;

// vigia a área de transferência até chegar uma imagem DIFERENTE da que estava antes (ou estourar o prazo)
// → { promise: Promise<NativeImage|null>, cancel() }. Um único timer; para ao achar, ao estourar ou ao cancelar.
// Só decodifica quando a assinatura barata MUDA e há imagem. Exceção: sem o formato "PNG" para comparar e com a mesma
// lista de formatos de antes, decodifica a cada 3 voltas (~2 s) e compara a impressão digital com a de antes.
// Imagem acima de ~50 MP (pelo cabeçalho do PNG, ou pelo tamanho depois de decodificar) é ignorada.
function watchClipboard({ clipboard, before = null, beforeFp, interval = TICK_MS, timeout = WATCH_MS, timers = { setInterval, clearInterval }, fp = fingerprint, now = Date.now }) {
  let timer = null, done = null, n = 0; let last = before;
  const t0 = now();
  const decode = () => { let img; try { img = clipboard.readImage(); } catch { return null; } if (!img || img.isEmpty()) return null; try { if (tooBig(img.getSize())) return null; } catch {} return img; };
  const promise = new Promise((resolve) => {
    done = (v) => { if (timer) { timers.clearInterval(timer); timer = null; } const r = done; done = null; if (r) resolve(v); };
    timer = timers.setInterval(() => {
      if (!done) return;
      if (now() - t0 >= timeout) return done(null);
      n++;
      const c = cheapSig(clipboard);
      if (!c.image) { last = c.sig; return; }
      if (c.sig !== last) {
        last = c.sig;
        if (c.png && tooBig(imageSize(c.png))) return;          // gigante: nem decodifica
        const img = decode(); if (img) done(img);
        return;
      }
      if (c.png || n % 3) return;                                // mesma assinatura: nada novo
      if (beforeFp === undefined) { const b = decode(); beforeFp = b ? fp(b) : null; return; }   // só o caso sem "PNG"
      const img = decode(); const f = img && fp(img);
      if (f && f !== beforeFp) done(img);
    }, interval);
  });
  return { promise, cancel: () => { if (done) done(null); } };
}

class ScreenShot {
  // save(buf) → caminho · reserve() → caminho novo · adopt(file) → caminho|null · thumb(file) → { dataUrl, width, height }
  // smokeImage() → PNG (só no smoke: nada de seletor de verdade nem área de transferência)
  constructor({ win = process.platform === 'win32', exec, openExternal, clipboard, save, reserve, adopt, thumb, smokeImage = null, now = Date.now }) {
    Object.assign(this, { win, exec, openExternal, clipboard, save, reserve, adopt, thumb, smokeImage, now });
    this.busy = false; this.watch = null; this.child = null;
    this.pending = new Map();   // token → { file, termId, at }
  }

  async capture(termId) {
    if (this.busy) throw bad('já tem um recorte em andamento', 'BUSY');
    this.busy = true;
    try {
      const file = this.smokeImage ? this.save(await this.smokeImage()) : this.win ? await this._win() : await this._mac();
      if (!file) return null;
      this._expire();
      const token = crypto.randomUUID();
      this.pending.set(token, { file, termId, at: this.now() });
      while (this.pending.size > MAX_PENDING) this._drop(this.pending.keys().next().value);
      let size = 0; try { size = fs.statSync(file).size; } catch {}
      return { token, termId, kb: Math.round(size / 1024), ...(this.thumb ? this.thumb(file) : {}) };
    } finally { this.busy = false; this.watch = null; this.child = null; }
  }

  _mac() {
    const file = this.reserve();
    return new Promise((resolve, reject) => {
      this.child = this.exec(SCREENCAPTURE, macArgs(file), { timeout: MAC_TIMEOUT_MS }, () => {
        // Esc no seletor = sai sem arquivo; o código de saída não importa, só o arquivo
        try { resolve(this.adopt(file)); } catch (e) { reject(e); }
      });
    });
  }

  async _win() {
    // sem decodificar a imagem que já estava lá — exceto se não houver o formato "PNG" para comparar (uma vez só)
    const c0 = cheapSig(this.clipboard);
    let beforeFp = null;
    if (c0.image && !c0.png) { try { const img = this.clipboard.readImage(); beforeFp = img && !img.isEmpty() && !tooBig(img.getSize()) ? fingerprint(img) : null; } catch {} }
    this.watch = watchClipboard({ clipboard: this.clipboard, before: c0.sig, beforeFp });
    try { await this.openExternal(SCREENCLIP_URI); } catch (e) { this.watch.cancel(); throw bad('não deu para abrir a Ferramenta de Captura: ' + e.message); }
    const img = await this.watch.promise;
    return img ? this.save(img.toPNG()) : null;
  }

  // para o que estiver esperando (Windows: o vigia; Mac: o seletor)
  abort() {
    if (this.watch) this.watch.cancel();
    if (this.child) { try { this.child.kill(); } catch {} }
    return true;
  }

  // Enviar: devolve { termId, file } para colar; o arquivo fica (é o anexo)
  take(token) {
    this._expire();
    const p = this.pending.get(token);
    if (!p) throw bad('esse recorte expirou; faça de novo', 'EXPIRED');
    this.pending.delete(token);
    return p;
  }
  // Cancelar: apaga o arquivo
  discard(token) { return this._drop(token); }
  // ao sair: recortes que ficaram na prévia (nem Enviar nem Cancelar) são apagados
  dropAll() { for (const t of [...this.pending.keys()]) this._drop(t); }

  _drop(token) { const p = this.pending.get(token); if (!p) return false; this.pending.delete(token); try { fs.unlinkSync(p.file); } catch {} return true; }
  _expire() { const now = this.now(); for (const [t, p] of this.pending) if (now - p.at > PENDING_TTL_MS) this._drop(t); }
}

module.exports = { ScreenShot, watchClipboard, fingerprint, cheapSig, macArgs, SCREENCAPTURE, SCREENCLIP_URI, WATCH_MS, TICK_MS };
