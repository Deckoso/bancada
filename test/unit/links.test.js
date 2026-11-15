'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { resolve, resolveMany, readMd, httpUrl, isBundle } = require('../../app/main/links');

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'links ')));
  fs.mkdirSync(path.join(root, 'Pasta com espaço', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Pasta com espaço', 'NOTAS.md'), '# Oi');
  fs.writeFileSync(path.join(root, 'Pasta com espaço', 'app.js'), 'x');
  return root;
}

test('caminho absoluto com espaço no nome e texto depois: pega o mais longo que existe', () => {
  const r = tree();
  const line = `${r}/Pasta com espaço/NOTAS.md e depois mais texto.`;
  const x = resolve(line, []);
  assert.equal(x.kind, 'md'); assert.equal(x.abs, `${r}/Pasta com espaço/NOTAS.md`); assert.equal(x.len, `${r}/Pasta com espaço/NOTAS.md`.length);
  const d = resolve(`${r}/Pasta com espaço/sub — essa é a pasta`, []);
  assert.equal(d.kind, 'dir'); assert.equal(d.abs, `${r}/Pasta com espaço/sub`);
});

test('pontuação final, crase e :linha', () => {
  const r = tree();
  assert.equal(resolve(`${r}/Pasta com espaço/NOTAS.md.`, []).len, `${r}/Pasta com espaço/NOTAS.md`.length, 'ponto final fora');
  assert.equal(resolve(`${r}/Pasta com espaço/NOTAS.md\` (veja)`, []).kind, 'md');
  const l = resolve(`${r}/Pasta com espaço/app.js:42 tem o bug`, []);
  assert.equal(l.kind, 'file'); assert.equal(l.len, `${r}/Pasta com espaço/app.js:42`.length, ':42 faz parte do link');
});

test('relativo resolve pela pasta do terminal/projeto; ~/ pela home', () => {
  const r = tree();
  assert.equal(resolve('Pasta com espaço/NOTAS.md, ok', [path.join(r, 'nao-existe'), r]).abs, `${r}/Pasta com espaço/NOTAS.md`);
  assert.equal(resolve('./Pasta com espaço/sub', [r]).kind, 'dir');
  assert.equal(resolve('~/', []).kind, 'dir');
});

test('não inventa link: texto comum, caminho que não existe, palavra sem barra', () => {
  const r = tree();
  assert.equal(resolve('isso não é caminho', [r]), null);
  assert.equal(resolve('/nao/existe/mesmo.md', [r]), null);
  assert.equal(resolve('NOTAS.md', [path.join(r, 'Pasta com espaço')]), null, 'sem barra não vira link (evita sublinhar toda palavra)');
  assert.equal(resolve('/', []), null);
  assert.deepEqual(resolveMany([{ at: 3, raw: `${r}/Pasta com espaço` }, { at: 9, raw: 'nada/aqui' }], []).map(x => x && x.kind), ['dir', null]);
  assert.equal(resolveMany(Array(100).fill({ raw: 'x' }), []).length, 24, 'teto de candidatos');
});

test('readMd: só .md, segue o caminho real, recusa link que aponta para não-.md, teto de 1 MB', () => {
  const r = tree();
  const md = readMd(`${r}/Pasta com espaço/NOTAS.md`);
  assert.equal(md.text, '# Oi'); assert.equal(md.name, 'NOTAS.md');
  assert.throws(() => readMd(`${r}/Pasta com espaço/app.js`), /só arquivos .md/);
  fs.symlinkSync(`${r}/Pasta com espaço/app.js`, `${r}/engano.md`);
  assert.throws(() => readMd(`${r}/engano.md`), /só arquivos .md/, 'link .md → .js recusado');
  assert.throws(() => readMd('relativo.md'), /só arquivos .md/);
  fs.writeFileSync(`${r}/grande.md`, 'a'.repeat(1024 * 1024 + 10));
  const g = readMd(`${r}/grande.md`); assert.equal(g.truncated, true); assert.equal(g.text.length, 1024 * 1024);
});

test('httpUrl: só http(s), sem usuário:senha', () => {
  assert.equal(httpUrl('https://claude.ai/x?y=1'), 'https://claude.ai/x?y=1');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@x.com', 'cursor://file/x', '']) assert.equal(httpUrl(bad), null, bad);
});

test('pacote do macOS (.app é pasta) nunca é "aberto" pelo link — só mostrado no Finder', () => {
  const r = tree();
  fs.mkdirSync(path.join(r, 'Pasta com espaço', 'Coisa.app', 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(r, 'disfarce', 'Contents', 'MacOS'), { recursive: true });
  assert.equal(isBundle(path.join(r, 'Pasta com espaço', 'Coisa.app')), true);
  assert.equal(isBundle(path.join(r, 'disfarce')), true, 'pacote sem extensão também');
  assert.equal(isBundle(path.join(r, 'Pasta com espaço', 'sub')), false);
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'main', 'index.js'), 'utf8');
  assert.match(idx, /if \(links\.isBundle\(a\)\) shell\.showItemInFolder\(a\); else shell\.openPath\(a\)/);
  assert.doesNotMatch(idx.split('links:reveal')[1].split('\n')[0], /openPath/, 'arquivo comum só é mostrado, nunca aberto');
});
