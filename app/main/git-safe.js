// git automático só em repositório que não pede para rodar programa.
// Um .git/config que veio junto com a pasta (zip com .git, pasta compartilhada, clone de terceiro) pode mandar o git rodar
// programa num simples status/log/diff: filtro clean/smudge, fsmonitor, gpg.program, pager, textconv, driver de merge…
// Os nomes de filtro e de driver são livres, então não dá para desligar tudo por -c. Por isso, antes de qualquer git que a
// Bancada roda sozinha, a config LOCAL do repositório é lida COMO TEXTO (sem chamar o git) — com os arquivos de include e o
// config.worktree — e, se houver chave desse tipo, o git automático fica pausado naquela pasta.
// A config do próprio usuário (~/.gitconfig) é dele e não entra aqui.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const plat = require('./platform');

// valem mais que a config do repositório; o diff ainda vai com --no-ext-diff --no-textconv
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];
const PAUSED_MSG = 'git pausado: este repositório define programas na configuração dele';
const MAX_FILE = 256 * 1024;
const MAX_INCLUDES = 10;

// chaves que fazem o git rodar programa (seção[.subseção].chave, em minúsculas; '*' = subseção qualquer)
const RISKY = [
  /^core\.(fsmonitor|sshcommand|pager|editor|hookspath|askpass|gitproxy|alternaterefscommand)$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^gpg\.program$/, /^gpg\..+\.program$/,
  /^diff\.external$/, /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^credential\.helper$/, /^credential\..+\.helper$/,
  /^uploadpack\./,
  /^sequence\.editor$/,
  /^pager\./,
  /^remote\..+\.(uploadpack|receivepack|vcs)$/,
  /^include\./, /^includeif\./,
];
const BOOL = /^(true|false|yes|no|on|off|1|0|)$/i;

function isRisky(key, value) {
  if (key === 'core.fsmonitor') return !BOOL.test(String(value == null ? '' : value).trim());   // true = o daemon do próprio git
  return RISKY.some(re => re.test(key));
}

// Leitor do formato de config do git, só o necessário para achar as chaves: [seção], [seção "sub"], [seção.sub],
// "chave = valor", "chave" sozinha (= true), comentários # e ;, continuação com \ no fim da linha.
function parseConfig(text) {
  const out = [];
  let section = '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (/\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    let s = line.trim();
    if (!s || s[0] === '#' || s[0] === ';') continue;
    if (s[0] === '[') {
      const m = /^\[\s*([A-Za-z0-9.-]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(s);
      if (!m) { section = '?'; continue; }
      const [name, ...dotted] = m[1].split('.');
      const sub = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : dotted.length ? dotted.join('.').toLowerCase() : null;
      section = name.toLowerCase() + (sub != null ? '.' + sub.toLowerCase() : '');
      s = m[3].trim();                       // "[core] pager = x" na mesma linha também vale
      if (!s || s[0] === '#' || s[0] === ';') continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(s);
    if (!m) continue;
    let value = m[2] == null ? null : m[2].replace(/\s*[#;].*$/, '').replace(/^"(.*)"$/, '$1');
    out.push({ key: `${section}.${m[1].toLowerCase()}`, value });
  }
  return out;
}

// pasta .git do repositório que contém `dir` (como o git procura: sobe até achar .git, pasta ou arquivo "gitdir:")
function findGitDir(dir) {
  let cur; try { cur = path.resolve(dir); } catch { return null; }
  for (let n = 0; n < 64; n++) {
    const dotgit = path.join(cur, '.git');
    let st = null; try { st = fs.statSync(dotgit); } catch {}
    if (st && st.isDirectory()) return { gitDir: dotgit, commonDir: dotgit };
    if (st && st.isFile()) {
      let txt = ''; try { txt = fs.readFileSync(dotgit, 'utf8').slice(0, 4096); } catch {}
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(txt);
      if (!m) return null;
      const gitDir = path.resolve(cur, m[1]);
      let commonDir = gitDir;
      try { const c = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(); if (c) commonDir = path.resolve(gitDir, c); } catch {}
      return { gitDir, commonDir };
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

function expandInclude(p, baseDir) {
  if (!p) return null;
  let s = String(p).trim();
  if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  if (plat.isNetworkPath(s)) return { net: true };             // nunca abrir caminho de rede só para ler (SMB/NTLM)
  if (/^%\(/.test(s)) return null;                             // %(prefix)/… — da instalação do git, não do repositório
  return { file: path.resolve(baseDir, s) };
}

// lê a config local (e o que ela inclui) sem executar nada; devolve { files: [{file, mtimeMs, size}], risky: [chaves] }
function scanRepo(dir) {
  const loc = findGitDir(dir);
  if (!loc) return { repo: false, files: [], risky: [] };
  const queue = [path.join(loc.commonDir, 'config'), path.join(loc.gitDir, 'config.worktree')];
  const seen = new Set(); const files = []; const risky = new Set();
  while (queue.length && seen.size < MAX_INCLUDES + 2) {
    const file = queue.shift();
    if (seen.has(file)) continue; seen.add(file);
    let st; try { st = fs.statSync(file); } catch { files.push({ file, mtimeMs: 0, size: -1 }); continue; }
    files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE) { risky.add('(config grande demais para conferir)'); continue; }
    let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const { key, value } of parseConfig(text)) {
      if (isRisky(key, value)) risky.add(key);
      if (/^include(if\..*)?\.path$/.test(key)) {
        const inc = expandInclude(value, path.dirname(file));
        if (inc && inc.net) risky.add(key + ' (caminho de rede)');
        else if (inc && inc.file) queue.push(inc.file);
      }
    }
  }
  return { repo: true, files, risky: [...risky].slice(0, 20) };
}

// decisão por pasta, em cache; vale enquanto nenhum dos arquivos lidos mudar (mtime/tamanho) e o .git for o mesmo
const cache = new Map();
const sigOf = (files) => files.map(f => { let st = null; try { st = fs.statSync(f.file); } catch {} return `${f.file}|${st ? st.mtimeMs : 0}|${st ? st.size : -1}`; }).join('\n');

function check(dir) {
  const key = String(dir);
  const loc = findGitDir(key);
  const hit = cache.get(key);
  if (hit && hit.loc === (loc && loc.gitDir) && hit.sig === sigOf(hit.files)) return hit.result;
  const r = scanRepo(key);
  const result = r.risky.length ? { ok: false, paused: true, reason: PAUSED_MSG, keys: r.risky } : { ok: true, repo: r.repo };
  cache.set(key, { loc: loc && loc.gitDir, files: r.files, sig: r.files.map(f => `${f.file}|${f.mtimeMs}|${f.size}`).join('\n'), result });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return result;
}

function pausedError() { const e = new Error(PAUSED_MSG); e.code = 'GIT_PAUSED'; return e; }

module.exports = { SAFE_GIT, PAUSED_MSG, check, parseConfig, findGitDir, scanRepo, isRisky, pausedError, _cache: cache };
