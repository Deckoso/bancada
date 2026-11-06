// Cadastro inicial (D15): lista pastas git em PROJETOS/<categoria>/<projeto> para o usuário escolher.
'use strict';
const fs = require('fs');
const path = require('path');

const LIVE_CATEGORY = /live|twitch|stream/i;   // categoria de live/stream → projetos tipo 'live'

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function discoverProjects(root, registered = []) {
  const known = new Set(registered.flatMap(p => p.paths || []));
  const out = [];
  if (!isDir(root)) return out;
  for (const cat of fs.readdirSync(root).sort()) {
    const catDir = path.join(root, cat);
    if (!/^\d{2}-/.test(cat) || !isDir(catDir)) continue;   // só categorias 01-trabalho, 02-pessoal…
    for (const name of fs.readdirSync(catDir).sort()) {
      const dir = path.join(catDir, name);
      if (name.startsWith('.') || name === 'node_modules' || !isDir(dir)) continue;
      const hasGit = fs.existsSync(path.join(dir, '.git'));
      let mtime = 0;
      try { mtime = fs.statSync(hasGit ? path.join(dir, '.git') : dir).mtimeMs; } catch {}
      out.push({ name, path: dir, category: cat, git: hasGit, kind: LIVE_CATEGORY.test(cat) ? 'live' : 'software', registered: known.has(dir), mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

module.exports = { discoverProjects };
