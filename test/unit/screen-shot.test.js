'use strict';
// Recorte de tela (E7-T7.1): Mac pelo screencapture do sistema (caminho completo, argumentos sem shell, arquivo gerado
// pelo app; Esc = nada), Windows pela Ferramenta de Captura + área de transferência (um timer, até 30 s, ignora a imagem
// que já estava lá). Arquivo 0600 em anexos/, pendente até Enviar/Cancelar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const S = require('../../app/main/screen-shot');
const attachments = require('../../app/main/attachments');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));

// área de transferência de mentira: imagem = { id }; readImage devolve algo com a "cara" de NativeImage
function fakeClip(initial = null) {
  const c = { img: initial, reads: 0,
    availableFormats: () => (c.img ? ['image/png'] : ['text/plain']),
    readBuffer: (f) => (f === 'PNG' && c.img && !c.noPng ? Buffer.concat([PNG, Buffer.from(String(c.img))]) : Buffer.alloc(0)),
    readImage: () => { c.reads++; const id = c.img; return { isEmpty: () => !id, id, toPNG: () => PNG, getSize: () => c.size || { width: 10, height: 10 } }; } };
  return c;
}
const fp = (img) => (img && !img.isEmpty() ? img.id : null);
function fakeTimers() {
  const t = { list: new Map(), seq: 0, setInterval: (fn) => { const id = ++t.seq; t.list.set(id, fn); return id; }, clearInterval: (id) => t.list.delete(id), tick: () => { for (const fn of [...t.list.values()]) fn(); } };
  return t;
}

test('Windows: vigia acha a imagem NOVA (não a que já estava) e para o único timer', async () => {
  const clip = fakeClip('velha'); const timers = fakeTimers(); let now = 0;
  const w = S.watchClipboard({ clipboard: clip, before: S.cheapSig(clip).sig, timers, fp, now: () => now });
  assert.equal(timers.list.size, 1);
  for (let i = 0; i < 10; i++) timers.tick();         // só a velha: continua esperando, SEM decodificar nada
  assert.equal(clip.reads, 0, 'a imagem que já estava lá nunca é decodificada');
  clip.img = 'nova'; now = 2000; timers.tick();
  const img = await w.promise;
  assert.equal(img.id, 'nova'); assert.equal(clip.reads, 1, 'uma decodificação: a da imagem nova'); assert.equal(timers.list.size, 0, 'timer parado');
  timers.tick(); assert.equal(timers.list.size, 0);
  assert.ok(S.TICK_MS >= 700);
});

test('Windows: sem o formato PNG para comparar, decodifica só a cada 3 voltas; imagem gigante (cabeçalho ou tamanho) é ignorada', async () => {
  const clip = fakeClip('velha'); clip.noPng = true; const timers = fakeTimers(); let now = 0;
  const w = S.watchClipboard({ clipboard: clip, before: S.cheapSig(clip).sig, beforeFp: 'velha', timers, fp, now: () => now });
  for (let i = 0; i < 9; i++) timers.tick();
  assert.equal(clip.reads, 3, '9 voltas → 3 decodificações (antes: 9)');
  clip.img = 'nova'; for (let i = 0; i < 3; i++) timers.tick();
  assert.equal((await w.promise).id, 'nova');
  // PNG com cabeçalho de 20000×20000 (400 MP): ignorado sem decodificar
  const big = fakeClip(null); const t2 = fakeTimers(); now = 0;
  const w2 = S.watchClipboard({ clipboard: big, before: S.cheapSig(big).sig, timers: t2, fp, now: () => now });
  const ihdr = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr); ihdr.write('IHDR', 12, 'latin1'); ihdr.writeUInt32BE(20000, 16); ihdr.writeUInt32BE(20000, 20);
  big.img = 'gigante'; big.readBuffer = () => ihdr; t2.tick();
  assert.equal(big.reads, 0, 'não decodificou');
  now = 30000; t2.tick(); assert.equal(await w2.promise, null);
  // sem PNG, mas decodificada com tamanho absurdo: ignorada
  const big2 = fakeClip(null); big2.noPng = true; const t3 = fakeTimers(); now = 0;
  const w3 = S.watchClipboard({ clipboard: big2, before: S.cheapSig(big2).sig, timers: t3, fp, now: () => now });
  big2.img = 'g2'; big2.size = { width: 10000, height: 10000 }; t3.tick();
  now = 30000; t3.tick(); assert.equal(await w3.promise, null);
});

test('Windows: sem imagem em 30 s → nada (e o timer some); cancelar também para', async () => {
  const clip = fakeClip(null); const timers = fakeTimers(); let now = 0;
  const w = S.watchClipboard({ clipboard: clip, timers, fp, now: () => now });
  timers.tick(); assert.equal(clip.reads, 0, 'sem imagem não lê nada');
  now = 30000; timers.tick();
  assert.equal(await w.promise, null); assert.equal(timers.list.size, 0);
  const w2 = S.watchClipboard({ clipboard: clip, timers, fp });
  w2.cancel(); assert.equal(await w2.promise, null); assert.equal(timers.list.size, 0);
  assert.equal(S.WATCH_MS, 30000);
});

test('Mac: screencapture pelo caminho completo, -i -x, arquivo gerado pelo app em anexos/; Esc = nada', async () => {
  const dir = tmp(); const calls = [];
  try {
    const mk = (write) => new S.ScreenShot({ win: false, reserve: () => attachments.reserve(dir), adopt: attachments.adopt,
      exec: (bin, args, opts, cb) => { calls.push({ bin, args, opts }); if (write) fs.writeFileSync(args[2], PNG, { mode: 0o644 }); setImmediate(cb); return { kill() {} }; } });
    const r = await mk(true).capture('t1');
    assert.equal(calls[0].bin, '/usr/sbin/screencapture'); assert.deepEqual(calls[0].args.slice(0, 2), ['-i', '-x']);
    const file = calls[0].args[2];
    assert.ok(file.startsWith(dir + path.sep) && /\d{4}-\d{2}-\d{2}[\\/][0-9a-f]{8}\.png$/.test(file), file);
    assert.ok(calls[0].opts.timeout > 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, '0600 depois de adotar');
    assert.ok(r.token && r.termId === 't1');
    assert.equal(await mk(false).capture('t1'), null, 'Esc: sem arquivo, nada acontece');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Mac: arquivo que não é imagem é apagado e recusado', async () => {
  const dir = tmp();
  try {
    const sh = new S.ScreenShot({ win: false, reserve: () => attachments.reserve(dir), adopt: attachments.adopt,
      exec: (_b, args, _o, cb) => { fs.writeFileSync(args[2], 'não sou png'); setImmediate(cb); return {}; } });
    let f = null; sh.reserve = () => (f = attachments.reserve(dir));
    await assert.rejects(sh.capture('t1'), /imagem válida/);
    assert.ok(!fs.existsSync(f));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows: abre a Ferramenta de Captura e salva o recorte em anexos/; Enviar entrega, Cancelar apaga', async () => {
  const dir = tmp(); const clip = fakeClip('velha'); const opened = [];
  try {
    const sh = new S.ScreenShot({ win: true, clipboard: clip, save: (buf) => attachments.save(dir, buf),
      openExternal: async (u) => { opened.push(u); setTimeout(() => { clip.img = 'recorte'; }, 50); } });
    clip.readImage = ((orig) => () => { const i = orig(); i.getSize = () => ({ width: 10, height: 10 }); i.resize = () => ({ toBitmap: () => Buffer.from(String(i.id)) }); return i; })(clip.readImage);
    const r = await sh.capture('t9');
    assert.deepEqual(opened, ['ms-screenclip:']);
    const p = sh.take(r.token);
    assert.equal(p.termId, 't9'); assert.ok(fs.existsSync(p.file)); assert.equal(fs.statSync(p.file).mode & 0o777, 0o600);
    assert.throws(() => sh.take(r.token), /expirou/, 'token de uso único');
    clip.img = 'outro';
    const r2 = await sh.capture('t9');
    const f2 = sh.pending.get(r2.token).file;
    assert.equal(sh.discard(r2.token), true); assert.ok(!fs.existsSync(f2), 'cancelar apaga');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('um recorte por vez; pendentes com teto e prazo (arquivo apagado)', async () => {
  const dir = tmp(); let now = 0;
  try {
    const sh = new S.ScreenShot({ smokeImage: async () => PNG, save: (b) => attachments.save(dir, b), now: () => now });
    const toks = []; for (let i = 0; i < 6; i++) toks.push((await sh.capture('t')).token);
    assert.equal(sh.pending.size, 4);
    now = 11 * 60 * 1000; await sh.capture('t'); assert.equal(sh.pending.size, 1, 'velhos expiram');
    const all = fs.readdirSync(dir).flatMap(d => fs.readdirSync(path.join(dir, d)));
    assert.equal(all.length, 1, 'arquivos dos descartados apagados');
    sh.busy = true; await assert.rejects(sh.capture('t'), (e) => e.code === 'BUSY');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ao sair, recortes que ficaram na prévia são apagados', async () => {
  const dir = tmp();
  try {
    const sh = new S.ScreenShot({ smokeImage: async () => PNG, save: (b) => attachments.save(dir, b) });
    await sh.capture('t'); await sh.capture('t');
    const files = [...sh.pending.values()].map(p => p.file);
    sh.dropAll();
    assert.equal(sh.pending.size, 0); for (const f of files) assert.equal(fs.existsSync(f), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
