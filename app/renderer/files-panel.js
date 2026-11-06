// Painel lateral: abas Arquivos e Mudanças (BP-2026-11-05-001 E2). Só leitura; editar = "Abrir no Cursor".
// Arquivos: árvore do projeto com o que mudou marcado (M/A/D/?/R); arrastar um arquivo para o terminal cola o caminho.
// Mudanças: lista do git status, diff por arquivo, commit dos marcados (sem push).
// Memória: um único timer de atualização (5 s, só com a aba visível e a janela à vista), trocado a cada desenho.
'use strict';
(function () {
  const { h, clear, toast, modal } = window.UI;
  const B = window.bancada;
  const CODE_LABEL = { M: 'modificado', A: 'novo', D: 'apagado', R: 'renomeado', '?': 'novo (fora do git)', U: 'conflito' };

  const st = { pid: null, root: 0, open: {}, status: null, picked: {}, timer: null, mode: null, host: null, project: null };
  const quote = (p) => "'" + String(p).replace(/'/g, "'\\''") + "'";

  function stopTimer() { clearInterval(st.timer); st.timer = null; }

  // host: elemento do painel; mode: 'files' | 'changes'; ctx: { project, pasteToTerminal, onCount }
  async function render(host, mode, ctx) {
    stopTimer();
    st.host = host; st.mode = mode; st.ctx = ctx; st.project = ctx.project;
    if (st.pid !== ctx.project.id) { st.pid = ctx.project.id; st.root = 0; st.open = {}; st.picked = {}; st.status = null; }
    const roots = ctx.project.paths || [];
    clear(host);
    if (!roots.length) { host.appendChild(h('div', { class: 'fp-empty muted', text: 'Este projeto não tem pasta. Adicione uma em ⋯ → Pastas do projeto.' })); return; }
    const bar = h('div', { class: 'fp-bar' });
    if (roots.length > 1) {
      const sel = h('select', { class: 'aurora-input sm' }, roots.map((r, i) => h('option', { value: i, text: r.split('/').pop(), selected: i === st.root })));
      sel.addEventListener('change', () => { st.root = Number(sel.value); st.open = {}; st.status = null; render(host, mode, ctx); });
      bar.appendChild(sel);
    } else bar.appendChild(h('span', { class: 'fp-root', title: roots[0], text: roots[0].split('/').pop() }));
    bar.appendChild(h('button', { class: 'mini', title: 'Atualizar', onclick: () => refresh(true) }, '↻'));
    host.appendChild(bar);
    const body = h('div', { class: 'fp-body' });
    host.appendChild(body);
    st.body = body;
    await refresh(true);
    st.timer = setInterval(() => { if (!document.hidden && st.host && st.host.isConnected) refresh(false); else if (st.host && !st.host.isConnected) stopTimer(); }, 5000);
  }

  async function refresh(full) {
    const p = st.project; if (!p || !st.body) return;
    let status = null;
    try { status = await B.git.status(p.id, st.root); } catch { status = null; }
    const sig = JSON.stringify(status && status.files);
    const changed = sig !== st.sig; st.sig = sig; st.status = status;
    if (st.ctx && st.ctx.onCount) st.ctx.onCount(status && status.git ? status.files.length : null);
    if (!full && !changed) return;
    if (st.mode === 'files') await paintTree(); else paintChanges();
  }

  // ---------- Arquivos ----------
  function marks() {
    const m = new Map(); const dirs = new Set();
    for (const f of (st.status && st.status.files) || []) {
      m.set(f.path, f.code);
      const parts = f.path.split('/'); parts.pop();
      while (parts.length) { dirs.add(parts.join('/')); parts.pop(); }
    }
    return { m, dirs };
  }

  async function paintTree() {
    const p = st.project; const body = clear(st.body);
    const { m, dirs } = marks();
    const rootPath = p.paths[st.root];
    const tree = h('div', { class: 'fp-tree' });
    body.appendChild(tree);
    async function level(rel, depth, into) {
      let r; try { r = await B.files.list(p.id, st.root, rel); } catch (e) { into.appendChild(h('div', { class: 'muted small', text: String(e.message).replace(/^\[[A-Z_]+\]\s*/, '') })); return; }
      for (const e of r.entries) {
        const code = e.dir ? (dirs.has(e.rel) ? '•' : '') : (m.get(e.rel) || '');
        const row = h('div', { class: `fp-row ${e.dir ? 'dir' : 'file'} ${code ? 'chg c-' + (code === '?' ? 'u' : code === '•' ? 'd' : code) : ''}`, style: `padding-left:${8 + depth * 14}px`, title: e.rel },
          h('span', { class: 'fp-ic', text: e.dir ? (st.open[e.rel] ? '▾' : '▸') : '' }),
          h('span', { class: 'fp-name', text: e.name }),
          code ? h('span', { class: 'fp-code', text: code === '•' ? '•' : code === '?' ? 'U' : code }) : null);
        into.appendChild(row);
        const kids = h('div', { class: 'fp-kids' });
        into.appendChild(kids);
        if (e.dir) {
          row.addEventListener('click', async () => { st.open[e.rel] = !st.open[e.rel]; await paintTree(); });
          if (st.open[e.rel]) await level(e.rel, depth + 1, kids);
        } else {
          row.addEventListener('click', () => previewFile(e.rel));
        }
        // arrastar para o terminal: cola o caminho absoluto
        window.DnD.draggable(row, { kind: 'file', id: e.rel, text: `${rootPath}/${e.rel}`, path: `${rootPath}/${e.rel}` });
      }
      if (r.truncated) into.appendChild(h('div', { class: 'muted small fp-more', text: 'pasta grande: mostrando os 2000 primeiros' }));
    }
    await level('', 0, tree);
    if (!tree.childNodes.length) tree.appendChild(h('div', { class: 'muted small', text: 'Pasta vazia.' }));
  }

  async function previewFile(rel) {
    const p = st.project; const abs = `${p.paths[st.root]}/${rel}`;
    let r; try { r = await B.files.read(p.id, st.root, rel); } catch (e) { toast(e.message); return; }
    modal((c, close) => {
      c.classList.add('xwide');
      const actions = h('div', { class: 'row wrap' },
        B.files.openInCursor ? h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => B.files.openInCursor(p.id, st.root, rel).catch(e => toast(e.message)) }, 'Abrir no Cursor') : null,
        B.files.reveal ? h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => B.files.reveal(p.id, st.root, rel).catch(e => toast(e.message)) }, 'Mostrar no Finder') : null,
        h('button', { class: 'aurora-btn aurora-btn--glass sm', title: 'Cola o caminho no terminal em foco', onclick: async () => { if (await st.ctx.pasteToTerminal(quote(abs) + ' ')) close(); } }, 'Colar caminho no terminal'),
        m().get(rel) ? h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => { close(); showDiff(rel); } }, 'Ver mudanças') : null,
        h('button', { class: 'aurora-btn aurora-btn--text sm', onclick: close }, 'Fechar'));
      let view;
      if (r.kind === 'image') view = h('div', { class: 'fp-img' }, h('img', { src: r.dataUrl, alt: rel }));
      else if (r.kind === 'binary') view = h('p', { class: 'muted', text: r.note || `Arquivo binário (${kb(r.size)}). Sem prévia.` });
      else view = h('pre', { class: 'fp-pre', text: r.text + (r.truncated ? `\n\n… (mostrando 512 KB de ${kb(r.size)})` : '') });
      c.append(h('div', { class: 'fp-head' }, h('h2', { class: 'mono', text: rel }), h('span', { class: 'muted small', text: kb(r.size) })), actions, view);
    });
  }
  function m() { return marks().m; }
  function kb(n) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

  // ---------- Mudanças ----------
  function paintChanges() {
    const p = st.project; const body = clear(st.body);
    const s = st.status;
    if (!s || !s.git) { body.appendChild(h('div', { class: 'fp-empty muted', text: 'Esta pasta não é um repositório git.' })); return; }
    const list = s.files;
    for (const k of Object.keys(st.picked)) if (!list.some(f => f.path === k)) delete st.picked[k];
    body.appendChild(h('div', { class: 'fp-branch muted small', text: `${s.branch ? '⎇ ' + s.branch : 'sem branch'} · ${list.length ? `${list.length} arquivo(s) mudado(s)` : 'nada mudou desde o último commit'}` }));
    if (!list.length) return;
    const allBox = h('input', { type: 'checkbox', checked: list.every(f => st.picked[f.path]), title: 'Marcar todos' });
    allBox.addEventListener('change', () => { for (const f of list) st.picked[f.path] = allBox.checked; paintChanges(); });
    body.appendChild(h('label', { class: 'fp-chg head' }, allBox, h('span', { class: 'muted small', text: 'marcar todos' })));
    for (const f of list) {
      const cb = h('input', { type: 'checkbox', checked: !!st.picked[f.path] });
      cb.addEventListener('change', () => { st.picked[f.path] = cb.checked; paintCommitBox(); });
      const name = f.path.split('/').pop(); const dir = f.path.slice(0, -name.length);
      body.appendChild(h('div', { class: 'fp-chg', title: `${CODE_LABEL[f.code] || f.code}: ${f.path}` }, cb,
        h('span', { class: `fp-code c-${f.code === '?' ? 'u' : f.code}`, text: f.code === '?' ? 'U' : f.code }),
        h('button', { class: 'fp-path', onclick: () => showDiff(f.path) }, h('span', { text: name }), h('span', { class: 'muted', text: dir ? ' ' + dir : '' }))));
    }
    const box = h('div', { class: 'fp-commit' });
    body.appendChild(box);
    st.commitBox = box;
    paintCommitBox();
  }

  function paintCommitBox() {
    const box = st.commitBox; if (!box) return;
    const n = Object.values(st.picked).filter(Boolean).length;
    if (!st.msg) st.msg = h('textarea', { class: 'aurora-input', rows: 2, placeholder: 'Mensagem do commit (o que mudou e por quê)' });
    clear(box).append(st.msg, h('button', { class: 'aurora-btn aurora-btn--primary sm', disabled: !n, onclick: doCommit }, n ? `Commitar ${n} arquivo(s)` : 'Marque os arquivos'),
      h('p', { class: 'muted small', text: 'Só commit local. Enviar para o GitHub (push) continua sendo com você.' }));
  }

  async function doCommit() {
    const p = st.project;
    const filesPicked = Object.entries(st.picked).filter(([, v]) => v).map(([k]) => k);
    const msg = st.msg.value.trim();
    if (!msg) { toast('Escreva a mensagem do commit'); st.msg.focus(); return; }
    if (!confirm(`Commitar ${filesPicked.length} arquivo(s) em ${p.name}?\n\n"${msg.slice(0, 200)}"`)) return;
    try {
      const r = await B.git.commit(p.id, st.root, filesPicked, msg);
      toast(`Commit ${r.hash} feito (${r.files} arquivo(s))`);
      st.picked = {}; st.msg.value = '';
      await refresh(true);
    } catch (e) { toast(e.message, 7000); }
  }

  async function showDiff(rel) {
    const p = st.project;
    let r; try { r = await B.git.diff(p.id, st.root, rel); } catch (e) { toast(e.message); return; }
    modal((c, close) => {
      c.classList.add('xwide');
      const pre = h('pre', { class: 'fp-pre diff' });
      const lines = (r.text || '').split('\n');
      for (const l of lines.slice(0, 20000)) {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'dh' : l.startsWith('@@') ? 'dhunk' : l.startsWith('+') ? 'dadd' : l.startsWith('-') ? 'ddel' : '';
        pre.appendChild(h('span', { class: cls, text: l + '\n' }));
      }
      if (!r.text) pre.textContent = r.note || 'Sem diferenças de texto.';
      c.append(h('div', { class: 'fp-head' }, h('h2', { class: 'mono', text: rel }), r.truncated ? h('span', { class: 'chip warn', text: 'cortado em 1 MB' }) : null),
        h('div', { class: 'row wrap' },
          B.files.openInCursor ? h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => B.files.openInCursor(p.id, st.root, rel).catch(e => toast(e.message)) }, 'Abrir no Cursor') : null,
          h('button', { class: 'aurora-btn aurora-btn--text sm', onclick: close }, 'Fechar')),
        pre);
    });
  }

  window.FilesPanel = { render, refresh: () => refresh(false), stop: stopTimer };
})();
