'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const files = require('../../app/main/files');
const gitview = require('../../app/main/gitview');

function repo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')));
  const root = path.join(base, 'proj');
  const other = path.join(base, 'outro-projeto');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, 'README.md'), '# oi\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'let a = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'segredo.txt\nnode_modules/\n');
  fs.writeFileSync(path.join(root, 'segredo.txt'), 'x');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), '');
  fs.writeFileSync(path.join(other, 'senha.txt'), 'nao');
  fs.writeFileSync(path.join(base, 'fora.txt'), 'nao');
  fs.symlinkSync(other, path.join(root, 'link-pra-fora'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link-dentro'));
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('init', '-q'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'inicio');
  return { base, root, other, g };
}

test('CP-3 travessia: ../, absoluto, %2e%2e, NUL, symlink para fora e projeto vizinho são recusados', () => {
  const { root } = repo();
  for (const bad of ['../fora.txt', '../outro-projeto/senha.txt', 'src/../../fora.txt', '/etc/passwd', 'link-pra-fora/senha.txt', 'link-pra-fora', 'a\0b']) {
    assert.throws(() => files.resolveInside(root, bad), (e) => e.code === 'PATH_DENIED', bad);
  }
  // %2e%2e não é decodificado (é nome literal): não sai da pasta, só não existe
  assert.throws(() => files.resolveInside(root, '%2e%2e/fora.txt'), (e) => e.code === 'NOT_FOUND');
  assert.ok(files.resolveInside(root, 'link-dentro/a.js').endsWith('/proj/src/a.js'), 'link que fica dentro vale');
  assert.throws(() => files.read(root, '../fora.txt'), (e) => e.code === 'PATH_DENIED');
});

test('árvore respeita o .gitignore (sem node_modules nem segredo) e marca pastas primeiro', async () => {
  const { root } = repo();
  const r = await files.list(root, '');
  const names = r.entries.map(e => e.name);
  assert.ok(r.git);
  assert.ok(!names.includes('node_modules') && !names.includes('segredo.txt'));
  assert.equal(r.entries[0].dir, true);
  assert.deepEqual((await files.list(root, 'src')).entries.map(e => e.rel), ['src/a.js']);
  await assert.rejects(files.list(root, '../outro-projeto'), (e) => e.code === 'PATH_DENIED');
});

test('prévia: texto, binário e corte', () => {
  const { root } = repo();
  assert.equal(files.read(root, 'README.md').text, '# oi\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
  assert.equal(files.read(root, 'bin.dat').kind, 'binary');
  fs.writeFileSync(path.join(root, 'grande.txt'), 'x'.repeat(600 * 1024));
  const g = files.read(root, 'grande.txt'); assert.equal(g.truncated, true); assert.equal(g.text.length, 512 * 1024);
});

test('mudanças: status (modificado, novo, apagado), diff e commit SÓ dos marcados', async () => {
  const { root, g } = repo();
  fs.appendFileSync(path.join(root, 'src', 'a.js'), 'let b = 2;\n');
  fs.writeFileSync(path.join(root, 'novo.txt'), 'novo\n');
  fs.unlinkSync(path.join(root, 'README.md'));
  const st = await gitview.status(root);
  const byPath = Object.fromEntries(st.files.map(f => [f.path, f.code]));
  assert.deepEqual(byPath, { 'src/a.js': 'M', 'novo.txt': '?', 'README.md': 'D' });
  const d = await gitview.diff(root, 'src/a.js'); assert.match(d.text, /\+let b = 2;/);
  const dn = await gitview.diff(root, 'novo.txt'); assert.match(dn.text, /\+novo/);
  await assert.rejects(gitview.commit(root, ['src/a.js'], ''), (e) => e.code === 'INVALID');
  await assert.rejects(gitview.commit(root, ['../fora.txt'], 'x'), (e) => e.code === 'INVALID');
  const c = await gitview.commit(root, ['src/a.js', 'README.md'], 'muda a.js\n\ne apaga o readme');
  assert.match(c.hash, /^[0-9a-f]{7,}$/);
  const after = (await gitview.status(root)).files.map(f => f.path);
  assert.deepEqual(after, ['novo.txt'], 'o não marcado continua pendente');
  assert.equal(String(g('log', '-1', '--format=%B')).trim(), 'muda a.js\n\ne apaga o readme');
});

test('mudanças numa SUBPASTA do repositório: caminhos relativos à pasta do projeto', async () => {
  const { root } = repo();
  fs.appendFileSync(path.join(root, 'src', 'a.js'), '//\n');
  const st = await gitview.status(path.join(root, 'src'));
  assert.deepEqual(st.files.map(f => f.path), ['a.js']);
  const d = await gitview.diff(path.join(root, 'src'), 'a.js'); assert.match(d.text, /\+\/\//);
});
