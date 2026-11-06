// Assistentes de IA (BP-2026-11-06-001): instalar, atualizar, conectar e diagnosticar Claude, Codex e Google (agy)
// sem a pessoa digitar nada no terminal.
//
// Por que existe: os três instaladores oficiais põem o programa em ~/.local/bin, mas dependem do ~/.zshrc para o
// terminal achá-lo. O do Google (agy) nem mexe no .zshrc e manda a pessoa editar à mão; o nosso tinha a linha
// duplicada. Resultado: "command not found" ("erro de path"), e quem é leigo trava ali.
// Como resolve: a Bancada sabe onde cada instalador põe o binário, chama SEMPRE pelo caminho absoluto e injeta
// ~/.local/bin no PATH dos terminais dela. Assim funciona mesmo com o .zshrc errado. Consertar o .zshrc (para o
// Terminal do Mac) é um botão à parte, opcional, idempotente e com backup.
//
// Segurança:
// - URL fixa no código, só HTTPS (curl --proto =https);
// - o script é baixado para um arquivo e conferido (começa com #!, tamanho razoável) antes de rodar;
// - nunca usa sudo; um job por vez; log visível; timeout de 10 min;
// - o login acontece no site da própria empresa (OAuth no navegador): a Bancada nunca vê senha nem token;
// - a página nunca escolhe o comando: os ids e os argumentos saem deste catálogo.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOOLS = {
  claude: {
    id: 'claude', name: 'Claude', vendor: 'Anthropic', bin: 'claude',
    installUrl: 'https://claude.ai/install.sh',
    plan: 'Precisa de uma assinatura Claude Pro ou Max (claude.ai).',
    loginArgs: ['auth', 'login'], updateArgs: ['update'],
    loginHint: 'O navegador vai abrir na página da Anthropic. Entre na sua conta e autorize. Se pedir um código, copie e cole aqui com ⌘V e aperte Enter.',
  },
  codex: {
    id: 'codex', name: 'Codex', vendor: 'OpenAI (ChatGPT)', bin: 'codex',
    installUrl: 'https://chatgpt.com/codex/install.sh',
    plan: 'Precisa de um plano do ChatGPT que inclua o Codex (Plus, Pro, Business…).',
    loginArgs: ['login'], updateArgs: ['update'],
    loginHint: 'O navegador vai abrir na página do ChatGPT. Entre na sua conta e autorize. Quando aparecer "Signed in", pode fechar.',
  },
  google: {
    id: 'google', name: 'Google (Antigravity)', vendor: 'Google', bin: 'agy',
    installUrl: 'https://antigravity.google/cli/install.sh',
    plan: 'Precisa de uma conta Google. O antigo Gemini CLI foi aposentado para contas pessoais em 18/06/2026; o Antigravity CLI (agy) é o substituto oficial.',
    loginArgs: [], updateArgs: ['update'],
    loginHint: 'O navegador vai abrir na página do Google. Entre na sua conta e autorize. A página mostra um código: copie, volte aqui, cole com ⌘V e aperte Enter. Quando a IA abrir, já está conectado e pode fechar.',
  },
};
const IDS = Object.keys(TOOLS);

const JOB_TIMEOUT = 10 * 60 * 1000;
const STATUS_TIMEOUT = 25 * 1000;
const MAX_LOG = 200 * 1024;
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

function strip(s) { return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n'); }
function parseVersion(s) { const m = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(strip(s || '')); return m ? m[1] : null; }

// `claude auth status` devolve JSON
function parseClaudeStatus(out) {
  try {
    const j = JSON.parse(String(out).slice(String(out).indexOf('{')));
    return { connected: !!j.loggedIn, account: j.email || null, plan: j.subscriptionType || null };
  } catch { return { connected: null }; }
}
function parseCodexStatus(out, code) {
  const s = strip(out);
  if (/not logged in/i.test(s)) return { connected: false };
  if (code === 0 && /logged in/i.test(s)) { const m = /using\s+(.+)$/im.exec(s); return { connected: true, account: m ? m[1].trim() : null }; }
  return { connected: code === 0 ? true : null };
}
function parseGoogleStatus(out, code) {
  const s = strip(out);
  if (/sign in|authentication required|not authenticated|log in/i.test(s)) return { connected: false };
  return { connected: code === 0 ? true : null };
}

// Linhas do .zshrc que põem ~/.local/bin no PATH; remove cópias idênticas e acrescenta uma se não houver nenhuma.
// O mesmo lugar aparece escrito de jeitos diferentes: "$HOME/.local/bin" (Claude, Codex) e "/Users/nome/.local/bin"
// (o instalador do Google escreve o caminho completo). Para achar repetição, compara a pasta já resolvida.
const PATH_RE = /^\s*export\s+PATH=["']?((?:\$HOME|\$\{HOME\}|~|\/[^"':$]+?)\/\.local\/bin):\$PATH["']?\s*(?:#.*)?$/;
function pathLineDir(l, home) {
  const m = PATH_RE.exec(l); if (!m) return null;
  return m[1].replace(/^(\$HOME|\$\{HOME\}|~)/, home);
}
function fixShellText(text, home = os.homedir()) {
  const lines = String(text || '').split('\n');
  const mine = path.join(home, '.local', 'bin');
  const out = []; let removed = 0; let found = false;
  for (const l of lines) {
    if (pathLineDir(l, home) === mine) {
      if (found) { removed++; continue; }     // a primeira fica; as outras (mesma pasta) saem
      found = true;
    }
    out.push(l);
  }
  let res = out.join('\n'); let added = false;
  if (!found) {
    if (res.length && !res.endsWith('\n')) res += '\n';
    res += `\n# Bancada: programas das IAs (claude, codex, agy) ficam em ~/.local/bin\n${PATH_LINE}\n`;
    added = true;
  }
  return { text: res, changed: added || removed > 0, added, removed };
}

class AiTools {
  constructor({ home = os.homedir(), onLog = () => {}, basePath = process.env.PATH || '' } = {}) {
    this.home = home; this.onLog = onLog; this.basePath = basePath;
    this.localBin = path.join(home, '.local', 'bin');
    this.job = null;      // { tool, kind, proc, log, started }
  }

  // PATH para tudo que a Bancada roda: ~/.local/bin e os do Homebrew na frente, sem repetir
  envPath(base = this.basePath) {
    const want = [this.localBin, '/opt/homebrew/bin', '/usr/local/bin'];
    const rest = String(base || '').split(':').filter(Boolean);
    const sys = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const all = [...want, ...rest, ...sys];
    return [...new Set(all)].join(':');
  }
  env(extra = {}) {
    const env = { ...process.env, HOME: this.home, PATH: this.envPath(), ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
    return env;
  }

  tool(id) { const t = TOOLS[id]; if (!t) { const e = new Error('IA desconhecida'); e.code = 'INVALID'; throw e; } return t; }

  candidates(id) {
    const b = this.tool(id).bin;
    return [path.join(this.localBin, b), `/opt/homebrew/bin/${b}`, `/usr/local/bin/${b}`,
      path.join(this.home, '.npm-global', 'bin', b), path.join(this.home, '.bun', 'bin', b)];
  }
  // todas as cópias instaladas (para avisar de conflito); a primeira é a usada (a oficial em ~/.local/bin vence)
  findAll(id) {
    const out = [];
    for (const p of this.candidates(id)) { try { fs.accessSync(p, fs.constants.X_OK); out.push(p); } catch {} }
    return out;
  }
  find(id) { return this.findAll(id)[0] || null; }

  via(p) {
    if (!p) return null;
    if (p.startsWith(this.localBin + path.sep)) return 'instalador oficial';
    let real = p; try { real = fs.realpathSync(p); } catch {}
    if (/node_modules/.test(real)) return 'npm';
    if (/Caskroom|Cellar/.test(real)) return 'Homebrew';
    return 'outro';
  }

  run(bin, args, { timeout = STATUS_TIMEOUT, cwd = this.home } = {}) {
    return new Promise((resolve) => {
      let out = ''; let done = false;
      let p;
      try { p = spawn(bin, args, { cwd, env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { resolve({ code: -1, out: String(e.message) }); return; }
      const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} fin(-2); }, timeout);
      const add = (d) => { if (out.length < 64 * 1024) out += d.toString('utf8'); };
      p.stdout.on('data', add); p.stderr.on('data', add);
      p.on('error', (e) => { out += String(e.message); fin(-1); });
      p.on('close', (code) => fin(code));
    });
  }

  async status(id) {
    const t = this.tool(id);
    const all = this.findAll(id); const bin = all[0] || null;
    const res = { id, name: t.name, vendor: t.vendor, plan: t.plan, loginHint: t.loginHint, installed: !!bin, path: bin, via: this.via(bin),
      copies: all.map(p => ({ path: p, via: this.via(p) })), version: null, connected: null, account: null, accountPlan: null,
      busy: !!(this.job && this.job.tool === id), job: this.job && this.job.tool === id ? this.job.kind : null };
    if (!bin) return res;
    const v = await this.run(bin, ['--version'], { timeout: 15000 });
    res.version = parseVersion(v.out);
    if (id === 'claude') {
      const r = await this.run(bin, ['auth', 'status']);
      const s = parseClaudeStatus(r.out); res.connected = s.connected; res.account = s.account || null; res.accountPlan = s.plan || null;
    } else if (id === 'codex') {
      const r = await this.run(bin, ['login', 'status']);
      const s = parseCodexStatus(r.out, r.code); res.connected = s.connected; res.account = s.account || null;
    } else {
      const r = await this.run(bin, ['models']);
      res.connected = parseGoogleStatus(r.out, r.code).connected;
    }
    return res;
  }
  statusAll() { return Promise.all(IDS.map(id => this.status(id))); }

  // ---------- instalar / atualizar (um job por vez, log ao vivo) ----------
  log(line) {
    if (!this.job) return;
    const s = strip(line);
    if (this.job.log.length < MAX_LOG) this.job.log += s;
    this.onLog({ tool: this.job.tool, kind: this.job.kind, text: s });
  }

  startJob(id, kind) {
    if (this.job) { const e = new Error(`Já estou ${this.job.kind === 'install' ? 'instalando' : 'atualizando'} ${TOOLS[this.job.tool].name}. Espere terminar.`); e.code = 'BUSY'; throw e; }
    this.job = { tool: id, kind, proc: null, log: '', started: Date.now(), cancelled: false };
  }

  spawnJob(bin, args, opts = {}) {
    return new Promise((resolve) => {
      const p = spawn(bin, args, { cwd: this.home, env: this.env(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
      this.job.proc = p;
      const timer = setTimeout(() => { this.log('\n[tempo esgotado: 10 min]\n'); try { p.kill('SIGKILL'); } catch {} }, JOB_TIMEOUT);
      p.stdout.on('data', d => this.log(d.toString('utf8')));
      p.stderr.on('data', d => this.log(d.toString('utf8')));
      p.on('error', (e) => { clearTimeout(timer); this.log(`\n${e.message}\n`); resolve(-1); });
      p.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
  }

  async install(id) {
    const t = this.tool(id);
    this.startJob(id, 'install');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-instalar-'));
    const file = path.join(tmp, 'install.sh');
    try {
      this.log(`Baixando o instalador oficial de ${t.vendor}:\n  ${t.installUrl}\n`);
      const c = await this.spawnJob('/usr/bin/curl', ['-fsSL', '--proto', '=https', '--tlsv1.2', '--max-time', '120', '-o', file, t.installUrl]);
      if (this.job.cancelled) throw new Error('cancelado');
      if (c !== 0) throw new Error('não consegui baixar o instalador (sem internet?)');
      const st = fs.statSync(file); const head = fs.readFileSync(file, 'utf8').slice(0, 2);
      if (head !== '#!' || st.size < 200 || st.size > 512 * 1024) throw new Error('o arquivo baixado não parece um instalador; parei por segurança');
      this.log(`Instalador conferido (${Math.round(st.size / 1024)} KB). Rodando, sem pedir a senha do Mac…\n\n`);
      const code = await this.spawnJob('/bin/bash', [file], { env: { TERM: 'dumb', NO_COLOR: '1' } });
      if (this.job.cancelled) throw new Error('cancelado');
      const bin = this.find(id);
      if (!bin) throw new Error(`o instalador terminou (código ${code}), mas ${t.bin} não apareceu em ~/.local/bin`);
      const v = parseVersion((await this.run(bin, ['--version'], { timeout: 15000 })).out);
      this.log(`\n✓ ${t.name} instalado${v ? ` (versão ${v})` : ''} em ${bin.replace(this.home, '~')}\n`);
      return { ok: true, path: bin, version: v, log: this.job.log };
    } catch (e) {
      this.log(`\n✕ ${e.message}\n`);
      return { ok: false, error: e.message, log: this.job.log };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      this.job = null;
    }
  }

  async update(id) {
    const t = this.tool(id);
    const bin = this.find(id);
    if (!bin) { const e = new Error(`${t.name} não está instalado`); e.code = 'INVALID'; throw e; }
    this.startJob(id, 'update');
    try {
      this.log(`Atualizando ${t.name} (${bin.replace(this.home, '~')})…\n`);
      const code = await this.spawnJob(bin, t.updateArgs, { env: { TERM: 'dumb', NO_COLOR: '1' } });
      const v = parseVersion((await this.run(bin, ['--version'], { timeout: 15000 })).out);
      this.log(`\n${code === 0 ? '✓' : '!'} versão agora: ${v || '?'}\n`);
      return { ok: code === 0, version: v, log: this.job.log };
    } finally { this.job = null; }
  }

  cancel() { if (this.job && this.job.proc) { this.job.cancelled = true; try { this.job.proc.kill('SIGTERM'); } catch {} return true; } return false; }

  // comando do login (o processo principal decide; a página só escolhe a IA)
  loginExec(id) {
    const t = this.tool(id); const bin = this.find(id);
    if (!bin) { const e = new Error(`${t.name} não está instalado. Clique em Instalar primeiro.`); e.code = 'INVALID'; throw e; }
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    return [q(bin), ...t.loginArgs.map(q)].join(' ');
  }
  binFor(id) { return this.find(id); }

  // ---------- Terminal do Mac (~/.zshrc) ----------
  rcFile() { return path.join(this.home, '.zshrc'); }
  async shellCheck() {
    let text = ''; try { text = fs.readFileSync(this.rcFile(), 'utf8'); } catch {}
    const mine = path.join(this.home, '.local', 'bin');
    const lines = text.split('\n').filter(l => pathLineDir(l, this.home) === mine);
    const r = await this.run('/bin/zsh', ['-lic', 'echo __BANCADA_PATH__$PATH'], { timeout: 10000 });
    const m = /__BANCADA_PATH__(.*)/.exec(r.out || '');
    const shellPath = m ? m[1].trim().split(':') : null;
    return { rc: this.rcFile(), has_line: lines.length > 0, duplicates: Math.max(0, lines.length - 1),
      terminal_finds: shellPath ? shellPath.includes(this.localBin) : null, ok: lines.length === 1 && (!shellPath || shellPath.includes(this.localBin)) };
  }
  fixShell() {
    const rc = this.rcFile();
    let text = ''; let mode = 0o644; let exists = false;
    try { text = fs.readFileSync(rc, 'utf8'); mode = fs.statSync(rc).mode & 0o777; exists = true; } catch {}
    const r = fixShellText(text, this.home);
    if (!r.changed) return { changed: false, backup: null, added: false, removed: 0 };
    let backup = null;
    if (exists) {
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      backup = `${rc}.bancada-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      fs.copyFileSync(rc, backup);
    }
    fs.writeFileSync(rc, r.text, { mode });
    return { changed: true, backup, added: r.added, removed: r.removed };
  }
}

// pasta do primeiro projeto de quem nunca programou (onboarding leigo)
function firstProjectDir(home = os.homedir()) {
  const dir = path.join(home, 'Documents', 'Bancada', 'Meu primeiro projeto');
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'LEIA-ME.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# Meu primeiro projeto\n\nEsta pasta é sua. Peça para a IA do terminal criar algo aqui, por exemplo:\n\n' +
      '- "crie uma página que mostra um relógio grande"\n- "me explique o que tem nesta pasta"\n- "faça uma lista de tarefas simples que abre no navegador"\n\n' +
      'A IA mostra o que vai fazer antes de mexer nos arquivos. Na dúvida, pergunte a ela: "como eu vejo isso funcionando?"\n');
  }
  return dir;
}

module.exports = { AiTools, TOOLS, IDS, parseVersion, parseClaudeStatus, parseCodexStatus, parseGoogleStatus, fixShellText, firstProjectDir, PATH_LINE, strip };
