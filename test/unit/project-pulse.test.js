'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ProjectPulse, lastLineOf, testsOf } = require('../../app/main/project-pulse');

function fake() {
  const t = new Map();
  return {
    t,
    set(id, o) { t.set(id, { id, projectId: 'p1', name: id, cwd: '/tmp/projeto-exemplo', urls: [], tail: '', fg: 'zsh', lastOutAt: 0, ...(t.get(id) || {}), ...o }); },
    list() { return [...t.values()].map(x => ({ id: x.id, projectId: x.projectId, name: x.name, cwd: x.cwd, urls: x.urls })); },
    foreground(id) { return t.get(id).fg; }, replay(id) { return t.get(id).tail; }, lastOutput(id) { return t.get(id).lastOutAt; },
  };
}

test('última linha sem cor, sem prompt vazio; resumo de testes de vários executores', () => {
  assert.equal(lastLineOf('a\r\n\x1b[32m  ➜  Local: http://localhost:5173/\x1b[0m\r\n$ '), '➜ Local: http://localhost:5173/');
  assert.equal(lastLineOf('• Working (3s • esc to interrupt)\r• Working (4s • esc to interrupt)\r'), '• Working (4s • esc to interrupt)');
  assert.deepEqual(testsOf('ℹ tests 10\nℹ pass 9\nℹ fail 1\n'), { pass: 9, fail: 1 });
  assert.deepEqual(testsOf('Tests:       2 failed, 40 passed, 42 total'), { pass: 40, fail: 2 });
  assert.deepEqual(testsOf('  12 passing (3s)\n'), { pass: 12, fail: 0 });
  assert.equal(testsOf('nada de teste aqui'), null);
});

test('terminal comum: ativo pelo programa em primeiro plano; Windows (sem programa) pela saída recente; login das IAs nunca', () => {
  let now = 1e12; const P = fake(); const got = [];
  P.set('s1', { fg: 'node', tail: 'VITE ready\n  Local: http://localhost:5173/\n', lastOutAt: now - 60000, urls: [{ port: '5173', url: 'http://localhost:5173/' }] });
  P.set('s2', { fg: 'zsh', tail: '$ ', lastOutAt: now - 1000 });
  P.set('ai-login-claude', { fg: 'claude', tail: 'codigo' });
  const pl = new ProjectPulse({ ptys: P, now: () => now, kindOf: () => 'shell', onChange: (x) => got.push(x), win: false });
  pl.tick();
  const p = pl.list().p1;
  assert.deepEqual(p.terms.map(x => [x.id, x.fg, x.active]), [['s1', 'node', true], ['s2', 'zsh', false]]);
  assert.deepEqual(p.servers, ['http://localhost:5173/']);
  assert.equal(p.terms[0].activeSince, now);
  now += 5000; pl.tick();
  assert.equal(pl.list().p1.terms[0].activeSince, now - 5000, 'ativo desde a primeira vez');
  assert.equal(got.length, 1, 'nada mudou (fora a hora): não avisa de novo');
  const W = fake(); W.set('w1', { fg: '', tail: 'compilando\n', lastOutAt: now - 2000 }); W.set('w2', { fg: '', tail: 'x\n', lastOutAt: now - 60000 });
  const pw = new ProjectPulse({ ptys: W, now: () => now, kindOf: () => 'shell', win: true }); pw.tick();
  assert.deepEqual(pw.list().p1.terms.map(x => x.active), [true, false]);
});

test('Codex/Google: ativo enquanto o terminal escreve; terminal fechado some; git com intervalo mínimo', async () => {
  let now = 1e12; const P = fake(); let gitCalls = 0;
  P.set('c1', { fg: 'codex', tail: '• Working (1s)\r', lastOutAt: now });
  const pl = new ProjectPulse({ ptys: P, now: () => now, kindOf: () => 'codex', git: async () => { gitCalls++; return { branch: 'main', changed: 3, files: ['a.js'], last: { hash: 'abc1234', subject: 'x', at: 1 } }; } });
  pl.tick(); await new Promise(r => setImmediate(r));
  assert.equal(pl.list().p1.terms[0].active, true);
  assert.equal(pl.list().p1.git.changed, 3);
  now += 7000; pl.tick();
  assert.equal(pl.list().p1.terms[0].active, false, 'parou de escrever: parado');
  assert.equal(gitCalls, 1, 'git no máximo a cada 20 s');
  P.t.delete('c1'); pl.tick();
  assert.deepEqual(pl.list(), {}); assert.equal(pl.seen.size, 0); assert.equal(pl.gits.size, 0, 'nada fica para trás');
});

test('git pausado (config do repositório pede programa): o pulso leva o aviso, sem branch nem arquivos', async () => {
  const P = fake(); P.set('s1', {});
  const pl = new ProjectPulse({ ptys: P, now: () => 1e12, kindOf: () => 'shell', dirOf: () => '/tmp/projeto-exemplo',
    git: async () => ({ paused: true, reason: 'git pausado: este repositório define programas na configuração dele', files: ['x'] }) });
  pl.tick(); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(pl.list().p1.git, { paused: true, reason: 'git pausado: este repositório define programas na configuração dele' });
});
