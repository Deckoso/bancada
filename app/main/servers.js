// Sala de servidores do Escritório (v0.6): cada servidor é um rack com luzes.
// Como: o Mac pergunta "você está de pé?" a cada 60 s — HTTP GET (só o cabeçalho; o corpo é descartado), abertura de
// conexão TCP (fechada na hora, sem login) ou ping. Nenhuma credencial, nenhuma porta aberta, nada instalado nos servidores.
// Estados: ok (verde) · lento (amarelo: > 800 ms ou HTTP 4xx/5xx) · fora (vermelho: a rota existe e não respondeu) ·
// sem-rota (cinza: endereço de outra rede — ex.: IP da rede do escritório estando em casa, Tailscale desligado, sem internet).
// Lista em USER_DIR/servidores.json (0600), editável; o arquivo só aceita http(s)://, tcp:host:porta e ping:host.
// Memória: no máximo 12 servidores × 6 luzes × 30 medidas; uma consulta por luz por vez (nunca acumula).
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const plat = require('./platform');

const MAX_SERVERS = 12;
const MAX_CHECKS = 6;
const HISTORY = 30;
const TIMEOUT_MS = 3000;
const SLOW_MS = 800;
const EVERY_MS = 60 * 1000;
const EVERY_HIDDEN_MS = 5 * 60 * 1000;    // janela escondida: consulta 5× menos

// Lista inicial do repositório público: só um exemplo genérico (nunca endereço real — o código é público; a lista de
// verdade fica só no Mac de quem usa, em USER_DIR/servidores.json).
const DEFAULTS = {
  servidores: [
    { id: 'exemplo', nome: 'Meu servidor', checks: [] },
  ],
};

const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const clip = (s, n) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, n);

// "alvo" → { kind, host, port, url } ou null (recusado). Nada de usuário/senha na URL, nada de esquema estranho.
function parseTarget(alvo) {
  if (typeof alvo !== 'string' || alvo.length > 300) return null;
  const s = alvo.trim();
  let m = /^tcp:([^:\s]+):(\d{1,5})$/.exec(s);
  if (m) { const port = Number(m[2]); if (!HOST_RE.test(m[1]) || port < 1 || port > 65535) return null; return { kind: 'tcp', host: m[1], port }; }
  m = /^ping:([^:\s]+)$/.exec(s);
  if (m) { if (!HOST_RE.test(m[1])) return null; return { kind: 'ping', host: m[1] }; }
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!HOST_RE.test(host)) return null;
  return { kind: 'http', host, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), url: u.toString() };
}

function validate(raw) {
  const list = raw && Array.isArray(raw.servidores) ? raw.servidores : [];
  const out = []; const ids = new Set(); const errors = [];
  for (const s of list.slice(0, MAX_SERVERS)) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id || '');
    if (!/^[a-z0-9-]{1,30}$/.test(id) || ids.has(id)) { errors.push(`id inválido: ${clip(id, 40)}`); continue; }
    ids.add(id);
    const checks = [];
    for (const c of (Array.isArray(s.checks) ? s.checks : []).slice(0, MAX_CHECKS)) {
      const alvo = typeof c === 'string' ? c : c && c.alvo;
      const t = parseTarget(alvo);
      if (!t) { errors.push(`${id}: alvo recusado (${clip(alvo, 60)})`); continue; }
      checks.push({ alvo: clip(alvo, 300), nome: clip((c && c.nome) || t.host, 24), target: t });
    }
    out.push({ id, nome: clip(s.nome || id, 40), checks });
  }
  return { servers: out, errors };
}

// ---------------- rede: dá para chegar lá daqui? ----------------
function ipv4(host) { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host); return m ? m.slice(1).map(Number) : null; }
function block(ip) {
  if (!ip) return null;
  const [a, b] = ip;
  if (a === 10) return '10';
  if (a === 172 && b >= 16 && b <= 31) return '172';
  if (a === 192 && b === 168) return '192';
  if (a === 100 && b >= 64 && b <= 127) return 'ts';     // Tailscale (CGNAT)
  return null;
}
// sem endereço desta rede no Mac → "sem rota" (cinza), sem nem tentar
function routable(host, ifaces = os.networkInterfaces()) {
  const k = block(ipv4(host));
  if (!k) return true;
  for (const list of Object.values(ifaces)) for (const a of list || []) {
    if (a.family !== 'IPv4' && a.family !== 4) continue;
    if (a.internal) continue;
    if (block(ipv4(a.address)) === k) return true;
  }
  return false;
}
const NOROUTE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL']);

function classify(ms, code) { return code && code >= 400 ? 'lento' : ms > SLOW_MS ? 'lento' : 'ok'; }

function probeHttp(t, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let done = false;
    const fin = (r) => { if (done) return; done = true; resolve(r); };
    const lib = t.url.startsWith('https:') ? https : http;
    let req;
    try {
      req = lib.request(t.url, { method: 'GET', headers: { 'User-Agent': 'Bancada/0.6 (status)', Accept: '*/*' }, timeout, agent: false }, (res) => {
        const ms = Date.now() - t0; const code = res.statusCode || 0;
        res.destroy();                                  // só o cabeçalho interessa
        fin({ st: classify(ms, code), ms, code });
      });
    } catch (e) { return fin({ st: 'fora', ms: null, err: e.code || 'erro' }); }
    req.on('timeout', () => { req.destroy(); fin({ st: 'fora', ms: null, err: 'tempo esgotado' }); });
    req.on('error', (e) => fin({ st: NOROUTE.has(e.code) ? 'sem-rota' : 'fora', ms: null, err: e.code || 'erro' }));
    req.end();
  });
}

function probeTcp(t, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let done = false;
    const sock = net.connect({ host: t.host, port: t.port });
    const fin = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeout);
    sock.on('connect', () => { const ms = Date.now() - t0; fin({ st: classify(ms), ms }); });
    sock.on('timeout', () => fin({ st: 'fora', ms: null, err: 'tempo esgotado' }));
    sock.on('error', (e) => fin({ st: NOROUTE.has(e.code) ? 'sem-rota' : 'fora', ms: null, err: e.code || 'erro' }));
  });
}

function probePing(t) {
  return new Promise((resolve) => {
    // Mac: /sbin/ping · Windows: PING.EXE (a resposta vem no idioma do Windows: "tempo=12ms", "time<1ms"…)
    const { bin, args } = plat.pingCommand(t.host);
    execFile(bin, args, { timeout: TIMEOUT_MS + 500, windowsHide: true }, (err, stdout) => {
      const ms = plat.pingMs(stdout);
      if (ms !== null) return resolve({ st: classify(ms), ms });
      resolve({ st: /cannot resolve|No route|Network is unreachable|could not find host|unreachable|inacess|não p[ôo]de encontrar/i.test(String(stdout) + String(err && err.message)) ? 'sem-rota' : 'fora', ms: null, err: 'sem resposta' });
    });
  });
}

async function probe(t, opts = {}) {
  if (!(opts.routable || routable)(t.host)) return { st: 'sem-rota', ms: null, err: 'outra rede' };
  if (t.kind === 'http') return probeHttp(t, opts.timeout);
  if (t.kind === 'tcp') return probeTcp(t, opts.timeout);
  return probePing(t);
}

// pior luz manda no rack; tudo cinza = cinza; sem luz = "configurar"
const RANK = { ok: 0, 'sem-rota': 1, lento: 2, fora: 3 };
function rackState(lights) {
  if (!lights.length) return 'configurar';
  const known = lights.filter(l => l.st && l.st !== 'esperando');
  if (!known.length) return 'esperando';
  if (known.every(l => l.st === 'sem-rota')) return 'sem-rota';
  return known.filter(l => l.st !== 'sem-rota').reduce((w, l) => (RANK[l.st] > RANK[w] ? l.st : w), 'ok');
}

class Servers {
  constructor({ file, onChange, probeFn, every = EVERY_MS } = {}) {
    this.file = file; this.onChange = onChange || (() => {});
    this.probeFn = probeFn || probe;
    this.every = every; this.visible = true;
    this.servers = []; this.errors = []; this.state = new Map();  // alvo -> { st, ms, at, err, hist: [] }
    this.inflight = new Set(); this.timer = null; this.mtime = 0; this.lastRun = 0;
  }

  load() {
    let raw = null;
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs === this.mtime) return false;
      this.mtime = st.mtimeMs;
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') { try { fs.writeFileSync(this.file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 }); this.mtime = fs.statSync(this.file).mtimeMs; } catch {} raw = DEFAULTS; }
      else { this.errors = [`servidores.json ilegível: ${clip(e.message, 80)}`]; return false; }
    }
    const v = validate(raw); this.servers = v.servers; this.errors = v.errors;
    const keep = new Set(this.servers.flatMap(s => s.checks.map(c => c.alvo)));
    for (const k of this.state.keys()) if (!keep.has(k)) this.state.delete(k);
    return true;
  }

  start() { this.load(); this.run(); this.timer = setInterval(() => this.tickle(), 5000); return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  setVisible(v) { const was = this.visible; this.visible = !!v; if (v && !was) this.tickle(); }

  tickle() {
    const gap = this.visible ? this.every : EVERY_HIDDEN_MS;
    if (Date.now() - this.lastRun >= gap) this.run();
  }

  async run() {
    this.lastRun = Date.now();
    if (this.load()) this.emit();
    const jobs = [];
    for (const s of this.servers) for (const c of s.checks) {
      if (this.inflight.has(c.alvo)) continue;        // a anterior ainda não voltou: não empilha
      this.inflight.add(c.alvo);
      jobs.push(Promise.resolve().then(() => this.probeFn(c.target)).catch(() => ({ st: 'fora', ms: null, err: 'erro' })).then((r) => {
        this.inflight.delete(c.alvo);
        const cur = this.state.get(c.alvo) || { hist: [] };
        cur.st = r.st; cur.ms = r.ms; cur.err = r.err || null; cur.code = r.code || null; cur.at = Date.now();
        cur.hist = cur.hist.concat({ at: cur.at, st: r.st, ms: r.ms }).slice(-HISTORY);
        this.state.set(c.alvo, cur);
      }));
    }
    await Promise.all(jobs);
    this.emit();
  }

  list() {
    return {
      at: Date.now(), every: this.every, errors: this.errors.slice(0, 10),
      servers: this.servers.map(s => {
        const lights = s.checks.map(c => {
          const x = this.state.get(c.alvo) || {};
          return { nome: c.nome, alvo: c.alvo, tipo: c.target.kind, st: x.st || 'esperando', ms: x.ms == null ? null : x.ms, err: x.err || null, code: x.code || null, at: x.at || null, hist: x.hist || [] };
        });
        return { id: s.id, nome: s.nome, st: rackState(lights), lights };
      }),
    };
  }

  emit() { try { this.onChange(this.list()); } catch {} }
}

module.exports = { Servers, parseTarget, validate, routable, rackState, probeHttp, probeTcp, DEFAULTS };
