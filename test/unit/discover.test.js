'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { discoverProjects, shallow } = require('../../app/main/discover');

function tree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-disc-'));
  const mk = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const repo = (...p) => { const d = mk(...p); mk(...p, '.git'); return d; };
  return { base, mk, repo };
}

test('pasta por categoria (NN-categoria) continua listando todo projeto, com ou sem git', () => {
  const { base, mk, repo } = tree();
  repo('Projetos', '01-trabalho', 'loja');
  mk('Projetos', '01-trabalho', 'rascunho');
  repo('Projetos', '04-live', 'overlay');
  mk('Projetos', 'solto', 'x');
  const r = discoverProjects(path.join(base, 'Projetos'), []);
  assert.deepEqual(r.map(x => x.name).sort(), ['loja', 'overlay', 'rascunho']);
  assert.equal(r.find(x => x.name === 'overlay').kind, 'live');
  assert.equal(r.find(x => x.name === 'rascunho').git, false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('varredura rasa: só pastas com .git, até 2 níveis, sem entrar em repositório, node_modules ou pasta oculta', () => {
  const { base, mk, repo } = tree();
  const docs = mk('Documents');
  repo('Documents', 'site');                       // nível 1
  repo('Documents', 'clientes', 'app-a');          // nível 2
  repo('Documents', 'a', 'b', 'fundo');            // nível 3: fora
  mk('Documents', 'fotos');                        // sem git: fora
  repo('Documents', 'site', 'sub-repo');           // dentro de um repo: não procura
  repo('Documents', 'node_modules', 'pkg');
  repo('Documents', '.escondido', 'x');
  repo('Documents', 'Library', 'y');
  const r = discoverProjects(null, [{ paths: [path.join(docs, 'site')] }], [{ dir: docs, label: 'Documentos' }]);
  assert.deepEqual(r.map(x => x.name).sort(), ['app-a', 'site']);
  assert.equal(r.find(x => x.name === 'site').registered, true);
  assert.equal(r.find(x => x.name === 'app-a').category, 'Documentos');
  fs.rmSync(base, { recursive: true, force: true });
});

test('varredura rasa nunca segue link simbólico', { skip: process.platform === 'win32' }, () => {
  const { base, mk, repo } = tree();
  const docs = mk('Documents');
  const fora = repo('fora', 'segredo');
  fs.symlinkSync(path.dirname(fora), path.join(docs, 'atalho'));
  fs.symlinkSync(fora, path.join(docs, 'link-repo'));
  const r = discoverProjects(null, [], [{ dir: docs, label: 'Documentos' }]);
  assert.deepEqual(r, []);
  // a própria raiz sendo um link também não é seguida
  fs.symlinkSync(path.dirname(fora), path.join(base, 'raiz-link'));
  assert.deepEqual(discoverProjects(null, [], [{ dir: path.join(base, 'raiz-link'), label: 'x' }]), []);
  fs.rmSync(base, { recursive: true, force: true });
});

test('varredura rasa respeita o teto de pastas olhadas', () => {
  const { base, mk, repo } = tree();
  const docs = mk('Documents');
  for (let i = 0; i < 30; i++) repo('Documents', `p${String(i).padStart(2, '0')}`);
  assert.equal(shallow([{ dir: docs, label: 'D' }], new Set(), { maxVisits: 10 }).length, 10);
  assert.equal(shallow([{ dir: docs, label: 'D' }], new Set()).length, 30);
  fs.rmSync(base, { recursive: true, force: true });
});

test('caminho de rede nunca é olhado; raiz inexistente não quebra; repetido entra uma vez só', () => {
  const { base, mk, repo } = tree();
  repo('Developer', 'api');
  const r = discoverProjects(null, [], [
    { dir: '\\\\servidor\\compartilhado', label: 'rede' }, { dir: '//servidor/x', label: 'rede' },
    { dir: path.join(base, 'nao-existe'), label: 'x' },
    { dir: path.join(base, 'Developer'), label: 'Developer' }, { dir: path.join(base, 'Developer'), label: 'Developer' },
  ]);
  assert.deepEqual(r.map(x => x.name), ['api']);
  mk('vazio');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a pasta por categoria não aparece de novo na varredura rasa', () => {
  const { base, repo } = tree();
  repo('Documents', 'Projetos', '01-x', 'loja');
  const docs = path.join(base, 'Documents');
  const r = discoverProjects(path.join(docs, 'Projetos'), [], [{ dir: docs, label: 'Documentos' }]);
  assert.deepEqual(r.map(x => [x.name, x.category]), [['loja', '01-x']]);
  fs.rmSync(base, { recursive: true, force: true });
});
