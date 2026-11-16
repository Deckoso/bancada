// Medidor de limite (v0.8): quanto da cota do plano do Claude já foi usada (janela de 5 h e da semana).
// Fonte: a barra de status do próprio Claude (rate_limits no JSON da statusLine), que a Bancada liga pelo --settings de
// cada terminal com o status-line.js (ver lá: grava os números e ENCADEIA a barra do usuário, sem nunca sobrescrever
// os arquivos dele). Aqui: instalar o script + montar o statusLine do sistema, e ler os números para a tela.
// Memória: no máximo 40 arquivos pequenos lidos a cada 5 s; arquivos de mais de 8 dias são apagados.
'use strict';
const fs = require('fs');
const path = require('path');
const plat = require('./platform');
const { cmdLauncher, CMD_UNSAFE } = require('./hooks');

const POLL_MS = 5000;
const MAX_FILES = 40;
const MAX_AGE = 8 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Windows: o Claude roda a statusLine pelo Git Bash (se houver) ou pelo PowerShell; a forma que serve nos dois é o
// caminho do .cmd com barras normais, sem espaço nem aspas. Sob a pasta do usuário, vira ~/… (o nome com acento ou
// espaço fica fora). Caminho que não cabe nisso → sem medidor no Windows (devolve null).
const SAFE_WIN = /^[A-Za-z0-9._~:\/-]+$/;
function winCommand(cmdFile, env = process.env) {
  const p = String(cmdFile).replace(/\\/g, '/');
  const home = String(env.USERPROFILE || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = home && p.toLowerCase().startsWith(home.toLowerCase() + '/') ? '~' + p.slice(home.length) : p;
  return SAFE_WIN.test(rel) ? rel : null;
}

// copia o script para a pasta dos hooks e devolve o "statusLine" para o settings.json da Bancada (ou null)
function install({ dir, exe = process.execPath, win = plat.IS_WIN, env = process.env }) {
  try {
    fs.mkdirSync(path.join(dir, 'limits'), { recursive: true, mode: 0o700 });
    const js = path.join(dir, 'status-line.js');
    fs.writeFileSync(js, fs.readFileSync(path.join(__dirname, 'status-line.js')), { mode: 0o600 });
    if (!win) return { type: 'command', command: `ELECTRON_RUN_AS_NODE=1 ${q(exe)} ${q(js)}`, padding: 0 };
    if (CMD_UNSAFE.test(String(exe))) return null;     // executável com & ^ % ( ) ! " < > |: o .cmd não é seguro → sem medidor
    const cmd = path.join(dir, 'status-line.cmd');
    fs.writeFileSync(cmd, cmdLauncher('status-line.js', exe, env, { args: '' }), { mode: 0o600 });
    const c = winCommand(cmd, env);
    return c ? { type: 'command', command: c, padding: 0 } : null;
  } catch { return null; }
}

// Junta as leituras: por conta, a mais recente; janela que já virou (resets_at no passado) some.
function aggregate(readings, now = Date.now()) {
  const by = new Map();
  for (const r of readings) {
    if (!r || typeof r.at !== 'number') continue;
    const k = typeof r.account === 'string' ? r.account.slice(0, 16) : 'padrao';
    const cur = by.get(k);
    if (!cur || r.at > cur.at) by.set(k, r);
  }
  const live = (w) => (w && typeof w.pct === 'number' && (!w.resets_at || w.resets_at * 1000 > now) ? { pct: Math.round(w.pct), resets_at: w.resets_at || null } : null);
  const accounts = [];
  for (const [account, r] of by) {
    const five = live(r.five_hour), week = live(r.seven_day);
    if (five || week) accounts.push({ account, five_hour: five, seven_day: week, at: r.at });
  }
  accounts.sort((a, b) => b.at - a.at);
  return { accounts };
}

class Limits {
  constructor({ dir, onChange = () => {}, now = Date.now }) {
    this.dir = path.join(dir, 'limits'); this.onChange = onChange; this.now = now;
    this.last = ''; this.state = { accounts: [] }; this.timer = null;
  }
  start() { this.read(); this.timer = setInterval(() => this.read(), POLL_MS); return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  read() {
    const now = this.now();
    let files = []; try { files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json') && ID_RE.test(f.slice(0, -5))); } catch {}
    const readings = [];
    for (const f of files.slice(0, MAX_FILES)) {
      const p = path.join(this.dir, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > MAX_AGE) { fs.unlinkSync(p); continue; }
        if (st.size > 4096) continue;
        readings.push(JSON.parse(fs.readFileSync(p, 'utf8')));
      } catch {}
    }
    this.state = aggregate(readings, now);
    const s = JSON.stringify(this.state);
    if (s !== this.last) { this.last = s; try { this.onChange(this.state); } catch {} }
    return this.state;
  }
  list() { return this.state; }
}

module.exports = { install, aggregate, Limits, winCommand };
