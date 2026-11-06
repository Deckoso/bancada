'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../../app/renderer/layout');

test('dividir à direita, abaixo e à esquerda; leaves na ordem visual', () => {
  let t = L.leaf('a');
  t = L.place(t, 'a', 'b', 'right').tree;
  assert.deepEqual(L.leaves(t), ['a', 'b']); assert.equal(t.d, 'row');
  t = L.place(t, 'b', 'c', 'bottom').tree;
  assert.deepEqual(L.leaves(t), ['a', 'b', 'c']); assert.equal(t.b.d, 'col');
  t = L.place(t, 'a', 'd', 'left').tree;
  assert.deepEqual(L.leaves(t), ['d', 'a', 'b', 'c']);
});

test('5º painel é recusado; mover um que já está à vista não conta como novo', () => {
  let t = L.leaf('a');
  for (const id of ['b', 'c', 'd']) t = L.place(t, L.leaves(t).at(-1), id, 'right').tree;
  assert.equal(L.count(t), 4);
  const r = L.place(t, 'a', 'e', 'right');
  assert.equal(r.error, 'MAX'); assert.equal(L.count(r.tree), 4);
  const moved = L.place(t, 'a', 'd', 'bottom').tree;
  assert.equal(L.count(moved), 4); assert.deepEqual(L.leaves(moved).sort(), ['a', 'b', 'c', 'd']);
});

test('centro troca o terminal do painel (ou troca de lugar se já está à vista)', () => {
  let t = L.place(L.leaf('a'), 'a', 'b', 'right').tree;
  assert.deepEqual(L.leaves(L.place(t, 'a', 'x', 'center').tree), ['x', 'b']);
  assert.deepEqual(L.leaves(L.place(t, 'a', 'b', 'center').tree), ['b', 'a']);
});

test('fechar painel: o irmão ocupa o espaço', () => {
  let t = L.place(L.leaf('a'), 'a', 'b', 'right').tree;
  t = L.place(t, 'b', 'c', 'bottom').tree;
  t = L.remove(t, 'b');
  assert.deepEqual(L.leaves(t), ['a', 'c']); assert.equal(t.d, 'row');
  assert.equal(L.remove(L.leaf('a'), 'a'), null);
});

test('sanitize: tira terminal sumido, repetido, excesso e proporção absurda', () => {
  const raw = { d: 'row', r: 9, a: { t: 'a' }, b: { d: 'col', r: 0.3, a: { t: 'sumiu' }, b: { d: 'row', a: { t: 'a' }, b: { t: 'b' } } } };
  const t = L.sanitize(raw, new Set(['a', 'b']));
  assert.deepEqual(L.leaves(t), ['a', 'b']);
  assert.equal(t.r, 0.85);
  assert.equal(L.sanitize({ d: 'diag', a: { t: 'a' }, b: { t: 'b' } }, new Set(['a', 'b'])), null);
  assert.equal(L.sanitize('lixo', new Set()), null);
});

test('setRatio pelo caminho e zoneAt pelas bordas', () => {
  let t = L.place(L.leaf('a'), 'a', 'b', 'right').tree;
  t = L.place(t, 'b', 'c', 'bottom').tree;
  t = L.setRatio(t, 'b', 0.7); assert.equal(t.b.r, 0.7);
  t = L.setRatio(t, '', 0.01); assert.equal(t.r, 0.15);
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(L.zoneAt(rect, 50, 50), 'center'); assert.equal(L.zoneAt(rect, 5, 50), 'left');
  assert.equal(L.zoneAt(rect, 95, 50), 'right'); assert.equal(L.zoneAt(rect, 50, 3), 'top'); assert.equal(L.zoneAt(rect, 50, 97), 'bottom');
});
