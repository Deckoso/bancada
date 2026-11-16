// Barra de status do Claude aberta pela Bancada (v0.8, medidor de limite). Roda FORA do app: a Bancada copia este arquivo
// para <pasta de dados>/hooks/status-line.js e o Claude o chama como "statusLine" (pelo --settings da Bancada), com o
// executável da Bancada em modo Node. Sem dependências: só módulos do Node.
// 1. Lê o JSON da entrada; se tem rate_limits (five_hour / seven_day), grava { five_hour, seven_day, at, account } em
//    limits/<BANCADA_TERM_ID>.json (troca atômica). A Bancada lê dali e mostra "Limite 5 h: 62% · semana: 41%".
// 2. ENCADEIA a barra do próprio usuário: o --settings da Bancada passa por cima da dele, então aqui procuramos o
//    statusLine DELE (só ~/.claude/settings.local.json e ~/.claude/settings.json — nunca o .claude/ da pasta do
//    projeto: um repositório baixado traria o próprio comando, e aqui ninguém conferiu se a pasta é confiável),
//    rodamos com a mesma entrada (tempo curto; no estouro morre a árvore toda) e devolvemos a saída. Respeita o
//    disableAllHooks do usuário. Sem barra do usuário: uma linha curta nossa.
//    Nunca escreve nos arquivos de configuração do usuário.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_IN = 1024 * 1024;
const MAX_OUT = 16 * 1024;
const CHAIN_MS = 2000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const OURS = /status-line\.(js|cmd)/;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function win(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = num(w.used_percentage); if (pct == null) return null;
  return { pct: Math.max(0, Math.min(100, pct)), resets_at: num(w.resets_at) };
}
function limitsOf(data) {
  const r = data && data.rate_limits;
  if (!r || typeof r !== 'object') return null;
  const five = win(r.five_hour), week = win(r.seven_day);
  return five || week ? { five_hour: five, seven_day: week } : null;
}
// conta = pasta de configuração do Claude (CLAUDE_CONFIG_DIR); só um resumo, nunca o caminho
function accountOf(env) { return env.CLAUDE_CONFIG_DIR ? crypto.createHash('sha256').update(String(env.CLAUDE_CONFIG_DIR)).digest('hex').slice(0, 8) : 'padrao'; }

function save(dir, id, lim, env, now = Date.now()) {
  if (!ID_RE.test(String(id || '')) || !lim) return false;
  const d = path.join(dir, 'limits');
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const tmp = path.join(d, `.${id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ ...lim, at: now, account: accountOf(env) }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(d, `${id}.json`));
    return true;
  } catch { return false; }
}

// pasta (do ambiente) que não pode vir de dentro do projeto: o bloco "env" do settings de um projeto pode mudar HOME ou
// CLAUDE_CONFIG_DIR para uma pasta do próprio repositório
function insideAny(p, dirs) {
  const r = path.resolve(p);
  return dirs.some(d => { const b = path.resolve(d); return r === b || r.startsWith(b.endsWith(path.sep) ? b : b + path.sep); });
}
function safeDir(v, avoid) { return typeof v === 'string' && v && path.isAbsolute(v) && !insideAny(v, avoid) ? v : null; }

// statusLine do PRÓPRIO usuário: <config do Claude>/settings.local.json > settings.json. avoid = pastas do projeto.
// disableAllHooks: true no settings do usuário → nada encadeado.
function userStatusLine(avoid, env) {
  const dirs = (Array.isArray(avoid) ? avoid : [avoid]).filter(d => typeof d === 'string' && d);
  let sysHome = ''; try { sysHome = os.userInfo().homedir; } catch {}
  sysHome = sysHome || os.homedir();
  const envHome = env.HOME || env.USERPROFILE;
  const home = envHome && path.resolve(envHome) === path.resolve(sysHome) ? sysHome : safeDir(envHome, dirs) || sysHome;
  const cfg = safeDir(env.CLAUDE_CONFIG_DIR, dirs) || path.join(home, '.claude');
  let found = null;
  for (const f of [path.join(cfg, 'settings.local.json'), path.join(cfg, 'settings.json')]) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (j && j.disableAllHooks === true) return null;
    const s = j && j.statusLine;
    if (!found && s && s.type === 'command' && typeof s.command === 'string' && s.command.trim()) found = { command: s.command, file: f };
  }
  if (found && OURS.test(found.command)) return null;      // nunca chama a si mesmo
  return found;
}

function gitBash(env) {
  const c = [env.CLAUDE_CODE_GIT_BASH_PATH, path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')].filter(Boolean);
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
function shellFor(command, env, isWin = process.platform === 'win32') {
  if (!isWin) { const sh = /\/(bash|zsh|sh)$/.test(env.SHELL || '') ? env.SHELL : '/bin/sh'; return [sh, ['-c', command]]; }
  const bash = gitBash(env);
  if (bash) return [bash, ['-c', command]];
  const ps = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return [ps, ['-NoProfile', '-NonInteractive', '-Command', command]];
}

function runUser(command, input, { cwd, env, timeout = CHAIN_MS } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...env, BANCADA_STATUSLINE_CHAIN: '1' };
    delete childEnv.ELECTRON_RUN_AS_NODE;          // o comando do usuário não pode herdar o modo Node da Bancada
    const [bin, args] = shellFor(command, env);
    let out = '', done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const isWin = process.platform === 'win32';
    // Mac/Linux: grupo de processos próprio, para o estouro matar o comando E os filhos dele (nada órfão)
    let p; try { p = spawn(bin, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : undefined, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: !isWin }); } catch { return resolve(null); }
    const t = setTimeout(() => { killTree(p, isWin); fin(out || null); }, timeout);
    p.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString('utf8'); });
    p.on('error', () => fin(null));
    p.on('close', () => fin(out));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

function killTree(p, isWin) {
  if (!p || !p.pid) return;
  if (isWin) {
    try { spawn(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    try { p.kill(); } catch {}
    return;
  }
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} }
}

const fmtPct = (w) => `${Math.round(w.pct)}%`;
function ownLine(data, lim) {
  const parts = [];
  if (lim && lim.five_hour) parts.push(`5 h ${fmtPct(lim.five_hour)}`);
  if (lim && lim.seven_day) parts.push(`semana ${fmtPct(lim.seven_day)}`);
  const model = data && data.model && typeof data.model.display_name === 'string' ? data.model.display_name.slice(0, 40) : '';
  return [model, parts.length ? 'limite ' + parts.join(' · ') : ''].filter(Boolean).join(' · ') || 'Bancada';
}

async function handle(raw, { dir = __dirname, env = process.env } = {}) {
  let data = null; try { data = JSON.parse(raw); } catch {}
  const lim = limitsOf(data);
  if (lim) save(dir, env.BANCADA_TERM_ID, lim, env);
  if (!env.BANCADA_STATUSLINE_CHAIN) {
    const ws = (data && data.workspace) || {};
    // pasta do projeto: só para EVITAR (nunca lemos o .claude/ dela) e como pasta de trabalho do comando do usuário
    const proj = typeof ws.project_dir === 'string' && path.isAbsolute(ws.project_dir) ? ws.project_dir : null;
    const avoid = [proj, ws.current_dir, data && data.cwd].filter(d => typeof d === 'string' && path.isAbsolute(d));
    const user = userStatusLine(avoid, env);
    if (user) {
      const out = await runUser(user.command, raw, { cwd: proj, env });
      if (out && out.trim()) return out.replace(/\s+$/, '') + '\n';
    }
  }
  return ownLine(data, lim) + '\n';
}

function main() {
  const chunks = []; let size = 0;
  const guard = setTimeout(() => process.exit(0), 8000); guard.unref();
  process.stdin.on('data', (c) => { if (size < MAX_IN) { chunks.push(c); size += c.length; } });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    handle(Buffer.concat(chunks).toString('utf8')).then((s) => { process.stdout.write(s, () => process.exit(0)); }, () => process.exit(0));
  });
}

if (require.main === module) main();
module.exports = { handle, limitsOf, userStatusLine, ownLine, save, accountOf, shellFor, killTree };
