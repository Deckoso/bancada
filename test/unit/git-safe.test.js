'use strict';
// git automático só em repositório cuja config local não pede para rodar programa
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gs = require('../../app/main/git-safe');
const git = require('../../app/main/git');
const gitview = require('../../app/main/gitview');
const files = require('../../app/main/files');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-gitsafe-'));
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'teste'); g('config', 'user.email', 'teste@exemplo.invalid');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'inicial');
  return { root, g, mark: path.join(root, '..', path.basename(root) + '-marca') };
}

test('leitor da config: seções, subseções, chave sozinha, continuação e comentários', () => {
  const kv = gs.parseConfig('[core]\n\tpager = less # c\n\tfsmonitor\n[filter "X"]\n  Clean = a \\\n b\n[diff.y]\n textconv=z\n; nada = 1\n[include] path = ../o.cfg\n');
  const keys = kv.map(x => x.key);
  assert.deepEqual(keys, ['core.pager', 'core.fsmonitor', 'filter.x.clean', 'diff.y.textconv', 'include.path']);
  assert.equal(kv[2].value.replace(/\s+/g, ' '), 'a b');
  assert.equal(gs.isRisky('core.fsmonitor', null), false, 'fsmonitor = true é o do próprio git');
  assert.equal(gs.isRisky('core.fsmonitor', 'false'), false);
  assert.equal(gs.isRisky('core.fsmonitor', '/x/y'), true);
  for (const k of ['filter.lfs.smudge', 'filter.a.process', 'gpg.program', 'gpg.ssh.program', 'core.sshcommand', 'core.pager', 'core.editor',
    'diff.external', 'diff.a.textconv', 'diff.a.command', 'merge.a.driver', 'core.hookspath', 'credential.helper', 'credential.https://x.helper',
    'uploadpack.packobjectshook', 'include.path', 'includeif.gitdir:/x/.path']) assert.equal(gs.isRisky(k, 'x'), true, k);
  for (const k of ['core.autocrlf', 'user.name', 'remote.origin.url', 'branch.main.remote', 'diff.a.binary']) assert.equal(gs.isRisky(k, 'x'), false, k);
});

test('repositório comum: git automático funciona; com programa na config: pausado e nada roda', async () => {
  const { root, g, mark } = repo();
  assert.equal(gs.check(root).ok, true);
  fs.appendFileSync(path.join(root, 'a.txt'), 'b\n');
  const s = await git.status(root);
  assert.equal(s.branch, 'main'); assert.equal(s.changed, 1); assert.ok(!s.paused);
  // agora a config ganha um filtro que criaria um marcador (nunca deve rodar)
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=x\n');
  g('config', 'filter.x.clean', `touch "${mark}"; cat`);
  const st = await git.status(root);
  assert.equal(st.paused, true); assert.equal(st.reason, gs.PAUSED_MSG);
  const v = await gitview.status(root);
  assert.equal(v.paused, true); assert.equal(v.git, false);
  assert.equal((await gitview.diff(root, 'a.txt')).note, gs.PAUSED_MSG);
  await assert.rejects(gitview.commit(root, ['a.txt'], 'x'), (e) => e.code === 'GIT_PAUSED');
  const l = await files.list(root, '');
  assert.equal(l.git, false, 'árvore pela leitura da pasta');
  assert.equal(fs.existsSync(mark), false, 'o programa da config nunca rodou');
  // cache: tirar a chave libera de novo (mtime/tamanho do config mudam)
  g('config', '--unset', 'filter.x.clean');
  assert.equal(gs.check(root).ok, true);
  assert.equal((await git.status(root)).branch, 'main');
});

test('include, config.worktree, subpasta do projeto e .git em arquivo (worktree) também contam', () => {
  const { root, g } = repo();
  const outro = path.join(root, '..', path.basename(root) + '-inc.cfg');
  fs.writeFileSync(outro, '[core]\n\tpager = algo\n');
  g('config', 'include.path', outro);
  const r = gs.check(root);
  assert.equal(r.ok, false);
  assert.ok(r.keys.includes('core.pager') && r.keys.includes('include.path'), r.keys.join());
  fs.mkdirSync(path.join(root, 'sub'));
  assert.equal(gs.check(path.join(root, 'sub')).ok, false, 'projeto numa subpasta do repositório');
  g('config', '--unset', 'include.path');
  assert.equal(gs.check(root).ok, true);
  // worktree: .git é um arquivo "gitdir:"; a config comum vem do repositório principal
  const wt = root + '-wt';
  g('worktree', 'add', '-q', wt);
  assert.equal(gs.check(wt).ok, true);
  g('config', 'core.sshCommand', 'x');
  assert.equal(gs.check(wt).ok, false);
  assert.equal(gs.check(path.join(os.tmpdir(), 'nao-existe-' + Date.now())).ok, true, 'fora de repositório: nada a pausar');
});

test('include por caminho de rede: nunca abre, já pausa', () => {
  const { root } = repo();
  fs.appendFileSync(path.join(root, '.git', 'config'), '[include]\n\tpath = //servidor/compartilhada/x.cfg\n');
  const r = gs.check(root);
  assert.equal(r.ok, false);
  assert.ok(r.keys.some(k => /caminho de rede/.test(k)));
});
