'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parse, inline } = require('../../app/renderer/md-view');

test('blocos: títulos, parágrafo, código, citação, linha, frontmatter', () => {
  const b = parse('---\nname: x\n---\n# Título\n\nTexto **forte**\ncontinua.\n\n```js\nconst a = 1;\n```\n> citação\n\n---\n## Sub ##');
  assert.deepEqual(b.map(x => x.t), ['front', 'h', 'p', 'code', 'quote', 'hr', 'h']);
  assert.equal(b[1].level, 1); assert.equal(b[2].text, 'Texto **forte**\ncontinua.'); assert.equal(b[3].lang, 'js'); assert.equal(b[3].text, 'const a = 1;'); assert.equal(b[6].text, 'Sub');
});

test('listas: ordenada, aninhada, tarefa', () => {
  const b = parse('- um\n  - um.a\n- [x] feito\n- [ ] falta\n\n3. três\n4. quatro');
  assert.equal(b[0].t, 'ul'); assert.equal(b[0].items.length, 3);
  assert.equal(b[0].items[0].children[0].items[0].text, 'um.a');
  assert.equal(b[0].items[1].task, true); assert.equal(b[0].items[2].task, false);
  assert.equal(b[1].t, 'ol'); assert.equal(b[1].start, 3);
});

test('tabela com alinhamento e pipe escapado', () => {
  const b = parse('| A | B |\n|:--|--:|\n| 1 | x \\| y |\n| 2 | z |');
  assert.equal(b[0].t, 'table'); assert.deepEqual(b[0].head, ['A', 'B']); assert.deepEqual(b[0].align, [null, 'right']);
  assert.deepEqual(b[0].rows, [['1', 'x | y'], ['2', 'z']]);
});

test('inline: código, negrito, itálico, link, url solta, imagem, escape', () => {
  const t = (s) => inline(s).map(n => n.t).join(',');
  assert.equal(t('a `b*c*` d'), 'text,code,text');
  assert.equal(t('**n** e *i* e ~~s~~'), 'b,text,i,text,s');
  const a = inline('veja [doc](../docs/X.md) e https://claude.ai/x.')[1];
  assert.equal(a.t, 'a'); assert.equal(a.href, '../docs/X.md');
  assert.equal(inline('veja https://claude.ai/x.')[1].href, 'https://claude.ai/x', 'ponto final fora da URL');
  assert.equal(inline('![logo](a.png)')[0].t, 'img');
  assert.equal(inline('\\*não\\*').map(n => n.text).join(''), '*não*');
  assert.equal(t('snake_case_name'), 'text', 'sublinhado no meio da palavra não vira itálico');
});

test('HTML no .md fica texto (nunca vira elemento) e entrada enorme tem teto', () => {
  const b = parse('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.equal(b[0].t, 'p'); assert.match(b[0].text, /<script>/);
  assert.equal(inline('<b>x</b>')[0].t, 'text');
  const big = parse('linha\n\n'.repeat(60000));
  assert.ok(big.length <= 40000);
});
