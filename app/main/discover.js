// Cadastro inicial: lista as pastas de projeto para a pessoa escolher na primeira abertura.
// Dois jeitos, somados:
// 1. pasta organizada por categoria: <raiz>/<NN-categoria>/<projeto> (ex.: Projetos/01-trabalho/loja) — todo projeto entra;
// 2. varredura rasa nos lugares onde se costuma guardar código (Documentos, Área de Trabalho, Developer, Projects,
//    source/repos, repos): até 2 níveis abaixo de cada lugar, no máximo MAX_VISITS pastas olhadas no total, e só entra
//    pasta que tem .git. Nunca segue link simbólico, nunca olha caminho de rede (no Windows, só olhar um \\servidor já
//    abre conexão SMB para fora) e pula pastas de sistema/dependências.
'use strict';
const fs = require('fs');
const path = require('path');
const { isNetworkPath } = require('./platform');

const LIVE_CATEGORY = /live|twitch|stream/i;   // categoria de live/stream → projetos tipo 'live'
const MAX_DEPTH = 2;
const MAX_VISITS = 200;
// pastas que nunca são projeto nem contêm projeto que valha a varredura
const SKIP = new Set(['node_modules', '.git', 'Library', 'AppData', 'Applications', 'Pictures', 'Music', 'Movies', 'Videos',
  '$RECYCLE.BIN', 'System Volume Information', 'vendor', 'dist', 'build', 'target', '__pycache__', 'venv']);

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isRealDir(p) { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }
function gitMtime(dir) { try { return fs.statSync(path.join(dir, '.git')).mtimeMs; } catch { return 0; } }
function hasGit(dir) { try { fs.lstatSync(path.join(dir, '.git')); return true; } catch { return false; } }
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

// 1. <raiz>/<NN-categoria>/<projeto>
function categorized(root, known) {
  const out = [];
  if (!root || isNetworkPath(root) || !isDir(root)) return out;
  let cats = []; try { cats = fs.readdirSync(root).sort(); } catch { return out; }
  for (const cat of cats) {
    const catDir = path.join(root, cat);
    if (!/^\d{2}-/.test(cat) || !isDir(catDir)) continue;   // só categorias 01-trabalho, 02-pessoal…
    let names = []; try { names = fs.readdirSync(catDir).sort(); } catch { continue; }
    for (const name of names) {
      const dir = path.join(catDir, name);
      if (name.startsWith('.') || name === 'node_modules' || !isDir(dir)) continue;
      const git = hasGit(dir);
      let mtime = 0;
      try { mtime = fs.statSync(git ? path.join(dir, '.git') : dir).mtimeMs; } catch {}
      out.push({ name, path: dir, category: cat, git, kind: LIVE_CATEGORY.test(cat) ? 'live' : 'software', registered: known.has(dir), mtime });
    }
  }
  return out;
}

// 2. varredura rasa: [{ dir, label }] na ordem dada (as pastas próprias de código primeiro, Documentos por último)
function shallow(roots, known, { maxDepth = MAX_DEPTH, maxVisits = MAX_VISITS, skipDirs = [] } = {}) {
  const out = [];
  let visits = 0;
  for (const { dir: root, label } of roots) {
    if (!root || isNetworkPath(root) || !isRealDir(root)) continue;
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length && visits < maxVisits) {
      const { dir, depth } = queue.shift();
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      ents.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of ents) {
        if (visits >= maxVisits) break;
        // Dirent de link simbólico não é isDirectory(): links nunca são seguidos
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (isNetworkPath(p) || skipDirs.some(s => s && samePath(s, p))) continue;
        visits++;
        if (hasGit(p)) {
          out.push({ name: e.name, path: p, category: label, git: true, kind: LIVE_CATEGORY.test(label) ? 'live' : 'software', registered: known.has(p), mtime: gitMtime(p) });
          continue;   // dentro de um repositório não se procura outro
        }
        if (depth + 1 < maxDepth) queue.push({ dir: p, depth: depth + 1 });
      }
    }
  }
  return out;
}

// root: pasta organizada por categoria (ou null) · roots: lugares da varredura rasa
function discoverProjects(root, registered = [], roots = [], opts = {}) {
  const known = new Set(registered.flatMap(p => p.paths || []));
  const seen = new Set();
  const out = [];
  const add = (x) => { const k = path.resolve(x.path).toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push(x); };
  categorized(root, known).forEach(add);
  shallow(roots, known, { ...opts, skipDirs: [root, ...(opts.skipDirs || [])] }).forEach(add);
  return out.sort((a, b) => b.mtime - a.mtime);
}

module.exports = { discoverProjects, shallow, MAX_DEPTH, MAX_VISITS };
