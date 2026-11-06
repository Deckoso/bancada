// Gerenciador de terminais (node-pty). Fonte: BLUEPRINT D3/D4/D18.
// Memória: a saída é juntada e enviada ao renderer a cada 16 ms; se o renderer atrasar e o pendente passar de
// MAX_PENDING, o pty é pausado (backpressure) até drenar. Nada cresce sem limite.
'use strict';
const pty = require('node-pty');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const MAX_TERMINALS = 12;
const FLUSH_MS = 16;
const MAX_PENDING = 2 * 1024 * 1024;   // 2 MB por terminal
const MAX_PASTE = 64 * 1024;           // prompt enviado por clique: até 64 KB
const MAX_URLS = 5;                    // endereços de servidor local lembrados por terminal
const LOOPBACK_HINT = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/;
const REPLAY = 256 * 1024;             // últimos 256 KB de saída por terminal (para o celular que entra depois)

class PtyManager {
  constructor({ send, shell = process.env.SHELL || '/bin/zsh', max = MAX_TERMINALS, envPath = null } = {}) {
    this.send = send;            // (channel, payload) => void
    this.envPath = envPath;      // (PATH) => PATH com ~/.local/bin na frente (ai-tools): acha as IAs mesmo com .zshrc errado
    this.shell = shell;
    this.max = max;
    this.terms = new Map();      // id -> {proc, projectId, name, pending, timer, paused, cwd}
  }

  count() { return this.terms.size; }
  list() { return [...this.terms.entries()].map(([id, t]) => ({ id, projectId: t.projectId, name: t.name, cwd: t.cwd, urls: t.urls })); }

  // servidor local subiu (npm run dev, vite…): avisa a tela uma vez por endereço (E5, chip "▶ :3000")
  findUrls(id, t, d) {
    const clean = d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const re = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?:\/[^\s'"\x1b]*)?/g;
    let m;
    while ((m = re.exec(clean)) && t.urls.length < MAX_URLS) {
      const url = m[0].replace(/[).,;]+$/, '');
      if (t.urls.some(u => u.port === m[1])) continue;
      t.urls.push({ port: m[1], url });
      this.send('pty:url', { id, url, port: m[1] });
    }
  }

  create({ id, projectId, name, cwd, cols = 100, rows = 30, startup = null, exec = null, oneShot = false }) {
    if (this.terms.has(id)) return { id, reused: true };
    if (this.terms.size >= this.max) {
      const e = new Error(`Limite de ${this.max} terminais abertos. Feche algum para abrir outro.`);
      e.code = 'PTY_LIMIT'; throw e;
    }
    const dir = cwd && safeDir(cwd) ? cwd : os.homedir();
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', BANCADA_PROJECT: String(projectId || ''), BANCADA_TERMINAL: String(name || ''), BANCADA_TERM_ID: String(id) };
    delete env.ELECTRON_RUN_AS_NODE;
    if (this.envPath) env.PATH = this.envPath(env.PATH);
    // não herdar marcas de uma sessão do Claude que tenha aberto a Bancada (desligariam o histórico da conversa nova)
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
    // oneShot (login das IAs): roda o comando e acaba; o normal deixa um shell na pasta quando o programa sai
    const args = exec ? (oneShot ? ['-l', '-c', exec] : ['-l', '-i', '-c', `${exec}; exec ${this.shell} -l`]) : ['-l'];
    const proc = pty.spawn(this.shell, args, { name: 'xterm-256color', cols, rows, cwd: dir, env });
    const t = { proc, projectId, name, cwd: dir, pending: '', timer: null, paused: false, tail: '', cols, rows, urls: [] };
    this.terms.set(id, t);

    proc.onData((d) => {
      if (t.urls.length < MAX_URLS && LOOPBACK_HINT.test(d)) this.findUrls(id, t, d);
      t.pending += d;
      if (!t.paused && t.pending.length > MAX_PENDING) { t.paused = true; try { proc.pause(); } catch {} }
      if (!t.timer) t.timer = setTimeout(() => this.flush(id), FLUSH_MS);
    });
    proc.onExit(({ exitCode }) => {
      // terminal fechado/reiniciado de propósito: não avisa (o id pode já ser de um processo novo)
      if (t.killed || this.terms.get(id) !== t) return;
      this.flush(id);
      this.terms.delete(id);
      this.send('pty:exit', { id, exitCode });
    });
    if (startup && typeof startup === 'string' && startup.length < 500) {
      // comando de abertura (ex.: claude --continue), escolhido pelo próprio usuário no layout
      setTimeout(() => { if (this.terms.has(id)) proc.write(startup + '\r'); }, 300);
    }
    return { id, cwd: dir };
  }

  flush(id) {
    const t = this.terms.get(id);
    if (!t) return;
    t.timer = null;
    if (t.pending) {
      const data = t.pending; t.pending = '';
      t.tail = (t.tail + data).slice(-REPLAY);
      this.send('pty:data', { id, data });
    }
    if (t.paused) { t.paused = false; try { t.proc.resume(); } catch {} }
  }

  replay(id) { const t = this.terms.get(id); return t ? t.tail : null; }

  write(id, data) {
    const t = this.terms.get(id);
    if (!t || typeof data !== 'string') return false;
    t.proc.write(data);
    return true;
  }

  // Enviar um prompt da fila para o terminal (D4): só por clique do usuário, como colagem (bracketed paste),
  // sem Enter automático — o usuário confere e aperta Enter.
  // programa em primeiro plano no terminal (node-pty): 'zsh', ou '2.1.319' para o Claude (o binário tem o nome da versão)
  foreground(id) { const t = this.terms.get(id); try { return t ? String(t.proc.process || '') : ''; } catch { return ''; } }

  paste(id, text) {
    if (typeof text !== 'string' || !text.length || text.length > MAX_PASTE) return false;
    const clean = text.replace(/\x1b\[20[01]~/g, '');   // impede sair do modo colagem por dentro do texto
    return this.write(id, `\x1b[200~${clean}\x1b[201~`);
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (!t) return;
    const c = Math.max(2, Math.min(1000, cols | 0)); const r = Math.max(1, Math.min(500, rows | 0));
    if (t.cols === c && t.rows === r) return;
    t.cols = c; t.rows = r;
    try { t.proc.resize(c, r); } catch {}
    this.send('pty:size', { id, cols: c, rows: r });
  }

  kill(id) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    t.killed = true;
    const pid = t.proc.pid;
    try { t.proc.kill(); } catch {}
    // garante que nada do terminal fica rodando (claude, npm run dev…): HUP para a sessão inteira do pty
    if (pid) execFile('pkill', ['-HUP', '-s', String(pid)], () => {});
    this.terms.delete(id);
  }

  killAll() { for (const id of [...this.terms.keys()]) this.kill(id); }
}

function safeDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { PtyManager, MAX_TERMINALS };
