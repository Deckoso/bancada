// Diferenças Mac × Windows num lugar só (v0.7, porte para Windows).
// Regra: o caminho do Mac continua exatamente como era; cada função recebe `win` para os testes rodarem os dois lados
// em qualquer máquina. Nada aqui executa coisa nenhuma — só monta caminhos, argumentos e textos.
'use strict';
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const MACHINE = IS_WIN ? 'PC' : 'Mac';          // como o app chama o computador nos textos

// ---------- aspas ----------
// sh/zsh: aspas simples; ' vira '\''
function qPosix(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// PowerShell: aspas simples literais (nada é expandido); ' vira ''. O PowerShell também trata as aspas TIPOGRÁFICAS
// ‘ ’ ‚ ‛ como aspas simples ("d’água" fechava a string): cada uma também é dobrada.
const PS_SQ = /['\u2018\u2019\u201A\u201B]/g;
function qPs(s) { return "'" + String(s).replace(PS_SQ, '$&$&') + "'"; }
// PowerShell 5.1 estraga argumento com aspas duplas ao repassar para um .exe: troca por aspas simples tipográficas
function psArg(s) { return String(s).replace(/"/g, '\u201d'); }

// Um comando como lista de pedaços { v, quote } + variáveis de ambiente, renderizado para o shell do sistema.
// posix: `A=1 B=2 bin --flag 'valor'` (idêntico ao que a Bancada do Mac sempre gerou)
// windows: `$env:A='1'; $env:B='2'; & 'bin' '--flag' 'valor'`
function renderCommand({ env = [], tokens = [] }, win = IS_WIN) {
  if (!win) return [...env.map(([k, val]) => `${k}=${val}`), ...tokens.map(t => (t.quote ? qPosix(t.v) : t.v))].join(' ');
  const sets = env.map(([k, val]) => `$env:${k}=${qPs(val)};`);
  const argv = tokens.map(t => qPs(psArg(t.v)));
  return [...sets, '&', ...argv].join(' ');
}

// ---------- terminal ----------
function systemRoot() { return process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'; }
// programa do Windows sempre pelo caminho completo (o Windows procura primeiro na pasta atual)
function sys32(exe) { return path.win32.join(systemRoot(), 'System32', exe); }
function powershellExe() { return path.win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }
function defaultShell(win = IS_WIN) { return win ? powershellExe() : (process.env.SHELL || '/bin/zsh'); }

// PowerShell 5.1 escreve na página de código antiga (acentos quebrados): força UTF-8 antes de qualquer coisa
const PS_PRELUDE = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding';

// argumentos do shell do terminal: só shell · programa e depois fica um shell na pasta · programa e acaba (login)
function shellArgs({ shell, exec = null, oneShot = false }, win = IS_WIN) {
  if (!win) return exec ? (oneShot ? ['-l', '-c', exec] : ['-l', '-i', '-c', `${exec}; exec ${shell} -l`]) : ['-l'];
  if (!exec) return ['-NoLogo', '-NoExit', '-Command', PS_PRELUDE];
  return oneShot ? ['-NoLogo', '-Command', `${PS_PRELUDE}; ${exec}`] : ['-NoLogo', '-NoExit', '-Command', `${PS_PRELUDE}; ${exec}`];
}

// PATH: no Windows a chave costuma ser "Path" e o separador é ";". Devolve a chave existente (ou PATH).
function pathKey(env, win = IS_WIN) {
  if (!win) return 'PATH';
  return Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'Path';
}
// define o PATH sem deixar duas chaves (PATH e Path) no mesmo ambiente
function setPath(env, value, win = IS_WIN) {
  const key = pathKey(env, win);
  if (win) for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' && k !== key) delete env[k];
  env[key] = value;
  return env;
}
function getPath(env, win = IS_WIN) { return env[pathKey(env, win)] || ''; }

// ---------- onde cada IA fica instalada ----------
function exeName(bin, win = IS_WIN) { return win ? `${bin}.exe` : bin; }
function aiCandidates(bin, home, win = IS_WIN) {
  if (!win) {
    return [path.join(home, '.local', 'bin', bin), `/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`,
      path.join(home, '.npm-global', 'bin', bin), path.join(home, '.bun', 'bin', bin)];
  }
  const j = path.win32.join;
  const local = process.env.LOCALAPPDATA || j(home, 'AppData', 'Local');
  const out = [j(home, '.local', 'bin', `${bin}.exe`)];
  if (bin === 'agy') out.push(j(local, 'agy', 'bin', 'agy.exe'), j(local, 'Antigravity', 'bin', 'agy.exe'), j(local, 'Programs', 'agy', 'agy.exe'));
  if (bin === 'codex') out.push(j(local, 'codex', 'bin', 'codex.exe'), j(local, 'Programs', 'codex', 'codex.exe'));
  out.push(j(home, '.bun', 'bin', `${bin}.exe`));
  return out;
}

// ---------- ping (sala de servidores) ----------
function pingCommand(host, win = IS_WIN) {
  return win ? { bin: path.win32.join(systemRoot(), 'System32', 'PING.EXE'), args: ['-n', '1', '-w', '2000', host] }
    : { bin: '/sbin/ping', args: ['-c', '1', '-t', '2', host] };
}
// tempo da resposta em ms: "time=12.3 ms" (Mac), "time=12ms" / "tempo=12ms" / "Zeit<1ms" (Windows em qualquer idioma)
function pingMs(stdout) {
  const s = String(stdout || '');
  const m = /time[=<]([\d.]+)\s*ms/i.exec(s) || /[=<]\s*([\d.,]+)\s*ms\b/i.exec(s);
  return m ? Math.round(Number(m[1].replace(',', '.'))) : null;
}

// ---------- saída das tarefas do Claude Code (faixa de atividade) ----------
// Mac: /private/tmp/claude-<uid>/<projeto>/<sessão>/tasks/<id>.output · Windows: dentro da pasta temporária do
// usuário, numa pasta "claude…", sempre .../tasks/<id>.output
const OUTPUT_RE = /^\/(?:private\/)?tmp\/claude-\d+\/[^\0]{1,400}\/tasks\/[A-Za-z0-9_-]{4,60}\.output$/;
const OUTPUT_RE_WIN = /^[A-Za-z]:\\[^\0]{1,400}\\claude[^\\]{0,40}\\[^\0]{1,400}\\tasks\\[A-Za-z0-9_-]{4,60}\.output$/i;
function taskOutputOk(real, { win = IS_WIN, uid = (typeof process.getuid === 'function' ? process.getuid() : null), tmp = os.tmpdir() } = {}) {
  if (typeof real !== 'string') return false;
  if (!win) return OUTPUT_RE.test(real) && (uid === null || real.includes(`/claude-${uid}/`));
  if (!OUTPUT_RE_WIN.test(real)) return false;
  const base = path.win32.resolve(tmp).toLowerCase() + '\\';
  return path.win32.resolve(real).toLowerCase().startsWith(base);
}

// ---------- abrir no editor ----------
function cursorUrl(abs, win = IS_WIN) {
  return win ? `cursor://file/${encodeURI(String(abs).replace(/\\/g, '/'))}` : `cursor://file${encodeURI(abs)}`;
}

// ---------- colar caminho no terminal ----------
// Mac: aspas simples do zsh · Windows: aspas simples do PowerShell (literais: um arquivo chamado "$(…).png" não executa
// nada se o caminho cair num prompt do PowerShell; aspas duplas expandiriam)
function quotePath(p, win = IS_WIN) { return win ? qPs(p) : qPosix(p); }

// ---------- caminho de rede (Windows) ----------
// \\servidor\pasta, //servidor/pasta, /\servidor e \\?\UNC\…: só olhar (stat) já abre SMB/WebDAV para fora e entrega o
// hash NTLM do usuário. A Bancada só mexe em caminho de disco local (C:\…).
function isNetworkPath(p) { return typeof p === 'string' && /^[\\/]{2}/.test(p.trim()); }

module.exports = { isNetworkPath, PS_SQ, sys32, IS_WIN, MACHINE, qPosix, qPs, psArg, renderCommand, defaultShell, powershellExe, shellArgs, PS_PRELUDE,
  pathKey, setPath, getPath, exeName, aiCandidates, pingCommand, pingMs, taskOutputOk, OUTPUT_RE, OUTPUT_RE_WIN, cursorUrl, quotePath };
