// Divisão de tela (BP-2026-11-05-001 E3): árvore de painéis igual à do Cursor, com no máximo 4 terminais à vista.
// Nó folha: { t: '<id do terminal>' } · nó divisão: { d: 'row' | 'col', r: 0..1 (fração do primeiro), a, b }.
// Funções puras (testadas em test/unit/layout.test.js); a tela (app.js) desenha a partir delas.
'use strict';
(function (root) {
  const MAX = 4;
  const MIN_R = 0.15, MAX_R = 0.85;

  const leaf = (t) => ({ t });
  const isLeaf = (n) => !!n && typeof n.t === 'string';
  function leaves(n, out = []) { if (!n) return out; if (isLeaf(n)) out.push(n.t); else { leaves(n.a, out); leaves(n.b, out); } return out; }
  const count = (n) => leaves(n).length;
  const has = (n, id) => leaves(n).includes(id);
  const clone = (n) => (n ? JSON.parse(JSON.stringify(n)) : null);

  // tira a folha `id`; o irmão sobe no lugar da divisão
  function remove(n, id) {
    if (!n) return null;
    if (isLeaf(n)) return n.t === id ? null : n;
    const a = remove(n.a, id), b = remove(n.b, id);
    if (!a) return b; if (!b) return a;
    return { ...n, a, b };
  }

  function replace(n, oldId, newId) {
    if (!n) return null;
    if (isLeaf(n)) return n.t === oldId ? leaf(newId) : n;
    return { ...n, a: replace(n.a, oldId, newId), b: replace(n.b, oldId, newId) };
  }

  function swap(n, x, y) {
    if (!n) return null;
    if (isLeaf(n)) return n.t === x ? leaf(y) : n.t === y ? leaf(x) : n;
    return { ...n, a: swap(n.a, x, y), b: swap(n.b, x, y) };
  }

  // Põe `id` junto do painel `target`. zone: center (troca o que está no painel) | left | right | top | bottom (divide).
  // Retorna { tree, error } — error 'MAX' quando já há 4 painéis e o terminal ainda não está à vista.
  function place(tree, target, id, zone = 'center') {
    if (!tree) return { tree: leaf(id) };
    if (target === id) return { tree };
    const present = has(tree, id);
    if (!has(tree, target)) return { tree: present ? tree : replaceFirst(tree, id) };
    if (zone === 'center') return { tree: present ? swap(tree, target, id) : replace(tree, target, id) };
    if (!present && count(tree) >= MAX) return { tree, error: 'MAX' };
    let t = present ? remove(tree, id) : clone(tree);
    const d = zone === 'left' || zone === 'right' ? 'row' : 'col';
    const first = zone === 'left' || zone === 'top';
    const split = (n) => {
      if (isLeaf(n)) return n.t === target ? { d, r: 0.5, a: first ? leaf(id) : n, b: first ? n : leaf(id) } : n;
      return { ...n, a: split(n.a), b: split(n.b) };
    };
    t = split(t);
    return { tree: t };
  }
  function replaceFirst(tree, id) { const f = leaves(tree)[0]; return replace(tree, f, id); }

  function setRatio(n, pathStr, r) {
    if (!n || isLeaf(n)) return n;
    if (pathStr === '') return { ...n, r: clamp(r) };
    const [h, ...rest] = pathStr; const p = rest.join('');
    return h === 'a' ? { ...n, a: setRatio(n.a, p, r) } : { ...n, b: setRatio(n.b, p, r) };
  }
  const clamp = (r) => Math.min(MAX_R, Math.max(MIN_R, Number.isFinite(r) ? r : 0.5));

  // limpa o que veio do disco: tira terminais que não existem mais, repetidos, excesso, proporções fora da faixa
  function sanitize(n, valid, seen = new Set(), depth = 0) {
    if (!n || typeof n !== 'object' || depth > 6) return null;
    if (typeof n.t === 'string') { if (!valid.has(n.t) || seen.has(n.t) || seen.size >= MAX) return null; seen.add(n.t); return leaf(n.t); }
    if (n.d !== 'row' && n.d !== 'col') return null;
    const a = sanitize(n.a, valid, seen, depth + 1), b = sanitize(n.b, valid, seen, depth + 1);
    if (!a) return b; if (!b) return a;
    return { d: n.d, r: clamp(n.r), a, b };
  }

  // zona de soltar pela posição do ponteiro dentro do painel (bordas de 25%)
  function zoneAt(rect, x, y) {
    const fx = (x - rect.left) / rect.width, fy = (y - rect.top) / rect.height;
    const m = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (m > 0.25) return 'center';
    if (m === fx) return 'left'; if (m === 1 - fx) return 'right'; if (m === fy) return 'top'; return 'bottom';
  }

  const api = { MAX, leaf, isLeaf, leaves, count, has, remove, replace, swap, place, setRatio, sanitize, zoneAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Layout = api;
})(typeof window !== 'undefined' ? window : globalThis);
