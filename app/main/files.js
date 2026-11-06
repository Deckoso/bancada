// Aba Arquivos (BP-2026-11-05-001 E2): árvore do projeto, só leitura. Guarda D7: todo caminho pedido precisa ficar
// DENTRO da pasta do projeto depois de resolver links simbólicos (vale para o Mac e para o celular).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_ENTRIES = 20000;
const MAX_TEXT = 512 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const IGNORE = new Set(['.git', 'node_modules', 'dist', 'dist-next', 'build', '.next', '.DS_Store', '.cache', 'coverage', '.turbo', '__pycache__', '.venv']);
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function denied(msg = 'caminho fora do projeto') { const e = new Error(msg); e.code = 'PATH_DENIED'; return e; }

// rel: caminho relativo à raiz do projeto ('' = a própria raiz). Retorna o caminho absoluto real, ou lança PATH_DENIED.
function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.length > 2048 || rel.includes('\0')) throw denied('caminho inválido');
  if (path.isAbsolute(rel)) throw denied();
  let realRoot; try { realRoot = fs.realpathSync(root); } catch { throw denied('pasta do projeto não existe'); }
  const full = path.resolve(realRoot, rel);
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(full)) throw denied();
  let real; try { real = fs.realpathSync(full); } catch { const e = new Error('arquivo não encontrado'); e.code = 'NOT_FOUND'; throw e; }
  if (!inside(real)) throw denied('link simbólico aponta para fora do projeto');
  return real;
}

function git(root, args, { maxBuffer = 8 * 1024 * 1024, timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { timeout, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

// lista do git (respeita .gitignore), em cache curto por raiz
const cache = new Map();   // root -> { at, files: string[] | null }
async function gitFiles(root) {
  const c = cache.get(root);
  if (c && Date.now() - c.at < 5000) return c.files;
  const out = await git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  let files = null;
  if (out != null) { files = String(out).split('\0').filter(Boolean); if (files.length > MAX_ENTRIES) files = files.slice(0, MAX_ENTRIES); }
  cache.set(root, { at: Date.now(), files });
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return files;
}

// filhos imediatos de `rel` (pastas primeiro). { entries: [{name, rel, dir}], truncated, git }
async function list(root, rel = '') {
  const dirAbs = resolveInside(root, rel);
  const relNorm = path.relative(fs.realpathSync(root), dirAbs);
  const files = await gitFiles(root);
  const seen = new Map();
  if (files) {
    const pre = relNorm ? relNorm + '/' : '';
    for (const f of files) {
      if (pre && !f.startsWith(pre)) continue;
      const rest = f.slice(pre.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (!name || seen.has(name)) continue;
      seen.set(name, slash >= 0);
    }
  } else {
    let ents = []; try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch {}
    for (const e of ents.slice(0, 5000)) if (!IGNORE.has(e.name)) seen.set(e.name, e.isDirectory());
  }
  const entries = [...seen.entries()].map(([name, dir]) => ({ name, dir, rel: relNorm ? `${relNorm}/${name}` : name }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'pt', { numeric: true }) : a.dir ? -1 : 1));
  return { entries: entries.slice(0, 2000), truncated: entries.length > 2000, git: !!files };
}

// prévia de um arquivo: texto (até 512 KB), imagem (miniatura até 5 MB) ou "binário"
function read(root, rel) {
  const abs = resolveInside(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) { const e = new Error('é uma pasta'); e.code = 'INVALID'; throw e; }
  const ext = path.extname(abs).toLowerCase();
  if (IMAGE_EXT[ext]) {
    if (st.size > MAX_IMAGE) return { kind: 'binary', size: st.size, note: 'imagem grande demais para a prévia' };
    return { kind: 'image', size: st.size, dataUrl: `data:${IMAGE_EXT[ext]};base64,${fs.readFileSync(abs).toString('base64')}` };
  }
  const len = Math.min(st.size, MAX_TEXT);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(abs, 'r'); fs.readSync(fd, buf, 0, len, 0); fs.closeSync(fd);
  if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary', size: st.size };
  return { kind: 'text', size: st.size, text: buf.toString('utf8'), truncated: st.size > MAX_TEXT };
}

module.exports = { resolveInside, list, read, git, IGNORE };
