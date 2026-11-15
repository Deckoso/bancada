// Visualização de Markdown (v0.6): abre o .md clicado no terminal, formatado (títulos, listas, tabelas, código).
// Sem biblioteca e sem innerHTML: o texto vira uma árvore simples (parse) e a árvore vira elementos com textContent
// (render) — nenhum HTML do arquivo é interpretado, então um .md não consegue rodar nada na Bancada.
// Links dentro do .md: http(s) → Safari; caminho relativo → outro .md abre aqui, pasta/arquivo abre no Finder.
'use strict';
(function (root) {
  // ---------------- parse (puro; testado em test/unit/md-view.test.js) ----------------
  const MAX_LINES = 40000;

  function parse(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_LINES);
    const blocks = [];
    let i = 0;
    // frontmatter YAML no topo
    if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0 && end < 80) { blocks.push({ t: 'front', text: lines.slice(1, end).join('\n') }); i = end + 1; } }
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      let m;
      if ((m = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)/.exec(line))) {
        const fence = m[2]; const code = []; i++;
        while (i < lines.length && !lines[i].trimStart().startsWith(fence)) code.push(lines[i++]);
        i++; blocks.push({ t: 'code', lang: m[3] || '', text: code.join('\n') }); continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { blocks.push({ t: 'h', level: m[1].length, text: m[2] }); i++; continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        const q = []; while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
        blocks.push({ t: 'quote', children: parse(q.join('\n')) }); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
        const head = cells(line); const align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
        const rows = []; i += 2;
        while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
        blocks.push({ t: 'table', head, align, rows: rows.slice(0, 2000) }); continue;
      }
      if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) { const r = list(lines, i); blocks.push(r.block); i = r.next; continue; }
      // parágrafo: até linha vazia ou começo de outro bloco
      const para = [line]; i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|\s*(```|~~~)|\s{0,3}>|\s*([-*+]|\d{1,9}[.)])\s+|\s{0,3}([-*_])(\s*\4){2,}\s*$)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
      blocks.push({ t: 'p', text: para.join('\n') });
    }
    return blocks;
  }

  // lista com aninhamento por recuo
  function list(lines, start) {
    const first = /^(\s*)([-*+]|\d{1,9}[.)])\s+/.exec(lines[start]);
    const base = first[1].length; const ordered = /\d/.test(first[2]);
    const items = []; let i = start;
    while (i < lines.length) {
      const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
      if (!m || m[1].length < base) break;
      if (m[1].length > base) {           // sub-lista do último item
        const r = list(lines, i); if (items.length) items[items.length - 1].children.push(r.block); else items.push({ text: '', children: [r.block] }); i = r.next; continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;
      let text = m[3]; i++;
      // continuação do item (linha recuada que não é outro item)
      while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*([-*+]|\d{1,9}[.)])\s+/.test(lines[i])) text += '\n' + lines[i++].trim();
      const task = /^\[([ xX])\]\s+/.exec(text);
      items.push({ text: task ? text.slice(task[0].length) : text, task: task ? task[1] !== ' ' : null, children: [] });
      while (i < lines.length && /^\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*([-*+]|\d{1,9}[.)])\s+/.test(lines[i + 1])) i++;   // item solto
    }
    return { block: { t: ordered ? 'ol' : 'ul', start: ordered ? parseInt(first[2], 10) : null, items }, next: i };
  }

  // inline: devolve [{ t: 'text'|'code'|'b'|'i'|'s'|'a'|'img'|'br', text, href, children }]
  // Desempenho: cada posição copiava e varria o resto do parágrafo (quadrático: 80 KB de "*a" = 6 s com a tela
  // travada). Agora olha no máximo WIN caracteres à frente, e parágrafo gigante vira texto puro.
  const INLINE_WIN = 500; const INLINE_MAX = 30000;
  function inline(s) {
    if (s.length > INLINE_MAX) return [{ t: 'text', text: s }];
    const out = []; let buf = '';
    const flush = () => { if (buf) { out.push({ t: 'text', text: buf }); buf = ''; } };
    let i = 0; let guard = 0;
    while (i < s.length && guard++ < 200000) {
      const rest = s.slice(i, i + INLINE_WIN); let m;
      if (rest[0] === '\\' && /[\\`*_{}[\]()#+\-.!|~<>]/.test(rest[1] || '')) { buf += rest[1]; i += 2; continue; }
      if ((m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) { flush(); out.push({ t: 'code', text: m[2].replace(/^ (.*) $/, '$1') }); i += m[0].length; continue; }
      if ((m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest))) { flush(); out.push({ t: 'img', text: m[1], href: m[2] }); i += m[0].length; continue; }
      if ((m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest))) { flush(); out.push({ t: 'a', href: m[2], children: inline(m[1]) }); i += m[0].length; continue; }
      if ((m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) { flush(); out.push({ t: 'a', href: m[1], children: [{ t: 'text', text: m[1] }] }); i += m[0].length; continue; }
      if ((m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)) && (i === 0 || /[\s(]/.test(s[i - 1]))) { flush(); out.push({ t: 'a', href: m[0], children: [{ t: 'text', text: m[0] }] }); i += m[0].length; continue; }
      if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) { flush(); out.push({ t: 'b', children: inline(m[2]) }); i += m[0].length; continue; }
      if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { flush(); out.push({ t: 's', children: inline(m[1]) }); i += m[0].length; continue; }
      if ((m = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\w*])/.exec(rest)) && (rest[0] === '*' || i === 0 || !/\w/.test(s[i - 1]))) { flush(); out.push({ t: 'i', children: inline(m[2]) }); i += m[0].length; continue; }
      if (rest[0] === '\n') { flush(); out.push({ t: rest.length > 1 && /  $/.test(s.slice(Math.max(0, i - 2), i)) ? 'br' : 'text', text: ' ' }); i++; continue; }
      buf += rest[0]; i++;
    }
    flush();
    return out;
  }

  const api = { parse, inline };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ---------------- render (navegador) ----------------
  const B = root.bancada;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

  function renderInline(nodes, into, ctx) {
    for (const n of nodes) {
      if (n.t === 'text') into.appendChild(document.createTextNode(n.text));
      else if (n.t === 'br') into.appendChild(el('br'));
      else if (n.t === 'code') into.appendChild(el('code', null, n.text));
      else if (n.t === 'b' || n.t === 'i' || n.t === 's') { const e = el({ b: 'strong', i: 'em', s: 'del' }[n.t]); renderInline(n.children, e, ctx); into.appendChild(e); }
      else if (n.t === 'img') into.appendChild(el('span', 'md-img', `🖼 ${n.text || n.href}`));
      else if (n.t === 'a') {
        const a = el('a'); a.href = '#'; a.title = n.href;
        renderInline(n.children, a, ctx);
        a.addEventListener('click', (e) => { e.preventDefault(); follow(n.href, ctx); });
        into.appendChild(a);
      }
    }
  }

  function renderBlocks(blocks, into, ctx) {
    for (const b of blocks) {
      if (b.t === 'h') { const e = el(`h${b.level}`); e.id = `md-${slug(b.text)}`; renderInline(inline(b.text), e, ctx); into.appendChild(e); }
      else if (b.t === 'p') { const e = el('p'); renderInline(inline(b.text), e, ctx); into.appendChild(e); }
      else if (b.t === 'code') { const pre = el('pre'); const c = el('code', null, b.text); if (b.lang) pre.dataset.lang = b.lang; pre.appendChild(c); into.appendChild(pre); }
      else if (b.t === 'front') { const pre = el('pre', 'md-front', b.text); into.appendChild(pre); }
      else if (b.t === 'hr') into.appendChild(el('hr'));
      else if (b.t === 'quote') { const q = el('blockquote'); renderBlocks(b.children, q, ctx); into.appendChild(q); }
      else if (b.t === 'ul' || b.t === 'ol') {
        const l = el(b.t); if (b.start && b.start !== 1) l.start = b.start;
        for (const it of b.items) {
          const li = el('li');
          if (it.task !== null && it.task !== undefined) { const cb = el('input'); cb.type = 'checkbox'; cb.checked = it.task; cb.disabled = true; li.classList.add('task'); li.appendChild(cb); }
          renderInline(inline(it.text), li, ctx);
          renderBlocks(it.children, li, ctx);
          l.appendChild(li);
        }
        into.appendChild(l);
      } else if (b.t === 'table') {
        const wrap = el('div', 'md-table'); const t = el('table'); const thead = el('thead'); const tr = el('tr');
        b.head.forEach((c, k) => { const th = el('th'); if (b.align[k]) th.style.textAlign = b.align[k]; renderInline(inline(c), th, ctx); tr.appendChild(th); });
        thead.appendChild(tr); t.appendChild(thead);
        const tb = el('tbody');
        for (const row of b.rows) { const r = el('tr'); b.head.forEach((_, k) => { const td = el('td'); if (b.align[k]) td.style.textAlign = b.align[k]; renderInline(inline(row[k] || ''), td, ctx); r.appendChild(td); }); tb.appendChild(r); }
        t.appendChild(tb); wrap.appendChild(t); into.appendChild(wrap);
      }
    }
  }

  function follow(href, ctx) {
    const L = B && B.links;
    if (/^https?:\/\//i.test(href)) { if (L && L.openUrl) L.openUrl(href); return; }
    if (href.startsWith('#')) { const t = ctx.body.querySelector(`#md-${CSS.escape(slug(decodeURIComponent(href.slice(1))))}`); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (/^[a-z]+:/i.test(href)) return;                       // mailto:, javascript:, etc.: ignorados
    // v0.7: também caminhos do Windows (C:\\…, barras invertidas); caminho de rede (//servidor) é ignorado
    let p = decodeURIComponent(href.split('#')[0]).replace(/\\/g, '/');
    const base = String(ctx.dir || '').replace(/\\/g, '/');
    if (!(p.startsWith('/') || /^[A-Za-z]:\//.test(p))) p = `${base}/${p}`;
    if (/^\/\//.test(p)) return;
    const drv = /^([A-Za-z]:)\//.exec(p); const pre = drv ? drv[1] : '';
    const segs = (drv ? p.slice(2) : p).split('/').reduce((acc, seg) => { if (seg === '..') acc.pop(); else if (seg && seg !== '.') acc.push(seg); return acc; }, []);
    p = pre ? `${pre}\\${segs.join('\\')}` : '/' + segs.join('/');
    if (/\.(md|markdown|mdx)$/i.test(p)) { MdView.open(p); return; }
    if (L && L.resolve && L.openDir) L.openDir(p).catch(() => { if (L.reveal) L.reveal(p).catch(() => root.UI.toast('Não encontrei esse caminho')); });
  }

  // onde mostrar: mount() devolve o elemento onde a página vai; padrão = painel lateral
  let target = null;          // função (doc) => { body, close } fornecida pelo app
  const history = [];         // voltar entre .md abertos por link
  function setTarget(fn) { target = fn; }

  async function open(abs, { push = true } = {}) {
    if (!B || !B.links || !B.links.readMd) return;
    let doc;
    try { doc = await B.links.readMd(abs); } catch (e) { root.UI.toast(String(e.message || e).replace(/^\[[A-Z_]+\]\s*/, '')); return; }
    if (push && history[history.length - 1] !== doc.path) { history.push(doc.path); if (history.length > 30) history.shift(); }
    const view = target ? target(doc) : null;
    if (!view) return;
    const ctx = { dir: doc.dir, body: view.body };
    while (view.body.firstChild) view.body.removeChild(view.body.firstChild);
    const art = el('article', 'md');
    renderBlocks(parse(doc.text), art, ctx);
    if (doc.truncated) art.appendChild(el('p', 'muted', '… (arquivo maior que 1 MB: mostrando o começo)'));
    view.body.appendChild(art);
    view.body.scrollTop = 0;
  }
  function back() { if (history.length < 2) return false; history.pop(); open(history[history.length - 1], { push: false }); return true; }

  // desenha um texto .md num elemento (usado também pela prévia da aba Arquivos)
  function renderInto(text, dir, into) {
    const art = el('article', 'md'); renderBlocks(parse(text), art, { dir, body: into }); into.appendChild(art); return art;
  }
  const MdView = { open, back, setTarget, renderInto, canBack: () => history.length > 1, parse, inline };
  root.MdView = MdView;
})(typeof window !== 'undefined' ? window : globalThis);
