// Aba Mudanças (BP-2026-11-05-001 E2): o que mudou desde o último commit, diff por arquivo e commit dos SELECIONADOS.
// Nunca faz push. Sempre execFile (sem shell) e "--" antes dos caminhos; cada caminho passa pela guarda do files.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { resolveInside } = require('./files');

const MAX_DIFF = 1024 * 1024;
const MAX_ENTRIES = 2000;

function run(root, args, { timeout = 8000, maxBuffer = 4 * 1024 * 1024, input } = {}) {
  return new Promise((resolve) => {
    const p = execFile('git', ['-C', root, ...args], { timeout, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
    if (input != null) { p.stdin.end(input); }
  });
}

// porcelain v2 -z: caminhos relativos à raiz do REPOSITÓRIO; convertemos para relativos à pasta do projeto
function parseStatus(raw, prefix = '') {
  const parts = raw.split('\0');
  const out = [];
  for (let i = 0; i < parts.length && out.length < MAX_ENTRIES; i++) {
    const line = parts[i]; if (!line) continue;
    const strip = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    if (line.startsWith('? ')) { out.push({ path: strip(line.slice(2)), code: '?', staged: false }); continue; }
    if (line.startsWith('! ')) continue;
    const f = line.split(' ');
    if (f[0] === '1') { const xy = f[1]; out.push({ path: strip(f.slice(8).join(' ')), code: codeOf(xy), staged: xy[0] !== '.' }); }
    else if (f[0] === '2') { const xy = f[1]; out.push({ path: strip(f.slice(9).join(' ')), from: strip(parts[++i] || ''), code: 'R', staged: xy[0] !== '.' }); }
    else if (f[0] === 'u') out.push({ path: strip(f.slice(10).join(' ')), code: 'U', staged: false });
  }
  return out;
}
function codeOf(xy) { const c = xy[1] !== '.' ? xy[1] : xy[0]; return c === 'M' || c === 'A' || c === 'D' || c === 'R' || c === 'C' ? (c === 'C' ? 'A' : c) : 'M'; }

async function status(root) {
  const top = await run(root, ['rev-parse', '--show-prefix']);
  if (!top.ok) return { git: false, files: [] };
  const prefix = top.out.trim();
  const st = await run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.']);
  const br = await run(root, ['branch', '--show-current']);
  const files = st.ok ? parseStatus(st.out, prefix) : [];
  return { git: true, branch: br.ok ? br.out.trim() || null : null, files, truncated: files.length >= MAX_ENTRIES };
}

async function diff(root, rel) {
  const abs = resolveInsideOrDeleted(root, rel);
  const st = await status(root);
  const entry = st.files.find(f => f.path === rel);
  if (!entry) return { text: '', note: 'sem mudanças neste arquivo' };
  if (entry.code === '?' || (entry.code === 'A' && !(await run(root, ['rev-parse', '--verify', 'HEAD'])).ok)) {
    // arquivo novo: mostra o conteúdo inteiro como adicionado
    let buf; try { buf = fs.readFileSync(abs); } catch { return { text: '', note: 'não deu para ler o arquivo' }; }
    if (buf.subarray(0, 8192).includes(0)) return { text: '', note: 'arquivo binário novo' };
    const body = buf.subarray(0, MAX_DIFF).toString('utf8');
    return { text: `--- /dev/null\n+++ b/${rel}\n` + body.split('\n').map(l => '+' + l).join('\n'), truncated: buf.length > MAX_DIFF, code: entry.code };
  }
  const r = await run(root, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--', rel], { maxBuffer: MAX_DIFF * 2 });
  let text = r.out;
  const truncated = text.length > MAX_DIFF;
  if (truncated) text = text.slice(0, MAX_DIFF);
  return { text, truncated, code: entry.code };
}

// arquivo apagado não existe no disco: aceita se o caminho (sem resolver o arquivo) cai dentro da pasta
function resolveInsideOrDeleted(root, rel) {
  try { return resolveInside(root, rel); }
  catch (e) {
    if (e.code !== 'NOT_FOUND') throw e;
    const dir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    let parent; try { parent = resolveInside(root, dir); } catch (e2) { if (e2.code === 'NOT_FOUND') return path.join(fs.realpathSync(root), rel); throw e2; }
    return path.join(parent, path.basename(rel));
  }
}

// commit só dos arquivos escolhidos, que precisam estar na lista de mudanças. Sem push.
async function commit(root, files, message) {
  const msg = String(message || '').trim();
  if (!msg) { const e = new Error('escreva a mensagem do commit'); e.code = 'INVALID'; throw e; }
  const st = await status(root);
  if (!st.git) { const e = new Error('esta pasta não é um repositório git'); e.code = 'INVALID'; throw e; }
  const changed = new Map(st.files.map(f => [f.path, f]));
  const pick = [...new Set(files)];
  if (!pick.length) { const e = new Error('marque pelo menos um arquivo'); e.code = 'INVALID'; throw e; }
  const paths = [];
  for (const f of pick) {
    const ent = changed.get(f);
    if (!ent) { const e = new Error(`"${f}" não está nas mudanças`); e.code = 'INVALID'; throw e; }
    resolveInsideOrDeleted(root, f);
    paths.push(f); if (ent.from) paths.push(ent.from);
  }
  const add = await run(root, ['add', '-A', '--', ...paths]);
  if (!add.ok) { const e = new Error('git add falhou: ' + add.err.slice(0, 300)); e.code = 'GIT'; throw e; }
  // a mensagem vai por stdin (-F -): sem limite de linha de comando e sem interpretar nada
  const c = await run(root, ['commit', '-F', '-', '--', ...paths], { input: msg, timeout: 60000 });
  if (!c.ok) { const e = new Error('git commit falhou: ' + (c.err || c.out).slice(0, 400)); e.code = 'GIT'; throw e; }
  const h = await run(root, ['log', '-1', '--format=%h']);
  return { hash: h.out.trim(), files: pick.length };
}

module.exports = { status, diff, commit, parseStatus };
