'use strict';
// Motor de voz (E6): WAV conferido, texto limpo (sem Enter nem escape), argumentos sem shell e com caminho relativo,
// um processo por frase com o arquivo temporário 0600 apagado, download só do Hugging Face por HTTPS, retomável, e
// NUNCA aceito com SHA-256 diferente.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const crypto = require('crypto');
const V = require('../../app/main/voice');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voz-'));
const pcm = (sec) => Buffer.alloc(Math.round(sec * 16000) * 2, 1);

test('WAV: só PCM 16 kHz mono 16 bits, até 60 s; o arquivo do disco é remontado', () => {
  const w = V.wavFile(pcm(2));
  const r = V.parseWav(w);
  assert.equal(r.seconds, 2); assert.equal(r.pcm.length, 64000);
  assert.ok(V.parseWav(new Uint8Array(w)).seconds === 2, 'Uint8Array da tela');
  const stereo = Buffer.from(w); stereo.writeUInt16LE(2, 22);
  assert.throws(() => V.parseWav(stereo), /formato/);
  const rate = Buffer.from(w); rate.writeUInt32LE(44100, 24);
  assert.throws(() => V.parseWav(rate), /formato/);
  assert.throws(() => V.parseWav(Buffer.from('nada disso é wav, nada mesmo, nada mesmo mesmo')), /inválido/);
  assert.throws(() => V.parseWav(V.wavFile(pcm(62))), /longo demais/);
  assert.throws(() => V.parseWav('x'), /inválido/);
});

test('texto: sem marcas do whisper, sem quebra de linha nem caractere de controle', () => {
  assert.equal(V.cleanText(' [BLANK_AUDIO] '), '');
  assert.equal(V.cleanText('roda os testes\ne faz o commit\r\n'), 'roda os testes e faz o commit');
  assert.equal(V.cleanText('a\x1b[201~b\x03c\u2028d'), 'a [201~b c d');
  assert.equal(V.cleanText('(Música) olá [Música]'), 'olá');
  assert.ok(V.cleanText('x'.repeat(9000)).length <= 4000);
});

test('argumentos: sem shell, caminhos relativos, pt fixo; Windows com contexto proporcional', () => {
  const a = V.whisperArgs({ model: 'm.bin', wav: path.join('tmp', 'a.wav'), prompt: 'Bancada, npm test', seconds: 10, win: false, nThreads: 8 });
  assert.deepEqual(a, ['-m', 'm.bin', '-f', path.join('tmp', 'a.wav'), '-l', 'pt', '-nt', '-np', '-t', '8', '--prompt', 'Bancada, npm test']);
  const w = V.whisperArgs({ model: 'm.bin', wav: 'tmp/a.wav', prompt: '', seconds: 10, win: true, nThreads: 4 });
  assert.deepEqual(w.slice(-4), ['-ac', '640', '-mc', '0']);
  assert.equal(V.audioCtx(10), 640); assert.equal(V.audioCtx(60), 1500); assert.equal(V.audioCtx(0.5) % 64, 0);
  assert.equal(V.threads(true, 12), 6); assert.equal(V.threads(false, 10), 8); assert.equal(V.threads(true, 2), 2);
});

test('vocabulário do projeto: nome e nome da pasta, sem caminho completo, com teto', () => {
  const p = V.buildPrompt({ project: 'Meu App', dirs: ['/Users/fulano/código/meu-app'] });
  assert.match(p, /^Meu App, meu-app, Bancada/); assert.doesNotMatch(p, /fulano/);
  assert.ok(V.buildPrompt({ project: 'x'.repeat(900) }).length <= 400);
  assert.match(V.buildPrompt({ project: 'A', files: ['app/main/hooks.js', 'src\\x.ts'] }), /^A, hooks\.js, x\.ts, /);
});

test('binário: empacotado em Resources/whisper; em desenvolvimento em build/whisper/<sistema>', () => {
  assert.equal(V.binPath({ win: false, packaged: true, resourcesPath: '/A/Resources' }), path.join('/A/Resources', 'whisper', 'whisper-cli'));
  assert.equal(V.binPath({ win: true, packaged: false, appRoot: '/r' }), path.join('/r', 'build', 'whisper', 'win', 'whisper-cli.exe'));
  assert.equal(V.binPath({ win: false, packaged: false, appRoot: '/r' }), path.join('/r', 'build', 'whisper', 'mac', 'whisper-cli'));
});

test('Windows: runtime do Visual C++ conferido em System32', () => {
  const have = new Set(['C:\\Windows\\System32\\vcruntime140.dll', 'C:\\Windows\\System32\\msvcp140.dll']);
  const r = V.vcRuntime('C:\\Windows', (f) => have.has(f));
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['vcruntime140_1.dll', 'vcomp140.dll']);
  assert.match(r.url, /^https:\/\/aka\.ms\//);
  assert.equal(V.vcRuntime('C:\\Windows', () => true).ok, true);
});

test('modelos: URL fixa do Hugging Face oficial e SHA-256 fixo (o do relatório)', () => {
  assert.equal(V.MODELS.turbo.sha256, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2');
  assert.equal(V.MODELS.turbo.size, 574041195);
  assert.equal(V.MODELS.small.sha256, 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb');
  for (const m of Object.values(V.MODELS)) assert.match(m.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\//);
  for (const h of ['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co']) assert.ok(V.HF_HOST.test(h), h);
  for (const h of ['huggingface.co.evil.com', 'evilhuggingface.co', 'hf.co.evil', 'github.com', 'x.hf.co.evil.com']) assert.ok(!V.HF_HOST.test(h), h);
});

// servidor HTTP local fazendo o papel do Hugging Face (com Range e redirecionamento)
function fakeHF(content, { lie = false } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ url: req.url, range: req.headers.range || null });
    if (req.url === '/redir') { res.writeHead(302, { Location: '/m.bin' }); return res.end(); }
    if (req.url === '/fora') { res.writeHead(302, { Location: 'http://outro.exemplo/m.bin' }); return res.end(); }
    const body = lie ? Buffer.from(content).fill(7, 10, 20) : content;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) { const s = Number(m[1]); res.writeHead(206, { 'Content-Length': body.length - s }); return res.end(body.subarray(s)); }
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
function fakeModels(base, content, file = '/m.bin') {
  return { turbo: { id: 'turbo', file: 'm.bin', size: content.length, url: base + file, sha256: crypto.createHash('sha256').update(content).digest('hex'), label: 't' } };
}

test('download: baixa, confere o SHA-256 e só então vira o arquivo final; progresso informado', async () => {
  const content = crypto.randomBytes(300000);
  const f = await fakeHF(content); const dir = tmpdir(); const prog = [];
  try {
    const v = new V.Voice({ dir, bin: '/nao/existe', models: fakeModels(f.base, content, '/redir'), transport: http, insecure: true, allowHost: (h) => h === '127.0.0.1', onProgress: (p) => prog.push(p.phase) }).setup();
    assert.deepEqual(await v.download(), { ok: true });
    assert.ok(fs.readFileSync(path.join(dir, 'm.bin')).equals(content));
    assert.equal(fs.statSync(path.join(dir, 'm.bin')).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(dir, 'm.bin.part')));
    assert.ok(v.isVerified()); assert.ok(prog.includes('pronto'));
    assert.deepEqual(await v.download(), { ok: true, already: true }, 'já conferido: não baixa de novo');
    const st = v.status(); assert.equal(st.model.verified, true); assert.equal(st.binary, false);
  } finally { f.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download: SHA-256 diferente = recusado e apagado (nunca usado)', async () => {
  const content = crypto.randomBytes(100000);
  const f = await fakeHF(content, { lie: true }); const dir = tmpdir();
  try {
    const v = new V.Voice({ dir, bin: '/x', models: fakeModels(f.base, content), transport: http, insecure: true, allowHost: () => true }).setup();
    await assert.rejects(v.download(), (e) => e.code === 'BAD_HASH');
    assert.ok(!fs.existsSync(path.join(dir, 'm.bin')) && !fs.existsSync(path.join(dir, 'm.bin.part')));
    assert.equal(v.isVerified(), false);
    await assert.rejects(v.ready(), (e) => e.code === 'NO_BINARY' || e.code === 'NO_MODEL');
  } finally { f.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download: continua de onde parou (Range) e confere o arquivo inteiro', async () => {
  const content = crypto.randomBytes(200000);
  const f = await fakeHF(content); const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'm.bin.part'), content.subarray(0, 120000));
    const v = new V.Voice({ dir, bin: '/x', models: fakeModels(f.base, content), transport: http, insecure: true, allowHost: () => true }).setup();
    await v.download();
    assert.equal(f.hits[0].range, 'bytes=120000-');
    assert.ok(fs.readFileSync(path.join(dir, 'm.bin')).equals(content));
  } finally { f.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download: só HTTPS e só o Hugging Face (redirecionamento para fora é recusado)', async () => {
  const content = crypto.randomBytes(1000);
  const f = await fakeHF(content); const dir = tmpdir();
  try {
    const plain = new V.Voice({ dir, bin: '/x', models: fakeModels(f.base, content), transport: http, allowHost: () => true }).setup();
    await assert.rejects(plain.download(), /HTTPS/);
    const fora = new V.Voice({ dir, bin: '/x', models: fakeModels(f.base, content, '/fora'), transport: http, insecure: true, allowHost: (h) => h === '127.0.0.1' }).setup();
    await assert.rejects(fora.download(), /não é o Hugging Face/);
    assert.ok(!fs.existsSync(path.join(dir, 'm.bin')));
  } finally { f.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transcrição: 1 processo por frase, WAV temporário 0600 relativo à pasta e apagado; uma por vez', async () => {
  const dir = tmpdir(); const content = Buffer.from('modelo de mentira');
  const models = fakeModels('https://huggingface.co', content);
  fs.writeFileSync(path.join(dir, 'm.bin'), content);
  const bin = path.join(dir, 'whisper-cli'); fs.writeFileSync(bin, '');
  const calls = []; let release = null;
  const exec = (file, args, opts, cb) => {
    const wav = path.join(opts.cwd, args[args.indexOf('-f') + 1]);
    calls.push({ file, args, opts, existed: fs.existsSync(wav), mode: fs.statSync(wav).mode & 0o777, header: fs.readFileSync(wav).subarray(0, 4).toString() });
    release = () => cb(null, ' roda os testes\n[BLANK_AUDIO]\n', '');
    if (calls.length === 1) release();
  };
  try {
    const v = new V.Voice({ dir, bin, models, exec, win: false }).setup();
    const r = await v.transcribe(V.wavFile(pcm(2)), { prompt: 'Bancada' });
    assert.equal(r.text, 'roda os testes'); assert.equal(r.seconds, 2);
    const c = calls[0];
    assert.equal(c.file, bin); assert.equal(c.opts.cwd, dir); assert.ok(c.existed); assert.equal(c.mode, 0o600); assert.equal(c.header, 'RIFF');
    assert.equal(c.args[c.args.indexOf('-m') + 1], 'm.bin', 'modelo relativo');
    assert.ok(!path.isAbsolute(c.args[c.args.indexOf('-f') + 1]), 'wav relativo');
    assert.ok(c.opts.timeout > 0 && c.opts.windowsHide);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'temporário apagado');
    // duas ao mesmo tempo: a segunda é recusada (nunca dois whisper juntos)
    const p1 = v.transcribe(V.wavFile(pcm(1)));
    await new Promise(r => setImmediate(r));
    await assert.rejects(v.transcribe(V.wavFile(pcm(1))), (e) => e.code === 'BUSY');
    release(); await p1;
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
    // fala curta demais: nem chama o motor
    const n = calls.length; assert.equal((await v.transcribe(V.wavFile(pcm(0.1)))).short, true); assert.equal(calls.length, n);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transcrição: falha do motor apaga o temporário e devolve erro em português', async () => {
  const dir = tmpdir(); const content = Buffer.from('m');
  fs.writeFileSync(path.join(dir, 'm.bin'), content); const bin = path.join(dir, 'w'); fs.writeFileSync(bin, '');
  const exec = (_f, _a, _o, cb) => cb(Object.assign(new Error('x'), { code: 3 }), '', 'erro interno');
  try {
    const v = new V.Voice({ dir, bin, models: fakeModels('https://huggingface.co', content), exec }).setup();
    await assert.rejects(v.transcribe(V.wavFile(pcm(1))), (e) => e.code === 'VOICE_FAILED' && /motor de voz falhou/.test(e.message));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('aquecimento: 1 s de silêncio uma vez por binário; a 1ª frase espera ele em vez de falhar', async () => {
  const dir = tmpdir(); const content = Buffer.from('m');
  fs.writeFileSync(path.join(dir, 'm.bin'), content); const bin = path.join(dir, 'w'); fs.writeFileSync(bin, '');
  let n = 0; const exec = (_f, _a, _o, cb) => { n++; setTimeout(() => cb(null, 'ok', ''), 30); };
  try {
    const v = new V.Voice({ dir, bin, models: fakeModels('https://huggingface.co', content), exec }).setup();
    const w = v.warmup();
    const r = await v.transcribe(V.wavFile(pcm(1)));
    assert.equal(await w, true); assert.equal(r.text, 'ok'); assert.equal(n, 2);
    assert.ok(v.isWarm()); assert.equal(await v.warmup(), false, 'já aquecido');
    // sobra de uma transcrição interrompida é limpa ao abrir
    fs.writeFileSync(path.join(dir, 'tmp', 'sobra.wav'), 'x'); v.setup();
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows: whisper roda com a pasta do PROGRAMA como pasta atual (nunca a de dados); acento → forma curta; sem forma curta, só se não houver .dll/.exe nos dados', async () => {
  const root = tmpdir(); const content = Buffer.from('m');
  const progDir = path.join(root, 'Programs', 'Bancada', 'resources', 'whisper'); fs.mkdirSync(progDir, { recursive: true });
  const bin = path.join(progDir, 'whisper-cli.exe'); fs.writeFileSync(bin, '');
  const mk = (dir, shortPath) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'm.bin'), content);
    const calls = []; const exec = (f, args, opts, cb) => { calls.push({ args, opts }); cb(null, 'ok', ''); };
    return { v: new V.Voice({ dir, bin, models: fakeModels('https://huggingface.co', content), exec, win: true, shortPath }).setup(), calls }; };
  try {
    // pasta de dados só com ASCII: caminhos absolutos, pasta atual = a do programa
    const a = mk(path.join(root, 'dados', 'voz'), async () => { throw new Error('não devia precisar'); });
    await a.v.transcribe(V.wavFile(pcm(1)));
    assert.equal(a.calls[0].opts.cwd, progDir);
    assert.equal(a.calls[0].args[a.calls[0].args.indexOf('-m') + 1], path.join(root, 'dados', 'voz', 'm.bin'));
    assert.ok(a.calls[0].args[a.calls[0].args.indexOf('-f') + 1].startsWith(path.join(root, 'dados', 'voz', 'tmp') + path.sep));
    // com acento: usa a forma curta (calculada 1×)
    let asked = 0; const acc = path.join(root, 'dadós', 'voz');
    const b = mk(acc, async () => { asked++; return path.join(root, 'DADOS~1', 'voz'); });
    await b.v.transcribe(V.wavFile(pcm(1))); await b.v.transcribe(V.wavFile(pcm(1)));
    assert.equal(asked, 1); assert.equal(b.calls[0].opts.cwd, progDir);
    assert.equal(b.calls[0].args[b.calls[0].args.indexOf('-m') + 1], path.join(root, 'DADOS~1', 'voz', 'm.bin'));
    // sem forma curta (8.3 desligado): pasta de dados como pasta atual, caminhos relativos — e recusa se houver código lá
    const c = mk(path.join(root, 'dadôs2', 'voz'), async () => null);
    await c.v.transcribe(V.wavFile(pcm(1)));
    assert.equal(c.calls[0].opts.cwd, path.join(root, 'dadôs2', 'voz')); assert.equal(c.calls[0].args[c.calls[0].args.indexOf('-m') + 1], 'm.bin');
    fs.writeFileSync(path.join(root, 'dadôs2', 'voz', 'ggml-cpu-x.dll'), 'x');
    await assert.rejects(c.v.transcribe(V.wavFile(pcm(1))), (e) => e.code === 'VOICE_FAILED' && /\.dll/.test(e.message));
    assert.equal(c.calls.length, 1, 'não rodou');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('marcador do modelo: vale só para o mesmo arquivo (tamanho/data) e a mesma versão do app; recheck refaz o SHA-256 uma vez', async () => {
  const dir = tmpdir(); const content = Buffer.from('modelo de mentira para conferir');
  const models = fakeModels('https://huggingface.co', content);
  fs.writeFileSync(path.join(dir, 'm.bin'), content);
  try {
    const v1 = new V.Voice({ dir, bin: path.join(dir, 'w'), models, appVersion: '0.8.0' }).setup();
    assert.equal(v1.isVerified(), false); assert.equal(await v1.recheck(), true); assert.equal(v1.isVerified(), true);
    assert.equal(await v1.recheck(), false, 'já conferido: não refaz');
    // app atualizado: o marcador da versão anterior não vale; confere de novo uma vez
    const v2 = new V.Voice({ dir, bin: path.join(dir, 'w'), models, appVersion: '0.8.1' }).setup();
    assert.equal(v2.isVerified(), false); assert.equal(await v2.recheck(), true); assert.equal(v2.isVerified(), true);
    // arquivo trocado com o MESMO tamanho: data mudou → não vale; o SHA-256 recusa e apaga
    const fake = Buffer.from(content); fake[0] ^= 1; fs.writeFileSync(path.join(dir, 'm.bin'), fake);
    fs.utimesSync(path.join(dir, 'm.bin'), new Date(), new Date(Date.now() + 5000));
    assert.equal(v2.isVerified(), false); assert.equal(await v2.recheck(), false); assert.equal(fs.existsSync(path.join(dir, 'm.bin')), false, 'modelo que não confere é apagado');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ao sair no meio de uma transcrição: o whisper é encerrado e o WAV apagado na hora', async () => {
  const dir = tmpdir(); const content = Buffer.from('m');
  fs.writeFileSync(path.join(dir, 'm.bin'), content); const bin = path.join(dir, 'w'); fs.writeFileSync(bin, '');
  let killed = 0; let cb = null;
  const exec = (_f, _a, _o, done) => { cb = done; return { kill: () => { killed++; done(Object.assign(new Error('morto'), { killed: true }), '', ''); } }; };
  try {
    const v = new V.Voice({ dir, bin, models: fakeModels('https://huggingface.co', content), exec }).setup();
    const p = v.transcribe(V.wavFile(pcm(1))).catch(e => e);
    await new Promise(r => setTimeout(r, 20));
    assert.ok(cb, 'whisper chamado'); assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 1, 'WAV no disco durante a transcrição');
    v.shutdown();
    assert.equal(killed, 1); assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'WAV apagado');
    assert.equal((await p).code, 'VOICE_FAILED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
