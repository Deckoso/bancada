// Links no terminal (v0.6): o que o Claude escreve vira clicável.
//  - caminho de pasta → abre a pasta no Finder;
//  - arquivo .md → abre na visualização de Markdown da Bancada;
//  - outro arquivo → mostra no Finder;
//  - http(s) → abre no Safari.
// Como acha o caminho: o terminal manda o texto a partir de onde parece começar um caminho ("/…", "~/…" ou "pasta/…")
// até o fim da linha; aqui se testa do mais longo para o mais curto (cortando em espaço e pontuação) até achar um que
// existe. É isso que permite caminho com espaço no nome ("Meus Projetos") sem aspas.
// Só leitura de metadado (stat); conteúdo só de .md (até 1 MB). Nenhum caminho é executado.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_RAW = 600;          // texto candidato
const MAX_TRIES = 40;         // cortes testados por candidato
const MAX_CANDIDATES = 24;    // candidatos por linha
const MAX_MD = 1024 * 1024;
const MD_RE = /\.(md|markdown|mdx)$/i;
const WIN_ABS = /^[A-Za-z]:[\\/]/;     // v0.7: C:\pasta ou C:/pasta (Windows)
const { isNetworkPath } = require('./platform');

// pontos de corte: fim, antes de espaço e antes de pontuação que costuma fechar um caminho no texto
function cuts(s) {
  const out = new Set([s.length]);
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t' || '"\'`)]}>,;|'.includes(c)) out.add(i);
  }
  return [...out].sort((a, b) => b - a);
}

// tira o que não é parte do caminho no fim: ".", ",", ":" e ":linha(:coluna)" (estilo arquivo.js:42)
function trimEnd(s) {
  let t = s.replace(/:\d+(?::\d+)?$/, '');
  t = t.replace(/[.,:;!?…]+$/, '');
  return t;
}

function expand(p, bases) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return [path.join(os.homedir(), p.slice(1))];
  if (p.startsWith('/') || WIN_ABS.test(p)) return [p];
  return bases.map(b => path.join(b, p));
}

function kindOf(abs) {
  if (isNetworkPath(abs)) return null;   // nem olha: stat num caminho de rede já abre conexão para fora
  let st; try { st = fs.statSync(abs); } catch { return null; }
  if (st.isDirectory()) return 'dir';
  if (!st.isFile()) return null;
  return MD_RE.test(abs) ? 'md' : 'file';
}

// raw: texto a partir do começo do possível caminho. bases: pastas para caminhos relativos (cwd do terminal, projeto).
// Retorna { len, abs, kind } — len = quantos caracteres do raw formam o link (sem a pontuação final) — ou null.
function resolve(raw, bases = []) {
  if (typeof raw !== 'string' || !raw || isNetworkPath(raw)) return null;
  const s = raw.slice(0, MAX_RAW).replace(/[\x00-\x1f]/g, ' ');
  if (!/^(~[\\/]|\/|[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\p{L}\p{N}_@.-][\p{L}\p{N}_@.\- ]*[\\/])/u.test(s) && s !== '~') return null;
  let tries = 0;
  for (const end of cuts(s)) {
    if (++tries > MAX_TRIES) break;
    const piece = s.slice(0, end);
    const p = trimEnd(piece);
    if (!p || p === '/' || p.length < 2) continue;
    for (const abs of expand(p, bases)) {
      const kind = kindOf(abs);
      if (kind) {
        // inclui no link o ":42" de "arquivo.js:42" (fica clicável), mas não ponto/vírgula final
        const withLine = /:\d+(?::\d+)?$/.test(piece.replace(/[.,;!?…]+$/, '')) ? piece.replace(/[.,;!?…]+$/, '').length : p.length;
        return { len: withLine, abs: path.resolve(abs), kind };
      }
    }
  }
  return null;
}

function resolveMany(list, bases) {
  const out = [];
  for (const c of (Array.isArray(list) ? list : []).slice(0, MAX_CANDIDATES)) {
    const r = resolve(c && c.raw, bases);
    out.push(r ? { at: c.at, ...r } : null);
  }
  return out;
}

// pasta que o macOS trata como programa/pacote (.app é pasta!): abrir = executar. Essas só são mostradas no Finder.
const BUNDLE_RE = /\.(app|bundle|pkg|mpkg|prefpane|workflow|action|framework|plugin|kext|appex|saver|qlgenerator|scpt|scptd|terminal|command|tool)$/i;
function isBundle(abs) {
  if (BUNDLE_RE.test(abs)) return true;
  try { return fs.existsSync(path.join(abs, 'Contents', 'Info.plist')) || fs.existsSync(path.join(abs, 'Contents', 'MacOS')); } catch { return false; }
}

function readMd(abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || isNetworkPath(abs) || !MD_RE.test(abs)) throw Object.assign(new Error('só arquivos .md'), { code: 'INVALID' });
  const real = fs.realpathSync(abs);
  if (!MD_RE.test(real)) throw Object.assign(new Error('só arquivos .md'), { code: 'INVALID' });
  const st = fs.statSync(real);
  if (!st.isFile()) throw Object.assign(new Error('não é arquivo'), { code: 'INVALID' });
  const len = Math.min(st.size, MAX_MD);
  const buf = Buffer.alloc(len); const fd = fs.openSync(real, 'r');
  try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
  return { path: real, name: path.basename(real), dir: path.dirname(real), size: st.size, mtime: st.mtimeMs, text: buf.toString('utf8'), truncated: st.size > MAX_MD };
}

function httpUrl(u) {
  try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') && !x.username && !x.password ? x.toString() : null; } catch { return null; }
}

module.exports = { resolve, resolveMany, readMd, kindOf, httpUrl, isBundle, MD_RE };
