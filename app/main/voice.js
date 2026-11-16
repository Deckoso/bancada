// Voz → texto no terminal (v0.8, E6). Motor local: whisper.cpp (whisper-cli) embutido no app + modelo baixado sob demanda.
// Fluxo: a tela grava (PCM 16 kHz mono) → WAV em memória → aqui: confere o WAV, grava num arquivo temporário em
// <dados>/voz/tmp (0600), roda UM whisper-cli por frase (processo filho, argumentos sem shell, sem porta), lê o texto do
// stdout e apaga o arquivo. Nada fica carregado entre frases (~0,85 GB só durante ~1,5 s no Mac).
// Modelo: só do Hugging Face oficial (URL fixa), HTTPS, retomável, e só é usado se o SHA-256 bater com o fixo daqui.
// Mac: caminhos passados ao whisper-cli são RELATIVOS à pasta voz/ (cwd).
// Windows: a pasta atual do whisper-cli é a pasta DO PROGRAMA (só leitura, em Programs), nunca a pasta de dados — o ggml
// procura as DLLs de backend também na pasta atual. Os caminhos vão absolutos; como o programa recebe os argumentos na
// página de código antiga, um caminho com acento vai na forma curta 8.3. Sem forma curta (8.3 desligado no disco), cai
// na pasta de dados como pasta atual, mas só se não houver nenhum .dll/.exe nela.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const plat = require('./platform');

const MODELS = Object.freeze({
  turbo: Object.freeze({ id: 'turbo', file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', label: 'Preciso (≈ 550 MB)' }),
  small: Object.freeze({ id: 'small', file: 'ggml-small-q5_1.bin', size: 190085487,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb', label: 'Rápido, menos preciso (≈ 180 MB)' }),
});
// o Hugging Face redireciona o download para a CDN dele (*.hf.co); nada fora disso é seguido
const HF_HOST = /^(huggingface\.co|([a-z0-9-]+\.)+huggingface\.co|([a-z0-9-]+\.)+hf\.co)$/i;
const RATE = 16000;
const MAX_SECONDS = 60;
const MIN_SECONDS = 0.3;
const RUN_TIMEOUT_MS = 120000;
const VC_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'vcomp140.dll'];

function bad(msg, code = 'INVALID') { const e = new Error(msg); e.code = code; return e; }

// ---------- WAV ----------
// aceita só PCM 16 bits, mono, 16 kHz, até 60 s; devolve só os amostras (o arquivo do disco é remontado daqui)
function parseWav(buf) {
  if (!Buffer.isBuffer(buf)) buf = (buf instanceof Uint8Array) ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  if (!buf || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw bad('áudio inválido');
  if (buf.length > 44 + (MAX_SECONDS + 1) * RATE * 2 + 1024) throw bad(`áudio longo demais (máx. ${MAX_SECONDS} s)`);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4); const len = buf.readUInt32LE(off + 4); const body = off + 8;
    if (body + len > buf.length) { if (id === 'data') data = buf.subarray(body); break; }
    if (id === 'fmt ' && len >= 16) fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') { data = buf.subarray(body, body + len); break; }
    off = body + len + (len & 1);
  }
  if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw bad('áudio fora do formato (PCM 16 kHz mono)');
  if (!data || !data.length) throw bad('áudio vazio');
  const pcm = data.subarray(0, data.length - (data.length & 1));
  const seconds = pcm.length / 2 / RATE;
  if (seconds > MAX_SECONDS + 1) throw bad(`áudio longo demais (máx. ${MAX_SECONDS} s)`);
  return { pcm, seconds };
}

function wavFile(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------- texto ----------
// tira marcas do whisper ([BLANK_AUDIO], [Música], (risos)…), quebras de linha e qualquer caractere de controle (o texto
// vai para o terminal: nada de Enter nem sequência de escape)
function cleanText(s) {
  return String(s || '')
    .replace(/\[[^\]\n]{0,40}\]/g, ' ')
    .replace(/\((?:m[úu]sica|music|risos|aplausos|sil[êe]ncio|inaud[íi]vel)[^)\n]{0,20}\)/gi, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 4000);
}

// vocabulário do projeto para o whisper acertar os termos (nome, pasta, arquivos mexidos, comandos comuns); só nomes,
// nunca caminho completo
function buildPrompt({ project = '', dirs = [], files = [] } = {}) {
  const base = (f) => String(f || '').replace(/^"|"$/g, '').split(/[\\/]/).pop();
  const words = [project, ...dirs.map(base), ...files.slice(0, 8).map(base)]
    .map(w => String(w || '').replace(/[\u0000-\u001f"]/g, ' ').trim()).filter(Boolean);
  const common = ['Bancada', 'Claude', 'Codex', 'terminal', 'commit', 'diff', 'git push', 'npm test', 'npm run dev', 'package.json', 'README'];
  return [...new Set([...words, ...common])].join(', ').slice(0, 400);
}

// contexto de áudio proporcional à fala (CPU: o whisper deixa de processar a janela fixa de 30 s); múltiplo de 64
function audioCtx(seconds) {
  const n = Math.min(1500, Math.ceil(seconds * 50) + 128);
  return Math.min(1500, Math.ceil(n / 64) * 64);
}

function threads(win, cpus = os.cpus().length) {
  return win ? Math.min(8, Math.max(2, Math.ceil(cpus / 2))) : Math.min(8, Math.max(1, cpus));
}

function whisperArgs({ model, wav, prompt, seconds, win, nThreads }) {
  const a = ['-m', model, '-f', wav, '-l', 'pt', '-nt', '-np', '-t', String(nThreads)];
  if (prompt) a.push('--prompt', prompt);
  // Windows (só CPU): janela proporcional + sem carregar o texto anterior (menos repetição com -ac)
  if (win) a.push('-ac', String(audioCtx(seconds)), '-mc', '0');
  return a;
}

// onde está o whisper-cli: no app empacotado, Resources/whisper; em desenvolvimento, build/whisper/<mac|win>
function binPath({ win = process.platform === 'win32', packaged, resourcesPath, appRoot }) {
  const name = win ? 'whisper-cli.exe' : 'whisper-cli';
  return packaged ? path.join(resourcesPath, 'whisper', name) : path.join(appRoot, 'build', 'whisper', win ? 'win' : 'mac', name);
}

// Windows: os arquivos do whisper.cpp oficial precisam do runtime do Visual C++ (não vem no Windows "limpo")
function vcRuntime(systemRoot = process.env.SystemRoot || 'C:\\Windows', exists = fs.existsSync) {
  const missing = VC_DLLS.filter(d => !exists(path.win32.join(systemRoot, 'System32', d)));
  return { ok: !missing.length, missing, url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe' };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

const ASCII = /^[\x20-\x7e]*$/;
// forma curta 8.3 de uma pasta (Windows), pelo próprio sistema; null se não deu
function winShortPath(dir) {
  return new Promise((resolve) => {
    execFile(plat.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${plat.qPs(dir)}).ShortPath`],
      { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, out) => resolve(err ? null : String(out || '').trim() || null));
  });
}
// .dll/.exe soltos na pasta de dados da voz (nunca deveria haver código ali)
function codeIn(dir) {
  for (const d of [dir, path.join(dir, 'tmp')]) { let ents = []; try { ents = fs.readdirSync(d); } catch {} if (ents.some(f => /\.(dll|exe)$/i.test(f))) return true; }
  return false;
}

class Voice {
  // dir: <dados>/voz · bin: caminho do whisper-cli · models/transport/allowHost/insecure: só para os testes
  constructor({ dir, bin, win = process.platform === 'win32', models = MODELS, transport = https, allowHost = (h) => HF_HOST.test(h),
    insecure = false, exec = execFile, onProgress = () => {}, log = null, model = 'turbo', shortPath = winShortPath, appVersion = '' }) {
    this.dir = dir; this.bin = bin; this.win = win; this.models = models; this.transport = transport; this.allowHost = allowHost;
    this.insecure = insecure; this.exec = exec; this.onProgress = onProgress; this.log = log;
    this.modelId = models[model] ? model : Object.keys(models)[0];
    this.dl = null;          // download em andamento { id, got, total, req }
    this.running = null;     // processo do whisper em andamento (promessa)
    this.lock = false;       // uma transcrição por vez (~0,85 GB cada), aquecimento incluído
    this.warming = false;
    this.warmP = null;       // aquecimento em andamento (promessa que nunca rejeita)
    this.lastMs = null;
    this.tmp = path.join(dir, 'tmp');
    this.shortPath = shortPath; this.short = undefined;
    this.appVersion = String(appVersion || '');            // o marcador vale só para esta versão do app   // forma curta da pasta de dados (Windows, calculada 1×)
  }

  // pasta atual e caminhos do whisper-cli (ver o cabeçalho)
  async where(name) {
    const file = this.model().file;
    if (!this.win) return { cwd: this.dir, model: file, wav: path.join('tmp', name) };
    let base = this.dir;
    if (!ASCII.test(base)) { if (this.short === undefined) this.short = await this.shortPath(this.dir).catch(() => null); base = this.short; }
    if (base && ASCII.test(base)) return { cwd: path.dirname(this.bin), model: path.join(base, file), wav: path.join(base, 'tmp', name) };
    if (codeIn(this.dir)) throw bad('a pasta da voz tem um programa (.dll/.exe) que não é da Bancada: apague-o e tente de novo', 'VOICE_FAILED');
    return { cwd: this.dir, model: file, wav: path.join('tmp', name) };
  }

  setup() {
    fs.mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); fs.chmodSync(this.tmp, 0o700); } catch {}
    // sobras de uma transcrição interrompida (app fechado no meio)
    for (const f of fs.readdirSync(this.tmp)) if (/\.wav$/.test(f)) { try { fs.unlinkSync(path.join(this.tmp, f)); } catch {} }
    return this;
  }

  setModel(id) { if (!this.models[id]) throw bad('modelo desconhecido'); this.modelId = id; return true; }
  model(id = this.modelId) { const m = this.models[id]; if (!m) throw bad('modelo desconhecido'); return m; }
  modelFile(id) { return path.join(this.dir, this.model(id).file); }
  markerFile(id) { return this.modelFile(id) + '.ok'; }
  hasBinary() { try { return fs.statSync(this.bin).isFile(); } catch { return false; } }

  // conferido? (SHA-256 já calculado para ESTE arquivo: mesmo tamanho e data de modificação, e NESTA versão do app —
  // a cada atualização o SHA-256 é refeito uma vez)
  isVerified(id = this.modelId) {
    try {
      const st = fs.statSync(this.modelFile(id)); const mk = JSON.parse(fs.readFileSync(this.markerFile(id), 'utf8'));
      return st.size === this.model(id).size && mk.sha256 === this.model(id).sha256 && mk.size === st.size && mk.mtimeMs === st.mtimeMs
        && (mk.app || '') === this.appVersion;
    } catch { return false; }
  }
  // refaz o SHA-256 em 2º plano se o marcador não vale mais (arquivo mudou ou app atualizado); nunca junto com o whisper
  async recheck() {
    if (this.lock || this.dl || !fs.existsSync(this.modelFile()) || this.isVerified()) return false;
    this.lock = true;
    try { await this.verify(); this._mark(this.modelId); return true; }
    catch (e) { if (this.log) this.log.warn('voz', 'conferência do modelo: ' + e.message); return false; }
    finally { this.lock = false; }
  }

  async verify(id = this.modelId, file = this.modelFile(id)) {
    const m = this.model(id);
    let st; try { st = fs.statSync(file); } catch { throw bad('modelo de voz não baixado', 'NO_MODEL'); }
    if (st.size !== m.size) throw bad('modelo de voz incompleto', 'BAD_MODEL');
    const got = await sha256File(file);
    if (got !== m.sha256) { try { fs.unlinkSync(file); } catch {} try { fs.unlinkSync(this.markerFile(id)); } catch {} throw bad('o modelo de voz não confere (SHA-256): apagado; baixe de novo', 'BAD_HASH'); }
    return got;
  }

  status() {
    const m = this.model();
    let present = false; try { present = fs.statSync(this.modelFile()).size === m.size; } catch {}
    return { binary: this.hasBinary(), model: { id: m.id, label: m.label, size: m.size, present, verified: present && this.isVerified() },
      models: Object.values(this.models).map(x => ({ id: x.id, label: x.label, size: x.size })),
      downloading: this.dl ? { id: this.dl.id, got: this.dl.got, total: this.dl.total } : null,
      busy: this.lock && !this.warming, warming: this.warming, lastMs: this.lastMs, vc: this.win ? vcRuntime() : null };
  }

  // ---------- download ----------
  _get(url, headers, hops = 0) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(url); } catch { return reject(bad('endereço inválido')); }
      if (u.protocol !== 'https:' && !(this.insecure && u.protocol === 'http:')) return reject(bad('download só por HTTPS'));
      if (!this.allowHost(u.hostname)) return reject(bad(`download recusado: ${u.hostname} não é o Hugging Face`));
      const req = this.transport.get(u, { headers: { 'User-Agent': 'Bancada', ...headers } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 5) return reject(bad('redirecionamentos demais'));
          return resolve(this._get(new URL(res.headers.location, u).href, headers, hops + 1));
        }
        resolve(res);
      });
      if (this.dl) this.dl.req = req;
      req.setTimeout(30000, () => req.destroy(bad('o download parou de responder', 'TIMEOUT')));
      req.on('error', reject);
    });
  }

  // baixa (ou continua) o modelo; só renomeia para o nome final depois que o SHA-256 confere
  async download(id = this.modelId) {
    const m = this.model(id);
    if (this.dl) throw bad('já tem um download de voz em andamento', 'BUSY');
    if (this.isVerified(id)) return { ok: true, already: true };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.modelFile(id); const part = file + '.part';
    this.dl = { id, got: 0, total: m.size, req: null, canceled: false };
    try {
      // arquivo final presente mas sem conferência (ex.: marcador apagado): confere antes de baixar de novo
      if (fs.existsSync(file)) { try { await this.verify(id, file); this._mark(id); return { ok: true, already: true }; } catch {} }
      let have = 0; try { have = fs.statSync(part).size; } catch {}
      if (have > m.size) { fs.unlinkSync(part); have = 0; }
      if (have < m.size) {
        try { const fsInfo = fs.statfsSync(this.dir); if (fsInfo.bavail * fsInfo.bsize < (m.size - have) + 50 * 1048576) throw bad(`sem espaço em disco (precisa de ${Math.ceil((m.size - have) / 1048576) + 50} MB livres)`, 'NO_SPACE'); } catch (e) { if (e.code === 'NO_SPACE') throw e; }
        const res = await this._get(m.url, have ? { Range: `bytes=${have}-` } : {});
        if (res.statusCode === 206 && have) { /* continua de onde parou */ }
        else if (res.statusCode === 200) have = 0;
        else if (res.statusCode === 416 && have === m.size) { res.resume(); }
        else { res.resume(); throw bad(`download recusado (HTTP ${res.statusCode})`, 'HTTP'); }
        if (res.statusCode === 200 || res.statusCode === 206) await this._save(res, part, have, m.size);
      }
      this.onProgress({ id, got: m.size, total: m.size, phase: 'conferindo' });
      try { await this.verify(id, part); } catch (e) { try { fs.unlinkSync(part); } catch {} throw e.code === 'BAD_HASH' ? bad('o arquivo baixado não confere (SHA-256): apagado; tente de novo', 'BAD_HASH') : e; }
      fs.renameSync(part, file); fs.chmodSync(file, 0o600);
      this._mark(id);
      this.onProgress({ id, got: m.size, total: m.size, phase: 'pronto' });
      return { ok: true };
    } catch (e) {
      if (this.dl && this.dl.canceled) throw bad('download cancelado (continua de onde parou na próxima vez)', 'CANCELED');
      throw e;
    } finally { this.dl = null; }
  }

  _save(res, part, have, total) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w', mode: 0o600 });
      let got = have, last = 0; this.dl.got = got;
      const fail = (e) => { res.destroy(); out.destroy(); reject(e); };
      res.on('data', (c) => {
        got += c.length; this.dl.got = got;
        if (got > total) return fail(bad('o download veio maior que o esperado', 'BAD_MODEL'));
        const now = Date.now(); if (now - last > 250) { last = now; this.onProgress({ id: this.dl.id, got, total, phase: 'baixando' }); }
      });
      res.on('error', fail); res.on('aborted', () => fail(bad('o download foi interrompido', 'ABORTED')));
      out.on('error', fail);
      res.pipe(out);
      out.on('finish', () => resolve(got));
    });
  }

  // ao sair: para o download, mata a transcrição em andamento e apaga o áudio dela (nada fica para a próxima abertura)
  shutdown() {
    this.cancel();
    if (this.child) { try { this.child.kill(); } catch {} }
    if (this.curWav) { try { fs.unlinkSync(this.curWav); } catch {} }
    this.child = null; this.curWav = null;
    return true;
  }

  cancel() { if (!this.dl) return false; this.dl.canceled = true; try { this.dl.req && this.dl.req.destroy(bad('cancelado', 'CANCELED')); } catch {} return true; }

  _mark(id) {
    const st = fs.statSync(this.modelFile(id));
    fs.writeFileSync(this.markerFile(id), JSON.stringify({ sha256: this.model(id).sha256, size: st.size, mtimeMs: st.mtimeMs, app: this.appVersion }), { mode: 0o600 });
  }

  // ---------- transcrição ----------
  async ready() {
    if (!this.hasBinary()) throw bad('o motor de voz não veio nesta instalação', 'NO_BINARY');
    if (!this.isVerified()) {
      if (!fs.existsSync(this.modelFile())) throw bad('baixe a voz primeiro (Ajustes → Voz)', 'NO_MODEL');
      await this.verify(); this._mark(this.modelId);
    }
  }

  // wav: bytes da tela (Uint8Array/Buffer) · prompt: vocabulário · devolve { text, ms, seconds }
  async transcribe(wav, { prompt = '' } = {}) {
    const { pcm, seconds } = parseWav(wav);
    if (seconds < MIN_SECONDS) return { text: '', ms: 0, seconds, short: true };
    // o aquecimento em 2º plano não barra a 1ª frase: espera ele acabar (nunca dois whisper ao mesmo tempo)
    if (this.warmP) await this.warmP;
    if (this.lock) throw bad('ainda transcrevendo a frase anterior', 'BUSY');
    this.lock = true;
    try {
      await this.ready();
      const t0 = Date.now();
      const raw = await this._run(wavFile(pcm), seconds, prompt);
      const ms = Date.now() - t0; this.lastMs = ms;
      return { text: cleanText(raw), ms, seconds };
    } finally { this.lock = false; }
  }

  async _run(buf, seconds, prompt) {
    const name = `${crypto.randomUUID()}.wav`;
    const abs = path.join(this.tmp, name);
    const at = await this.where(name);
    const p = new Promise((resolve, reject) => {
      fs.mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
      fs.writeFileSync(abs, buf, { mode: 0o600, flag: 'wx' });
      const args = whisperArgs({ model: at.model, wav: at.wav, prompt: cleanText(prompt).slice(0, 400), seconds, win: this.win, nThreads: threads(this.win) });
      this.curWav = abs;
      this.child = this.exec(this.bin, args, { cwd: at.cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? 'a transcrição demorou demais e foi parada' : `o motor de voz falhou${err.code != null ? ` (código ${err.code})` : ''}`;
          if (this.log) this.log.warn('voz', `${why}: ${String(stderr || '').slice(-300)}`);
          return reject(bad(why, 'VOICE_FAILED'));
        }
        resolve(String(stdout || ''));
      });
    });
    this.running = p;
    const done = () => { this.running = null; this.child = null; this.curWav = null; try { fs.unlinkSync(abs); } catch {} };
    return p.then((r) => { done(); return r; }, (e) => { done(); throw e; });
  }

  // 1ª execução de cada binário novo compila os shaders do Metal (7–8 s): faz em 2º plano com 1 s de silêncio, depois
  // de baixar e depois de cada atualização (o marcador guarda tamanho+data do binário e o modelo)
  warmKey() { try { const st = fs.statSync(this.bin); return `${st.size}:${Math.round(st.mtimeMs)}:${this.modelId}`; } catch { return null; } }
  isWarm() { try { return fs.readFileSync(path.join(this.dir, 'aquecido.txt'), 'utf8') === this.warmKey(); } catch { return false; } }
  warmup() {
    if (this.warmP) return this.warmP;
    if (this.lock || this.isWarm()) return Promise.resolve(false);
    this.warming = true; this.lock = true;
    this.warmP = (async () => {
      try {
        await this.ready();
        await this._run(wavFile(Buffer.alloc(RATE * 2)), 1, '');
        fs.writeFileSync(path.join(this.dir, 'aquecido.txt'), this.warmKey(), { mode: 0o600 });
        return true;
      } catch (e) { if (this.log) this.log.warn('voz', 'aquecimento: ' + e.message); return false; }
      finally { this.warming = false; this.lock = false; this.warmP = null; }
    })();
    return this.warmP;
  }
}

module.exports = { Voice, MODELS, HF_HOST, parseWav, wavFile, cleanText, buildPrompt, audioCtx, threads, whisperArgs, binPath, vcRuntime, sha256File, RATE, MAX_SECONDS };
