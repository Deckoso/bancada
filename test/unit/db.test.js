'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../../app/main/db');

test('Inbox existe e não muda de estado', () => {
  const s = open(':memory:');
  assert.equal(s.getProject('inbox').name, 'Inbox');
  assert.throws(() => s.updateProject('inbox', { status: 'focus' }));
});

test('limite de 3 projetos em foco (D11)', () => {
  const s = open(':memory:');
  const ids = ['A', 'B', 'C', 'D'].map(n => s.createProject({ name: n }).id);
  for (const id of ids.slice(0, 3)) s.updateProject(id, { status: 'focus' });
  assert.throws(() => s.updateProject(ids[3], { status: 'focus' }), e => e.code === 'FOCUS_FULL');
  s.swapFocus(ids[0], ids[3]);
  assert.equal(s.getProject(ids[0]).status, 'shelf');
  assert.equal(s.getProject(ids[3]).status, 'focus');
  assert.equal(s.focusCount(), 3);
});

test('swapFocus é atômico: se falhar, nada muda', () => {
  const s = open(':memory:');
  const a = s.createProject({ name: 'A' }).id;
  assert.throws(() => s.swapFocus(a, 'nao-existe'));
  assert.equal(s.getProject(a).status, 'shelf');
});

test('itens: tags, histórico de tipo, outbox, relógio monotônico', () => {
  const s = open(':memory:');
  const it = s.createItem({ text: 'testar #lojaapp amanhã', type: 'idea' });
  assert.deepEqual(it.tags, ['lojaapp']);
  const up = s.updateItem(it.id, { type: 'prompt' });
  assert.equal(up.history.length, 2);
  assert.equal(up.history[1].to, 'prompt');
  assert.ok(up.updated_at > it.updated_at);
  const n = s.db.prepare('SELECT COUNT(*) c FROM sync_outbox').get().c;
  assert.ok(n >= 2);
});

test('tipo e texto inválidos são recusados', () => {
  const s = open(':memory:');
  assert.throws(() => s.createItem({ text: '  ' }));
  assert.throws(() => s.createItem({ text: 'x', type: 'hack' }));
  assert.throws(() => s.updateItem(s.createItem({ text: 'x' }).id, { type: 'hack' }));
});

test('campo fora da lista não é gravado (sem SQL injection por nome de coluna)', () => {
  const s = open(':memory:');
  const p = s.createProject({ name: 'P' });
  s.updateProject(p.id, { 'name=1;DROP TABLE items;--': 'x', name: 'Q' });
  assert.equal(s.getProject(p.id).name, 'Q');
  assert.ok(s.db.prepare("SELECT name FROM sqlite_master WHERE name='items'").get());
});
