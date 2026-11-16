// Registro de problemas da Bancada (v0.8, "Relatar problema"): <pasta de dados>/logs/bancada.log.
// Rotação 2 × 1 MB: passou de 1 MB, o atual vira bancada.log.1 (o .1 antigo some). Nunca passa de ~2 MB no disco.
// O que entra: início do app, erros do processo principal, da tela e dos processos filhos (com origem e nível).
// O que NUNCA entra: saída de terminal, prompts, respostas das IAs, tokens. Mesmo assim cada linha passa pela redação
// (redact) ao ser gravada e de novo ao montar o diagnóstico — defesa em dobro.
// Teto contra enxurrada: no máximo 120 linhas a cada 10 s; o excesso vira uma linha "N linhas omitidas".
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BYTES = 1024 * 1024;
const HARD_MAX = 2;                      // × MAX_BYTES: acima disso o arquivo atual não cresce mais
const MAX_LINE = 600;
const BURST_MAX = 120, BURST_MS = 10000;
const LEVELS = new Set(['info', 'warn', 'error']);

// ---------- redação ----------
// Tokens e chaves conhecidos, JWT, cookies, blocos PEM, credencial em URL, e-mail, IPs privados/Tailscale (v4 e v6),
// caminho do home → ~ e caminhos absolutos fora do home (C:\…, D:\…, /Volumes/…) → só o nome do arquivo.
// A ordem importa: tokens antes de e-mail (um token pode ter @), credencial de URL antes do e-mail, home antes dos IPs
// e dos caminhos.
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const RULES = [
  [/-----BEGIN [A-Z0-9 ]{3,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{3,40}-----|(?=\n)|$)/g, '[bloco-pem]'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}/g, '[chave-sk]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, '[chave-stripe]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/g, '[token-github]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, '[token-slack]'],
  [/\btskey-[A-Za-z0-9-]{8,}/g, '[chave-tailscale]'],
  [/\bnpm_[A-Za-z0-9]{20,}/g, '[token-npm]'],
  [/\bhf_[A-Za-z0-9]{20,}/g, '[token-hf]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[chave-aws]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[chave-google]'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[jwt]'],
  [/\b(Set-Cookie|Cookie)(\s*:\s*)[^\r\n|]+/gi, '$1$2[oculto]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [oculto]'],
  // palavra-chave também no fim de nomes compostos: access_token, refresh_token, client_secret, x-api-key, id_token…
  [/(?<![A-Za-z0-9])([A-Za-z_-]*(?:token|senha|password|secret|authorization|api[_-]?key|cookie|session))(["']?\s*[:=]\s*["']?)(?!\[)[^\s"',;&]{6,}/gi, '$1$2[oculto]'],
  [/(\b[a-z][a-z0-9+.-]{1,15}:\/\/)[^\/\s:@]+:[^\/\s@]+@/gi, '$1[credencial]@'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|169\.254)\.\d{1,3}\.\d{1,3}\b/g, '[ip-local]'],
  [/\bfd7a:115c:a1e0(?::[0-9a-f]{0,4}){1,6}(?:\/\d{1,3})?/gi, '[ip-local]'],
];
// caminho absoluto fora do home: fica só o nome do arquivo (o resto pode ter nome de cliente, disco, pasta)
const baseOf = (p) => { const parts = String(p).split(/[\\/]+/).filter(Boolean); return parts.length ? parts[parts.length - 1] : ''; };
const PATH_RULES = [
  [/(['"`])((?:[A-Za-z]:[\\/]|\/Volumes\/)[^'"`\n]*)\1/g, (m, q, p) => `${q}…${baseOf(p) ? '/' + baseOf(p) : ''}${q}`],
  // sem aspas: pasta pode ter espaço ("/Volumes/Disco 2/obra/x"); o nome do arquivo para no espaço
  [/(?<![A-Za-z0-9~])(?:[A-Za-z]:[\\/]|\/Volumes\/)(?:[^\s'"`<>|;,()\\/]+(?: [^\s'"`<>|;,()\\/]+)*[\\/])*[^\s'"`<>|;,()\\/]*/g, (p) => `…${baseOf(p) ? '/' + baseOf(p) : ''}`],
];
function redact(text, { home = os.homedir() } = {}) {
  let s = String(text == null ? '' : text);
  for (const [re, to] of RULES) s = s.replace(re, to);
  if (home && home.length > 2) {
    // o caminho do home vira ~ (com / e com \; no Windows sem diferenciar caixa); também o nome do usuário solto em
    // caminhos de outro formato (/Users/<nome>, C:\Users\<nome>)
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
    for (const h of variants) s = s.replace(new RegExp(escRe(h), 'gi'), '~');
    const user = path.basename(home.replace(/\\/g, '/'));
    if (user && user.length > 1) s = s.replace(new RegExp(`([\\\\/](?:Users|home)[\\\\/])${escRe(user)}(?=[\\\\/]|$|\\s)`, 'gi'), '$1~');
  }
  for (const [re, to] of PATH_RULES) s = s.replace(re, to);
  return s;
}

function oneLine(s) { return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_LINE); }
function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

class Log {
  constructor({ dir, maxBytes = MAX_BYTES, now = () => new Date(), home = os.homedir(), onError = null } = {}) {
    this.dir = dir; this.file = path.join(dir, 'bancada.log'); this.old = this.file + '.1';
    this.maxBytes = maxBytes; this.now = now; this.home = home;
    this.onError = onError;               // (linha) → avisado a cada erro gravado (cartão "Travou?")
    this.burst = { start: 0, n: 0, dropped: 0 };
    this.size = -1;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  }

  write(level, origin, msg) {
    const lv = LEVELS.has(level) ? level : 'info';
    const d = this.now(); const t = d.getTime();
    if (t - this.burst.start > BURST_MS) {
      const dropped = this.burst.dropped;
      this.burst = { start: t, n: 0, dropped: 0 };
      if (dropped) this.append(`${stamp(d)} warn  [log] ${dropped} linhas omitidas (muitas em pouco tempo)`);
    }
    if (++this.burst.n > BURST_MAX) { this.burst.dropped++; return false; }
    const line = `${stamp(d)} ${lv.padEnd(5)} [${oneLine(origin).slice(0, 40) || '?'}] ${redact(oneLine(msg), { home: this.home })}`;
    this.append(line);
    if (lv === 'error' && this.onError) { try { this.onError(line); } catch {} }
    return true;
  }
  info(origin, msg) { return this.write('info', origin, msg); }
  warn(origin, msg) { return this.write('warn', origin, msg); }
  error(origin, msg) { return this.write('error', origin, msg); }

  append(line) {
    try {
      if (this.size < 0) { try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; } }
      const buf = Buffer.from(line + '\n', 'utf8');
      if (this.size + buf.length > this.maxBytes && this.size > 0) {
        // só zera a conta se a rotação aconteceu de verdade (no Windows um antivírus/visualizador pode segurar o arquivo)
        let rotated = false;
        try { fs.rmSync(this.old, { force: true }); } catch {}
        try { fs.renameSync(this.file, this.old); rotated = true; } catch {}
        if (rotated) this.size = 0;
      }
      if (this.size + buf.length > HARD_MAX * this.maxBytes) return;   // teto duro: rotação travada → para de escrever
      fs.appendFileSync(this.file, buf, { mode: 0o600 });
      this.size += buf.length;
    } catch {}
  }

  // últimas n linhas (do .1 e do atual), já redigidas de novo
  tail(n = 150) {
    const read = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    const lines = [...read(this.old), ...read(this.file)].slice(-Math.max(1, Math.min(n, 2000)));
    return lines.map(l => redact(l, { home: this.home }));
  }
  errorsSince(t) {
    return this.tail(400).filter(l => / error \[/.test(l) && Date.parse(l.slice(0, 23).replace(' ', 'T')) >= t).length;
  }
}

function errText(e) {
  if (!e) return String(e);
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? ' | ' + e.stack.split('\n').slice(1, 4).map(s => s.trim()).join(' | ') : ''}`;
  return typeof e === 'string' ? e : (() => { try { return JSON.stringify(e).slice(0, 400); } catch { return String(e); } })();
}

// Liga os ganchos do processo principal. Só registra; não muda o que o Electron faria com o erro além de não derrubar.
function attachMain(log, { app, crashReporter, proc = process } = {}) {
  proc.on('uncaughtException', (e) => { log.error('main', 'exceção não tratada: ' + errText(e)); try { console.error(e); } catch {} });
  proc.on('unhandledRejection', (e) => { log.error('main', 'promessa rejeitada sem tratamento: ' + errText(e)); });
  if (app) {
    app.on('render-process-gone', (_e, _wc, d) => { if (d && d.reason !== 'clean-exit') log.error('tela', `processo da tela caiu: ${d.reason} (código ${d.exitCode})`); });
    app.on('child-process-gone', (_e, d) => { if (d && d.reason !== 'clean-exit') log.error('filho', `processo ${d.type}${d.name ? ' ' + d.name : ''} caiu: ${d.reason} (código ${d.exitCode})`); });
  }
  // relatórios de travamento só no disco (pasta Crashpad do Electron); nada sobe para a internet
  if (crashReporter) { try { crashReporter.start({ uploadToServer: false, submitURL: '' }); } catch (e) { log.warn('main', 'crashReporter: ' + errText(e)); } }
}

// Erros da tela: mensagens de console de nível erro. Electron 35+ manda um objeto; antes, argumentos soltos (3 = erro).
function consoleError(args) {
  const [ev, lvl, msg, line, src] = args;
  if (ev && typeof ev === 'object' && 'level' in ev && typeof lvl !== 'number') {
    return ev.level === 'error' ? { message: ev.message, line: ev.lineNumber, src: ev.sourceId } : null;
  }
  return lvl === 3 ? { message: msg, line, src } : null;
}
function attachRenderer(log, wc, { origin = 'tela', allow = () => true } = {}) {
  wc.on('console-message', (...args) => {
    const e = consoleError(args); if (!e || !allow()) return;
    const src = e.src ? path.basename(String(e.src).replace(/\?.*$/, '')) : '';
    log.error(origin, `${e.message}${src ? ` (${src}:${e.line || 0})` : ''}`);
  });
}

module.exports = { Log, redact, attachMain, attachRenderer, consoleError, errText, MAX_BYTES };
