'use strict';
// Textos por sistema: no Windows (e no celular ligado a um PC) a tela não pode falar em Finder, Safari, ⌘ ou Mac.
// Regra: toda linha de código da tela que tem um desses termos precisa passar pelo helper de textos (window.UI.T, ou o
// WIN/HOST/K que saem dele) ou por uma condição de sistema; o resto entra na lista de exceções, com o motivo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const dir = path.join(__dirname, '../../app/renderer');

const TERMS = /Finder|Safari|⌘|\bMac\b|zshrc/;
// o que conta como "atrás do helper ou de uma condição de sistema"
const GUARD = /\bT\.|\bWIN\b|\bHOST\b|\bPC \?|win32|HOST_OS/;
// exceções explícitas: [arquivo, trecho da linha, motivo]
const EXCEPTIONS = [
  ['capture.html', '<kbd>⌘↩</kbd>', 'o capture.js troca por Ctrl+Enter no Windows ao abrir'],
  ['app.js', "t: '⌘T', split:", 'lado Mac do K = WIN ? {…Ctrl…} : {…⌘…} (a condição está na linha de cima)'],
];

function codeLines(file) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')          // comentário de HTML
    .replace(/\/\*[\s\S]*?\*\//g, '');         // comentário de bloco
  return src.split('\n').map((l, i) => ({ n: i + 1, text: l.replace(/(^|\s)\/\/.*$/, '') }));
}

test('nenhum Finder/Safari/⌘/Mac solto na tela: tudo passa pelo helper de textos ou por condição de sistema', () => {
  const files = fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f));
  const bad = [];
  for (const f of files) {
    for (const { n, text } of codeLines(f)) {
      if (!TERMS.test(text) || GUARD.test(text)) continue;
      if (EXCEPTIONS.some(([ef, snip]) => ef === f && text.includes(snip))) continue;
      bad.push(`${f}:${n}: ${text.trim().slice(0, 160)}`);
    }
  }
  assert.deepEqual(bad, [], 'texto de Mac sem passar pelo helper (window.UI.T) — use T.host/T.reveal/T.enter… ou acrescente a exceção com o motivo');
});

test('cada exceção ainda existe (lista não envelhece)', () => {
  for (const [f, snip] of EXCEPTIONS) assert.ok(fs.readFileSync(path.join(dir, f), 'utf8').includes(snip), `${f}: ${snip}`);
});

function loadT(platform) {
  const listeners = [];
  const win = { bancada: { platform }, addEventListener: (...a) => listeners.push(a) };
  const ctx = { window: win, document: { querySelector: () => null, createElement: () => ({}) }, Date, setTimeout, clearTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'dom.js'), 'utf8'), ctx);
  return win.UI.T;
}

test('helper de textos: no Windows nada de Mac; no Mac continua como era', () => {
  const w = loadT('win32');
  for (const [k, v] of Object.entries(w)) if (typeof v === 'string') assert.doesNotMatch(v, TERMS, `${k}: ${v}`);
  assert.equal(w.host, 'PC'); assert.equal(w.reveal, 'Mostrar no Explorador'); assert.equal(w.enter, 'Ctrl+Enter');
  const m = loadT('darwin');
  assert.equal(m.host, 'Mac'); assert.equal(m.reveal, 'Mostrar no Finder'); assert.equal(m.enter, '⌘↩');
});
