// Tela principal da Bancada. Princípios (BLUEPRINT): capturar < 2 s · 1 próximo passo · sem culpa · retomar em 1 clique.
// Emenda 1 (2026-11-05): o MOTOR (ex.: athena-os) é o cérebro — terminais de Claude abrem dentro dele, focados no projeto.
// Tudo arrastável: projetos (ordem e foco↔estante), notas/prompts (ordem e entre projetos), abas, cartões do painel, Hoje.
'use strict';
(function () {
  const { h, clear, $, ago, today, toast, modal, editable, errCode } = window.UI;
  const { draggable, sortable, dropTarget } = window.DnD;
  const B = window.bancada;

  const KIND_LABEL = { software: 'Software', live: 'Live', musica: 'Música', outro: 'Outro' };
  const TYPE_LABEL = { note: 'Nota', idea: 'Ideia', prompt: 'Prompt', reminder: 'Lembrete', step: 'Passo' };
  const SRC_LABEL = { user: 'você', heuristic: 'automático', ai: 'IA' };
  const STARTUPS = [
    ['bancada:claude', 'Claude (Anthropic)'],
    ['bancada:codex', 'Codex (ChatGPT), na pasta do projeto'],
    ['bancada:agy', 'Google (Antigravity), na pasta do projeto'],
    ['bancada:engine', 'Terminal na pasta do motor'],
    ['', 'Terminal na pasta do projeto'],
    ['npm run dev', 'npm run dev (na pasta do projeto)'],
  ];
  const AI_OF = { 'bancada:claude': 'claude', 'bancada:codex': 'codex', 'bancada:agy': 'google' };
  const AI_ICON = { claude: '✳︎', codex: '◎', google: '✦' };
  const CARD_IDS = ['where', 'next', 'pending', 'prompts', 'notes', 'commands', 'sessions'];

  const S = {
    projects: [], engines: [], view: 'project', activeId: null, settings: {}, aiInstalled: {},
    layout: {}, activeTab: {}, shelfOpen: false,
    tree: null, focusTerm: null, cst: {}, ctx: {}, urls: {}, panelTab: load('bancada.panelTab', 'project'),
    cardOrder: load('bancada.cardOrder', CARD_IDS), collapsed: load('bancada.collapsed', { sessions: false, commands: true }),
  };
  function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v || d; } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  const proj = (id) => S.projects.find(p => p.id === id);
  const focusProjects = () => S.projects.filter(p => p.status === 'focus').sort((a, b) => a.position - b.position);
  const shelfProjects = () => S.projects.filter(p => p.status === 'shelf').sort((a, b) => a.position - b.position);
  const defaultEngine = () => S.engines.find(e => e.is_default) || null;
  function engineFor(p) {
    if (!p || p.engine_id === 'none') return null;
    return (p.engine_id && S.engines.find(e => e.id === p.engine_id)) || defaultEngine();
  }
  const newId = () => 't' + Math.random().toString(36).slice(2, 12);

  // ---------------- carga ----------------
  async function loadProjects() { S.projects = await B.projects.list(); }
  async function loadEngines() { S.engines = await B.engines.list(); }

  async function boot() {
    if (window.__REMOTE) document.body.classList.add('remote');
    window.Terminals.init($('#terms'), { onFocus: (id) => focusPane(id) });
    S.settings = await B.settings.get();
    applyTheme(S.settings.theme);
    await Promise.all([loadProjects(), loadEngines(), refreshAiInstalled()]);
    bindChrome();
    bindLive();
    window.AskUI.init({ goTerm: (pid, tid) => goTerminal(pid, tid) });
    if (window.ActivityUI) window.ActivityUI.init({ goTerm: (pid, tid) => goTerminal(pid, tid), terms: officeTerms, termInfo: (id) => { const m = meta(id); return m && m.p ? { projectId: m.p.id } : null; },
      openOffice: () => { S.panelTab = 'office'; save('bancada.panelTab', 'office'); renderPanel(); document.body.classList.add('m-panel-open'); } });
    await loadLive();
    await restoreTree().catch(() => {});
    B.onDataChanged(async (ev) => {
      if (ev.kind === 'project' || ev.kind === 'items') {
        await loadProjects(); renderSide();
        if (S.view === 'project' && (!ev.project_id || ev.project_id === S.activeId)) { renderHead(); renderPanel(); }
        if (S.view === 'inbox') renderInbox();
        if (S.view === 'today') renderToday();
      }
    });
    B.sessions.onChanged(async ({ projects }) => { await loadProjects(); renderSide(); if (projects.includes(S.activeId)) renderPanel(); });
    B.engines.onChanged(async () => { await loadEngines(); if (S.view === 'project') { renderHead(); renderPanel(); } toast('Motor atualizado: comandos e skills relidos'); });
    B.onMorning(() => go('today'));

    if (!S.settings.onboarded) { renderSide(); go('today'); welcome(); return; }
    const bad = S.engines.filter(e => e.status && !e.status.ok);
    if (bad.length) toast(`Motor "${bad[0].name}" não encontrado em ${bad[0].path}. Confira em Ajustes.`, 7000);
    const fromTree = S.focusTerm && meta(S.focusTerm);
    const first = fromTree ? fromTree.p : focusProjects()[0];
    const seen = localStorage.getItem('bancada.today_seen');
    if (seen !== today()) { localStorage.setItem('bancada.today_seen', today()); go('today'); }
    else if (first) go('project', first.id); else go('today');
  }

  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  // ---------------- navegação ----------------
  async function go(view, projectId, opts) {
    S.view = view;
    document.body.classList.remove('m-side-open');
    if (projectId) { S.activeId = projectId; B.projects.setActive(projectId).catch(() => {}); }
    for (const v of ['project', 'today', 'inbox']) $(`#view-${v}`).classList.toggle('hidden', v !== view);
    $('#panel').classList.toggle('hidden', view !== 'project');
    renderSide();
    if (view === 'project') { renderHead(); renderPanel(); await showTerminals(opts); }
    else { clear($('#proj-head')).appendChild(h('div', { class: 'head-title' }, h('h1', { text: view === 'today' ? 'Hoje' : 'Inbox' }))); }
    if (view === 'today') renderToday();
    if (view === 'inbox') renderInbox();
  }

  // celular/iPad: gavetas e barra de teclas do terminal
  const KEYS = { esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', ctrlc: '\x03', slash: '/' };
  function bindMobile() {
    $('#m-side-btn').addEventListener('click', () => { document.body.classList.toggle('m-side-open'); document.body.classList.remove('m-panel-open'); });
    $('#m-panel-btn').addEventListener('click', () => { document.body.classList.toggle('m-panel-open'); document.body.classList.remove('m-side-open'); });
    $('#m-scrim').addEventListener('click', () => document.body.classList.remove('m-side-open', 'm-panel-open'));
    for (const b of document.querySelectorAll('#keybar button')) {
      // pointerdown + preventDefault: não tira o foco do terminal (o teclado do celular continua aberto)
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const tid = focusedTerminal();
        if (tid) { B.pty.write(tid, KEYS[b.dataset.seq]); window.Terminals.focus(tid); }
      });
    }
  }

  function bindChrome() {
    bindMobile();
    $('#nav-today').addEventListener('click', () => go('today'));
    $('#nav-inbox').addEventListener('click', () => go('inbox'));
    $('#shelf-toggle').addEventListener('click', () => { S.shelfOpen = !S.shelfOpen; renderSide(); });
    $('#btn-new-project').addEventListener('click', () => newProjectModal());
    $('#btn-guided').addEventListener('click', () => guidedModal());
    $('#btn-settings').addEventListener('click', () => settingsModal());
    document.addEventListener('keydown', (e) => {
      if (!e.metaKey || !$('#modal').classList.contains('hidden')) return;
      if (['1', '2', '3', '4', '5'].includes(e.key)) { const p = focusProjects()[Number(e.key) - 1]; if (p) { e.preventDefault(); go('project', p.id); } }
      if (e.key === 't' && S.view === 'project') { e.preventDefault(); newTerminalModal(); }
      if (e.key === 'j') { e.preventDefault(); go('today'); }
      if (e.key === '\\' && S.view === 'project') { e.preventDefault(); splitMenu(); }
    });

    // arrastar: projetos entre Foco e Estante (os contêineres são fixos — registra uma vez só)
    const onProjectDrop = (target) => async (ids, payload) => {
      const p = proj(payload.id); if (!p) return;
      try {
        if (p.status !== target) await B.projects.update(p.id, { status: target });
        const other = target === 'focus' ? shelfProjects() : focusProjects();
        await B.projects.reorder([...ids, ...other.map(x => x.id).filter(id => !ids.includes(id))]);
      } catch (e) {
        if (errCode(e) === 'FOCUS_FULL') { await loadProjects(); bringToFocus(p); return; }
        toast(e.message);
      }
      await loadProjects(); renderSide(); if (S.activeId === p.id) renderHead();
    };
    sortable($('#focus-list'), { accepts: (d) => d.kind === 'project', itemSelector: '.nav-proj', onDrop: onProjectDrop('focus') });
    sortable($('#shelf-list'), { accepts: (d) => d.kind === 'project', itemSelector: '.nav-proj', onDrop: onProjectDrop('shelf') });
    dropTarget($('#shelf-toggle'), { accepts: (d) => d.kind === 'project', onDrop: (d) => { S.shelfOpen = true; onProjectDrop('shelf')([...shelfProjects().map(x => x.id), d.id], d); } });
    // soltar uma nota/prompt no Hoje ou na Inbox
    dropTarget($('#nav-today'), { accepts: (d) => d.kind === 'item', onDrop: (d) => addItemToToday(d.id) });
    dropTarget($('#nav-inbox'), { accepts: (d) => d.kind === 'item', onDrop: (d) => moveItem(d.id, 'inbox') });
    // abas de terminal
    sortable($('#tabs'), { accepts: (d) => d.kind === 'tab', itemSelector: '.tab[data-id]', axis: 'x', onDrop: async (ids) => {
      const p = proj(S.activeId); if (!p) return;
      S.layout[p.id] = ids.map(id => S.layout[p.id].find(t => t.id === id)).filter(Boolean);
      await B.terminals.reorder(p.id, ids).catch(e => toast(e.message)); renderTabs();
    } });
    // cartões do painel
    sortable($('#panel'), { accepts: (d) => d.kind === 'card', itemSelector: '.card[data-id]', onDrop: (ids) => { S.cardOrder = ids; save('bancada.cardOrder', ids); renderPanel(); } });
  }

  async function moveItem(itemId, projectId) {
    try { await B.items.update(itemId, { project_id: projectId }); } catch (e) { toast(e.message); return; }
    const p = proj(projectId); toast(`Movido para ${p ? p.name : 'Inbox'}`);
    if (S.view === 'project') renderPanel(); if (S.view === 'inbox') renderInbox(); renderSide();
  }

  // ---------------- barra lateral ----------------
  function renderSide() {
    const fl = clear($('#focus-list'));
    const limit = S.settings.focus_limit || 3;
    for (const [i, p] of focusProjects().entries()) fl.appendChild(projectNav(p, `⌘${i + 1}`));
    $('#focus-hint').textContent = `${focusProjects().length}/${limit}`;
    if (!focusProjects().length) fl.appendChild(h('div', { class: 'nav-empty', text: 'Nada em foco. Arraste um projeto da estante para cá.' }));
    const sl = clear($('#shelf-list'));
    sl.classList.toggle('collapsed', !S.shelfOpen);
    $('#shelf-toggle').classList.toggle('open', S.shelfOpen);
    for (const p of shelfProjects()) sl.appendChild(projectNav(p));
    if (!shelfProjects().length) sl.appendChild(h('div', { class: 'nav-empty', text: 'Estante vazia.' }));
    $('#nav-today').classList.toggle('on', S.view === 'today');
    $('#nav-inbox').classList.toggle('on', S.view === 'inbox');
    B.items.list('inbox').then(items => { $('#inbox-count').textContent = items.length || ''; }).catch(() => {});
    B.items.today(today()).then(items => { const open = items.filter(i => i.state !== 'done').length; $('#today-count').textContent = items.length ? `${items.length - open}/${items.length}` : ''; }).catch(() => {});
  }

  function projectNav(p, kbd) {
    const live = window.Terminals.liveCount(p.id);
    const st = projectState(p.id);
    const el = h('button', { class: `nav-proj ${S.view === 'project' && S.activeId === p.id ? 'on' : ''}`, dataset: { id: p.id }, onclick: () => go('project', p.id) },
      h('div', { class: 'np-row' },
        h('span', { class: `dot ${st ? 'st-' + st : live ? 'live' : ''}`, title: st ? `Claude: ${STATE_LABEL[st]}` : live ? `${live} terminal(is) aberto(s)` : '' }),
        h('span', { class: 'np-name', text: p.name }),
        kbd ? h('span', { class: 'kbd', text: kbd }) : h('span', { class: 'np-when', text: ago(p.last_touched_at) })),
      p.status === 'focus' && p.next_step ? h('div', { class: 'np-next', text: '→ ' + p.next_step }) : null);
    draggable(el, { kind: 'project', id: p.id, text: p.name });
    dropTarget(el, { accepts: (d) => d.kind === 'item', onDrop: (d) => moveItem(d.id, p.id) });
    return el;
  }

  // ---------------- cabeçalho do projeto ----------------
  function renderHead() {
    const p = proj(S.activeId); const head = clear($('#proj-head'));
    if (!p) return;
    const dir = (p.paths || [])[0];
    const eng = engineFor(p);
    const engChip = eng
      ? h('button', { class: `chip engine ${eng.status && !eng.status.ok ? 'bad' : ''}`, title: eng.status && eng.status.ok ? `Motor: ${eng.path}\n${eng.status.commands} comandos · ${eng.status.skills} skills` : `Motor não encontrado: ${eng.path}`, onclick: () => commandsModal(p) },
        `◆ ${eng.name}${eng.status && eng.status.version ? ' ' + eng.status.version : ''}`)
      : h('span', { class: 'chip', title: 'Sem motor: terminais abrem na pasta do projeto', text: 'sem motor' });
    head.appendChild(h('div', { class: 'head-title' },
      h('h1', { text: p.name }), h('span', { class: 'chip', text: KIND_LABEL[p.kind] || p.kind }), engChip,
      dir ? h('span', { class: 'path', title: dir, text: dir.replace(/^\/Users\/[^/]+/, '~') }) : null));
    const actions = h('div', { class: 'head-actions no-drag' });
    if (p.status === 'focus') actions.appendChild(h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => park(p) }, 'Estacionar'));
    else actions.appendChild(h('button', { class: 'aurora-btn aurora-btn--primary sm', onclick: () => bringToFocus(p) }, 'Trazer para o foco'));
    if (dir && !window.__REMOTE) actions.appendChild(h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => B.app.openInCursor(dir).catch(e => toast(e.message)) }, 'Abrir no Cursor'));
    actions.appendChild(h('button', { class: 'aurora-btn aurora-btn--glass sm icon', title: 'Ajustes do projeto', onclick: () => projectSettingsModal(p) }, '⋯'));
    head.appendChild(actions);
  }

  // ---------------- terminais ----------------
  // v0.2 (BP-2026-11-05-001): os terminais vivem em PAINÉIS (S.tree, até 4, de projetos diferentes). A barra de abas
  // mostra os terminais do projeto do painel em foco. Clicar numa aba troca o terminal do painel em foco; arrastar a
  // aba para a borda de um painel divide a tela. Cada aba/painel/projeto mostra o estado do Claude (E1).
  const L = window.Layout;
  const STATE_LABEL = { working: 'trabalhando', waiting: 'esperando você', background: 'esperando tarefa em segundo plano', done: 'terminou', unknown: 'sem notícia há 10 min (talvez interrompido)', idle: 'parado' };
  const STATE_RANK = { waiting: 5, working: 4, background: 3, done: 2, unknown: 1 };

  function defaultTerminal(p) {
    const eng = engineFor(p);
    if (eng) return { id: newId(), project_id: p.id, name: 'claude', cwd: null, startup: 'bancada:claude', skip_perms: !!S.settings.claude_skip_default };
    // sem nenhum motor (quem está começando): o primeiro terminal já é a IA, na pasta do projeto
    if ((p.paths || [])[0] && !S.engines.length) {
      const tok = S.aiInstalled.claude || (!S.aiInstalled.codex && !S.aiInstalled.google) ? 'bancada:claude' : S.aiInstalled.codex ? 'bancada:codex' : 'bancada:agy';
      return { id: newId(), project_id: p.id, name: AI_OF[tok] === 'google' ? 'google' : AI_OF[tok], cwd: null, startup: tok, skip_perms: false };
    }
    if ((p.paths || [])[0]) return { id: newId(), project_id: p.id, name: 'terminal', cwd: p.paths[0], startup: null };
    return null;
  }
  // dá para abrir Claude neste projeto: no motor, ou (sem motor) direto na pasta do projeto
  function canClaude(p) { return !!engineFor(p) || !!(p && (p.paths || [])[0]); }

  // terminal por id, em qualquer projeto já carregado
  function meta(id) {
    for (const [pid, list] of Object.entries(S.layout)) { const t = (list || []).find(x => x.id === id); if (t) return { t, p: proj(pid) }; }
    return null;
  }

  async function ensureLayout(p) {
    if (!S.layout[p.id]) {
      S.layout[p.id] = await B.terminals.list(p.id);
      if (!S.layout[p.id].length) {
        const t = defaultTerminal(p);
        if (t) { await B.terminals.save(t); S.layout[p.id] = [t]; }
      }
    }
    return S.layout[p.id];
  }

  function saveTree() { if (!window.__REMOTE) B.ui.layoutSet(S.tree).catch(() => {}); }

  // restaura a divisão salva (só no Mac): carrega os terminais e os projetos de cada painel
  async function restoreTree() {
    if (window.__REMOTE) return;
    const raw = await B.ui.layoutGet().catch(() => null);
    if (!raw) return;
    const rows = await B.terminals.byIds(L.leaves(raw)).catch(() => []);
    for (const pid of [...new Set(rows.map(r => r.project_id))]) { const p = proj(pid); if (p) await ensureLayout(p); }
    S.tree = L.sanitize(raw, new Set(rows.filter(r => meta(r.id)).map(r => r.id)));
    if (S.tree) { S.focusTerm = L.leaves(S.tree)[0]; const m = meta(S.focusTerm); if (m) S.activeTab[m.p.id] = m.t.id; }
  }

  async function showTerminals({ fromTab = false } = {}) {
    const p = proj(S.activeId); if (!p) return;
    const layout = await ensureLayout(p);
    const empty = $('#terms-empty');
    if (!layout.length) {
      renderTabs();
      empty.classList.remove('hidden');
      clear(empty).appendChild(h('div', {},
        h('p', { text: 'Este projeto ainda não tem terminal.' }),
        h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => newTerminalModal() }, '+ Abrir um terminal')));
      return;
    }
    empty.classList.add('hidden');
    const inTree = L.leaves(S.tree).filter(id => layout.some(t => t.id === id));
    if (!S.activeTab[p.id] || !layout.some(t => t.id === S.activeTab[p.id])) S.activeTab[p.id] = inTree[0] || layout[0].id;
    // pela barra lateral: se o projeto já tem painel à vista, só foca; pela aba: o terminal entra no painel em foco
    if (!fromTab && !L.has(S.tree, S.activeTab[p.id]) && inTree.length) S.activeTab[p.id] = inTree[0];
    const id = S.activeTab[p.id];
    if (window.__REMOTE || !S.tree) S.tree = L.leaf(id);
    else if (!L.has(S.tree, id)) {
      const target = L.has(S.tree, S.focusTerm) ? S.focusTerm : L.leaves(S.tree)[0];
      S.tree = L.place(S.tree, target, id, 'center').tree;
      saveTree();
    }
    S.focusTerm = id;
    await renderPanes();
    renderTabs(); renderSide();
  }

  function stateOf(id) { const s = S.cst[id]; return s && s.state !== 'idle' && s.state !== 'off' ? s.state : null; }
  function dotFor(id) {
    const st = stateOf(id);
    const alive = window.Terminals.isAlive(id);
    return h('span', { class: `dot ${st ? 'st-' + st : alive ? 'live' : ''}`, title: st ? `Claude: ${STATE_LABEL[st]}` : alive ? 'rodando' : 'parado' });
  }
  function projectState(pid) {
    let best = null;
    for (const [id, s] of Object.entries(S.cst)) {
      if (s.projectId !== pid) continue;
      const st = stateOf(id); if (st && (!best || STATE_RANK[st] > STATE_RANK[best])) best = st;
    }
    return best;
  }

  function ctxChip(id) {
    const c = S.ctx[id]; if (!c) return null;
    const k = (n) => n >= 1000000 ? `${(n / 1000000).toFixed(1)} M` : `${Math.round(n / 1000)} k`;
    const level = c.pct >= 90 ? 'red' : c.pct >= 75 ? 'amber' : '';
    return h('span', { class: `ctx ${level}`, title: `Contexto da conversa: ${k(c.tokens)} de ${k(c.window)} tokens${c.pct >= 75 ? '\nQuase cheio: rode /compact ou comece uma conversa nova (duplo clique na aba).' : ''}` }, `${c.pct}%`);
  }

  function urlChips(id) {
    if (window.__REMOTE || !B.preview) return [];
    return (S.urls[id] || []).map(u => h('button', { class: 'urlchip', title: `Abrir prévia de ${u.url}`, onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); B.preview.open(u.url).catch(er => toast(er.message)); } }, `▶ :${u.port}`));
  }

  function paneHead(id) {
    const m = meta(id);
    const n = L.count(S.tree);
    return h('div', { class: 'pane-head' },
      dotFor(id),
      h('span', { class: 'pane-title', text: m ? `${shortName(m.p.name)} · ${m.t.name}` : id }),
      stateOf(id) ? h('span', { class: `pane-state st-${stateOf(id)}`, text: STATE_LABEL[stateOf(id)] }) : null,
      h('span', { class: 'pane-extras' }, urlChips(id), ctxChip(id),
        n > 1 ? h('button', { class: 'pane-x', title: 'Fechar painel (o terminal continua rodando na aba)', onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); closePane(id); } }, '×') : null));
  }

  function paintPaneHeads() {
    for (const el of document.querySelectorAll('#terms .pane')) {
      const id = el.dataset.id; const old = el.querySelector(':scope > .pane-head');
      if (old) old.replaceWith(paneHead(id));
      el.classList.toggle('focus', id === S.focusTerm);
    }
    if (window.ActivityUI) window.ActivityUI.paintStrips();
  }

  let paneSeq = 0;
  async function renderPanes() {
    const host = $('#terms');
    const seq = ++paneSeq;
    const ids = L.leaves(S.tree).filter(id => meta(id));
    window.Terminals.stashExcept([]);                 // tira os xterm dos painéis antigos antes de redesenhar
    clear(host);
    if (!ids.length) return;
    host.dataset.panes = String(ids.length);
    const bodies = {};
    const build = (node, pathStr) => {
      if (L.isLeaf(node)) {
        if (!meta(node.t)) return null;
        const body = h('div', { class: 'pane-body' });
        bodies[node.t] = body;
        const el = h('div', { class: `pane ${node.t === S.focusTerm ? 'focus' : ''}`, dataset: { id: node.t } }, paneHead(node.t), body, h('div', { class: 'pane-drop hidden' }));
        el.addEventListener('mousedown', () => focusPane(node.t));
        bindPaneDrop(el, node.t);
        return el;
      }
      const a = build(node.a, pathStr + 'a'), b = build(node.b, pathStr + 'b');
      if (!a) return b; if (!b) return a;
      const box = h('div', { class: `split ${node.d}` });
      a.style.flex = `${node.r} 1 0`; b.style.flex = `${1 - node.r} 1 0`;
      const div = h('div', { class: `divider ${node.d}`, title: 'Arraste para ajustar' });
      bindDivider(div, box, a, b, node.d, pathStr);
      box.append(a, div, b);
      return box;
    };
    const rootEl = build(S.tree, '');
    if (rootEl) host.appendChild(rootEl);
    for (const id of ids) {
      if (seq !== paneSeq) return;                     // outro desenho começou: este para
      const { t, p } = meta(id);
      const r = await window.Terminals.open({ id: t.id, projectId: p.id, name: t.name, cwd: t.cwd, startup: t.startup, container: bodies[id] });
      if (r && r.warning) toast(r.warning, 6000);
    }
    window.Terminals.focus(S.focusTerm);
    paintPaneHeads();
    window.AskUI.paint();
  }

  function bindDivider(div, box, a, b, d, pathStr) {
    div.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      const rect = box.getBoundingClientRect();
      const size = d === 'row' ? rect.width : rect.height;
      const min = Math.min(0.45, 320 / Math.max(1, size));
      let r = null;
      const move = (ev) => {
        r = d === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        r = Math.min(1 - min, Math.max(min, r));
        a.style.flex = `${r} 1 0`; b.style.flex = `${1 - r} 1 0`;
      };
      const up = () => {
        div.removeEventListener('pointermove', move); div.removeEventListener('pointerup', up); div.removeEventListener('pointercancel', up);
        if (r != null) { S.tree = L.setRatio(S.tree, pathStr, r); saveTree(); }
      };
      div.addEventListener('pointermove', move); div.addEventListener('pointerup', up); div.addEventListener('pointercancel', up);
    });
  }

  // soltar no painel: aba (divide/troca) ou arquivo da árvore (cola o caminho)
  function bindPaneDrop(el, id) {
    const ov = el.querySelector('.pane-drop');
    const accepts = (c) => c && (c.kind === 'tab' || c.kind === 'file');
    el.addEventListener('dragover', (e) => {
      const c = window.DnD.current(); if (!accepts(c)) return;
      e.preventDefault(); e.stopPropagation();
      const zone = c.kind === 'file' || window.__REMOTE ? 'center' : L.zoneAt(el.getBoundingClientRect(), e.clientX, e.clientY);
      ov.className = `pane-drop z-${zone}`;
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) ov.className = 'pane-drop hidden'; });
    el.addEventListener('drop', (e) => {
      const c = window.DnD.current(); if (!accepts(c)) return;
      e.preventDefault(); e.stopPropagation();
      ov.className = 'pane-drop hidden';
      if (c.kind === 'file') { window.Terminals.paste(id, window.Terminals.quote(c.path) + ' '); return; }
      const zone = window.__REMOTE ? 'center' : L.zoneAt(el.getBoundingClientRect(), e.clientX, e.clientY);
      placeTab(c.id, id, zone);
    });
  }

  function placeTab(tabId, targetId, zone) {
    const r = L.place(S.tree, targetId, tabId, zone);
    if (r.error === 'MAX') { toast(`Máximo de ${L.MAX} painéis. Feche um (×) para abrir outro.`); return; }
    S.tree = r.tree; S.focusTerm = tabId; saveTree();
    const m = meta(tabId); if (m) S.activeTab[m.p.id] = tabId;
    renderPanes().then(() => { renderTabs(); renderSide(); });
  }

  function closePane(id) {
    S.tree = L.remove(S.tree, id);
    if (S.focusTerm === id || !L.has(S.tree, S.focusTerm)) S.focusTerm = L.leaves(S.tree)[0] || null;
    saveTree();
    const m = S.focusTerm && meta(S.focusTerm);
    if (m && m.p.id !== S.activeId) { S.activeId = m.p.id; S.activeTab[m.p.id] = m.t.id; renderHead(); renderPanel(); }
    renderPanes().then(() => { renderTabs(); renderSide(); });
  }

  // painel em foco = projeto ativo (cabeçalho, abas e painel lateral seguem o painel que você clicou)
  function focusPane(id) {
    if (!id) return;
    const m = meta(id); if (!m) return;
    const changed = S.focusTerm !== id;
    S.focusTerm = id; S.activeTab[m.p.id] = id;
    if (window.__REMOTE) B.claude.seen(id).catch(() => {}); else B.ui.focusTerm(id).catch(() => {});
    if (!changed) return;
    if (S.activeId !== m.p.id) { S.activeId = m.p.id; B.projects.setActive(m.p.id).catch(() => {}); renderHead(); renderPanel(); }
    paintPaneHeads(); renderTabs(); renderSide();
    if (!S.ctx[id] && m.t.startup === 'bancada:claude') B.claude.context(id).then(c => { if (c) { S.ctx[id] = c; paintPaneHeads(); } }).catch(() => {});
  }

  function tabLabel(p, t) {
    const icon = t.startup === 'bancada:claude' ? (t.skip_perms ? '⚡ ' : '✳︎ ') : t.startup === 'bancada:engine' ? '◆ ' : '';
    return `${icon}${shortName(p.name)} · ${t.name}`;
  }

  function renderTabs() {
    const p = proj(S.activeId); const tabs = clear($('#tabs'));
    if (!p) return;
    const visible = new Set(L.leaves(S.tree));
    for (const t of S.layout[p.id] || []) {
      const on = S.focusTerm === t.id;
      const st = stateOf(t.id);
      const el = h('div', { class: `tab ${on ? 'on' : ''} ${visible.has(t.id) && !on ? 'shown' : ''}`, dataset: { id: t.id },
        title: `${t.startup === 'bancada:claude' ? 'Claude rodando no motor, focado neste projeto.' : ''}${st ? ` Agora: ${STATE_LABEL[st]}.` : ''}\nArraste para a borda de um painel para dividir · botão direito: abrir ao lado · duplo clique: ajustes`,
        onclick: () => { S.activeTab[p.id] = t.id; showTerminals({ fromTab: true }); }, ondblclick: () => terminalModal(t),
        oncontextmenu: (e) => { e.preventDefault(); tabMenu(t); } },
        dotFor(t.id),
        h('span', { text: tabLabel(p, t) }),
        h('button', { class: 'tab-x', title: 'Fechar terminal', onclick: (e) => { e.stopPropagation(); closeTerminal(t); } }, '×'));
      draggable(el, { kind: 'tab', id: t.id, text: t.name });
      tabs.appendChild(el);
    }
    if (canClaude(p)) {
      const where = engineFor(p) ? 'no motor' : 'na pasta do projeto';
      tabs.appendChild(h('button', { class: 'tab add claude', title: `Novo Claude ${where}, com permissões normais (pede confirmação)`, onclick: () => quickClaude(false) }, '+ ✳︎ Claude'));
      tabs.appendChild(h('button', { class: 'tab add claude skip', title: `Novo Claude ${where} com --dangerously-skip-permissions (não pede confirmação de nada)`, onclick: () => quickClaude(true) }, '+ ⚡ sem permissões'));
    }
    tabs.appendChild(h('button', { class: 'tab add', title: 'Novo terminal (⌘T)', onclick: () => newTerminalModal() }, '+'));
    if (!window.__REMOTE) tabs.appendChild(h('button', { class: 'tab add split-btn', title: 'Dividir a tela: abrir outro terminal ao lado (⌘\\). Também dá para arrastar uma aba para a borda do painel.', onclick: () => splitMenu() }, '◫ Dividir'));
  }
  function shortName(n) { return n.length > 14 ? n.slice(0, 13) + '…' : n; }

  // menu do botão Dividir: outro terminal deste projeto, ou um novo, abre à direita do painel em foco
  function splitMenu() {
    const p = proj(S.activeId); if (!p || S.view !== 'project') return;
    if (L.count(S.tree) >= L.MAX) { toast(`Já são ${L.MAX} painéis. Feche um (×) para abrir outro.`); return; }
    const visible = new Set(L.leaves(S.tree));
    const others = (S.layout[p.id] || []).filter(t => !visible.has(t.id));
    modal((c, close) => {
      const pick = (id, zone = 'right') => { close(); placeTab(id, S.focusTerm, zone); };
      const add = async (t, zone) => { try { await B.terminals.save(t); } catch (e) { toast(e.message); return; } S.layout[p.id] = [...(S.layout[p.id] || []), t]; pick(t.id, zone); };
      const newClaude = (skip) => ({ id: newId(), project_id: p.id, name: skip ? 'claude ⚡' : 'claude', cwd: null, startup: 'bancada:claude', skip_perms: !!skip });
      const zone = h('select', { class: 'aurora-input sm' }, h('option', { value: 'right', text: 'à direita' }), h('option', { value: 'bottom', text: 'abaixo' }));
      c.append(h('h2', { text: 'Dividir a tela' }),
        h('div', { class: 'row' }, h('span', { class: 'muted small', text: 'Abrir' }), zone, h('span', { class: 'muted small', text: 'do painel em foco:' })),
        h('div', { class: 'park-list' },
          others.map(t => h('button', { class: 'park-opt', onclick: () => pick(t.id, zone.value) }, h('strong', { text: tabLabel(p, t) }), h('span', { class: 'muted small', text: 'terminal deste projeto que não está à vista' }))),
          canClaude(p) ? h('button', { class: 'park-opt', onclick: () => add(newClaude(false), zone.value) }, h('strong', { text: '+ ✳︎ Claude novo' }), h('span', { class: 'muted small', text: 'permissões normais' })) : null,
          canClaude(p) ? h('button', { class: 'park-opt', onclick: () => add(newClaude(true), zone.value) }, h('strong', { text: '+ ⚡ Claude sem permissões' }), h('span', { class: 'muted small', text: '--dangerously-skip-permissions' })) : null,
          (p.paths || [])[0] && S.aiInstalled.codex ? h('button', { class: 'park-opt', onclick: () => add({ id: newId(), project_id: p.id, name: 'codex', cwd: null, startup: 'bancada:codex' }, zone.value) }, h('strong', { text: '+ ◎ Codex' }), h('span', { class: 'muted small', text: 'ChatGPT, na pasta do projeto' })) : null,
          (p.paths || [])[0] && S.aiInstalled.google ? h('button', { class: 'park-opt', onclick: () => add({ id: newId(), project_id: p.id, name: 'google', cwd: null, startup: 'bancada:agy' }, zone.value) }, h('strong', { text: '+ ✦ Google' }), h('span', { class: 'muted small', text: 'Antigravity, na pasta do projeto' })) : null,
          (p.paths || [])[0] ? h('button', { class: 'park-opt', onclick: () => add({ id: newId(), project_id: p.id, name: 'terminal', cwd: p.paths[0], startup: null }, zone.value) }, h('strong', { text: '+ Terminal na pasta do projeto' })) : null),
        h('p', { class: 'muted small', text: 'Para pôr um terminal de OUTRO projeto ao lado: abra o projeto na barra lateral e arraste a aba dele para a borda do painel.' }),
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar')));
    });
  }

  function tabMenu(t) {
    if (window.__REMOTE) return;
    const shown = L.has(S.tree, t.id);
    modal((c, close) => {
      const go2 = (zone) => { close(); placeTab(t.id, S.focusTerm, zone); };
      c.append(h('h2', { text: t.name }), h('div', { class: 'park-list' },
        t.id !== S.focusTerm ? h('button', { class: 'park-opt', onclick: () => go2('right') }, h('strong', { text: 'Abrir à direita do painel em foco' })) : null,
        t.id !== S.focusTerm ? h('button', { class: 'park-opt', onclick: () => go2('bottom') }, h('strong', { text: 'Abrir abaixo do painel em foco' })) : null,
        shown && L.count(S.tree) > 1 ? h('button', { class: 'park-opt', onclick: () => { close(); closePane(t.id); } }, h('strong', { text: 'Fechar o painel (o terminal continua na aba)' })) : null,
        h('button', { class: 'park-opt', onclick: () => { close(); terminalModal(t); } }, h('strong', { text: 'Ajustes do terminal…' }))),
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar')));
    });
  }

  async function quickClaude(skip) {
    const p = proj(S.activeId); if (!p) return;
    const n = (S.layout[p.id] || []).filter(t => t.startup === 'bancada:claude' && !!t.skip_perms === !!skip).length;
    const t = { id: newId(), project_id: p.id, name: skip ? `claude ⚡${n ? ' ' + (n + 1) : ''}` : `claude${n ? ' ' + (n + 1) : ''}`, cwd: null, startup: 'bancada:claude', skip_perms: !!skip };
    try { await B.terminals.save(t); } catch (e) { toast(e.message); return; }
    S.layout[p.id] = [...(S.layout[p.id] || []), t]; S.activeTab[p.id] = t.id; showTerminals({ fromTab: true });
  }

  function newTerminalModal() {
    const p = proj(S.activeId); if (!p) return;
    const eng = engineFor(p);
    modal((card, close) => {
      const name = h('input', { class: 'aurora-input', placeholder: 'nome (ex.: claude, dev, testes)', autofocus: true });
      const hasDir = !!(p.paths || [])[0];
      const allowed = ([v]) => v === 'bancada:engine' ? !!eng : v === 'bancada:claude' ? canClaude(p) : AI_OF[v] ? hasDir : true;
      const sel = h('select', { class: 'aurora-input' }, STARTUPS.filter(allowed).map(([v, l]) => h('option', { value: v, text: AI_OF[v] && !S.aiInstalled[AI_OF[v]] ? `${l} — não instalado` : l })));
      const cwd = h('input', { class: 'aurora-input', value: (p.paths || [])[0] || '', placeholder: '/caminho/da/pasta' });
      const cwdField = field('Pasta', cwd);
      const skip = h('input', { type: 'checkbox', checked: !!S.settings.claude_skip_default });
      const skipField = h('label', { class: 'field check' }, skip, h('span', { text: 'Sem permissões (--dangerously-skip-permissions): o Claude não pede confirmação de nada' }));
      const hint = h('p', { class: 'muted small' });
      const sync = () => {
        const tok = sel.value.startsWith('bancada:');
        cwdField.classList.toggle('hidden', tok);
        skipField.classList.toggle('hidden', sel.value !== 'bancada:claude');
        const ai = AI_OF[sel.value];
        hint.textContent = ai && !S.aiInstalled[ai] ? 'Esta IA ainda não está instalada: abra Ajustes → Assistentes de IA e clique em Instalar.'
          : sel.value === 'bancada:claude' ? (eng ? `Abre o claude em ${eng.path.replace(/^\/Users\/[^/]+/, '~')} com acesso à pasta do projeto e avisado de que o foco é ${p.name}. Reabrir o app retoma a mesma conversa.`
            : `Abre o claude direto na pasta do projeto. Reabrir o app retoma a mesma conversa.`)
          : sel.value === 'bancada:codex' ? 'Abre o Codex (ChatGPT) na pasta do projeto.'
          : sel.value === 'bancada:agy' ? 'Abre a IA do Google (Antigravity CLI) na pasta do projeto.'
          : sel.value === 'bancada:engine' ? 'Shell na pasta do motor.' : '';
        const auto = { 'bancada:claude': 'claude', 'bancada:codex': 'codex', 'bancada:agy': 'google', 'bancada:engine': 'motor' };
        if (!name.value || ['claude', 'codex', 'google', 'motor', 'terminal'].includes(name.value)) name.value = auto[sel.value] || 'terminal';
      };
      sel.addEventListener('change', sync); sync();
      const ok = async () => {
        const t = { id: newId(), project_id: p.id, name: name.value.trim() || 'terminal', cwd: sel.value.startsWith('bancada:') ? null : (cwd.value.trim() || null), startup: sel.value || null, skip_perms: sel.value === 'bancada:claude' && skip.checked };
        try { await B.terminals.save(t); } catch (e) { toast(e.message); return; }
        S.layout[p.id] = [...(S.layout[p.id] || []), t]; S.activeTab[p.id] = t.id; close(); showTerminals({ fromTab: true });
      };
      name.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
      card.append(h('h2', { text: `Novo terminal em ${p.name}` }), field('Abrir como', sel), hint, skipField, field('Nome', name), cwdField,
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar'), h('button', { class: 'aurora-btn aurora-btn--primary', onclick: ok }, 'Abrir')));
    });
  }

  function terminalModal(t) {
    modal((card, close) => {
      const name = h('input', { class: 'aurora-input', value: t.name, autofocus: true });
      const ok = async () => { t.name = name.value.trim() || t.name; await B.terminals.save(t).catch(e => toast(e.message)); close(); renderTabs(); paintPaneHeads(); };
      name.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
      card.append(h('h2', { text: 'Terminal' }), field('Nome', name));
      if (t.startup === 'bancada:claude') {
        card.append(h('div', { class: 'row wrap' },
          h('span', { class: `chip ${t.skip_perms ? 'warn' : ''}`, text: t.skip_perms ? '⚡ sem permissões' : '✳︎ permissões normais' }),
          h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: async () => {
            t.skip_perms = !t.skip_perms;
            await B.terminals.save(t).catch(e => toast(e.message));
            close(); renderTabs();
            await window.Terminals.restart(t.id);      // reabre o claude no modo novo, mesma conversa
            toast(t.skip_perms ? 'Claude reaberto sem permissões (mesma conversa)' : 'Claude reaberto com permissões normais (mesma conversa)');
          } }, t.skip_perms ? 'Voltar para permissões normais' : 'Reabrir sem permissões')));
        card.append(h('p', { class: 'muted small', text: 'Este terminal guarda a conversa do Claude: fechar e reabrir o app continua de onde parou.' }),
          h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: async () => {
            if (!confirm('Começar uma conversa nova neste terminal? A atual continua salva no histórico do Claude (/resume).')) return;
            await B.terminals.newConversation(t.id); delete S.ctx[t.id]; await window.Terminals.close(t.id); close(); renderPanes();
          } }, 'Começar conversa nova'));
      }
      card.append(h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--primary', onclick: ok }, 'Salvar')));
    });
  }

  async function closeTerminal(t) {
    const m = meta(t.id); if (!m) return;
    if (window.Terminals.isAlive(t.id) && !confirm(`Fechar o terminal "${t.name}"? O processo dentro dele será encerrado.`)) return;
    await window.Terminals.close(t.id);
    await B.terminals.remove(t.id);
    S.layout[m.p.id] = S.layout[m.p.id].filter(x => x.id !== t.id);
    delete S.cst[t.id]; delete S.ctx[t.id]; delete S.urls[t.id];
    if (L.has(S.tree, t.id)) {
      // o painel fica: entra outro terminal do mesmo projeto, se houver; senão o painel fecha
      const next = S.layout[m.p.id].find(x => !L.has(S.tree, x.id));
      S.tree = next ? L.replace(S.tree, t.id, next.id) : L.remove(S.tree, t.id);
      if (S.focusTerm === t.id) S.focusTerm = next ? next.id : (L.leaves(S.tree)[0] || null);
      if (next) S.activeTab[m.p.id] = next.id;
      saveTree();
    }
    if (S.activeTab[m.p.id] === t.id) delete S.activeTab[m.p.id];
    const f = S.focusTerm && meta(S.focusTerm);
    if (f && f.p.id !== S.activeId) { S.activeId = f.p.id; renderHead(); renderPanel(); }
    await renderPanes();
    showTerminals();
  }

  function focusedTerminal() {
    if (S.focusTerm && window.Terminals.isAlive(S.focusTerm)) return S.focusTerm;
    const p = proj(S.activeId); const tid = p && S.activeTab[p.id];
    return tid && window.Terminals.isAlive(tid) ? tid : null;
  }

  async function pasteToTerminal(text) {
    const tid = focusedTerminal();
    if (!tid) { toast('Abra um terminal deste projeto primeiro'); return false; }
    await B.pty.paste(tid, text); window.Terminals.focus(tid);
    return true;
  }

  // ---- estado do Claude (E1), contexto (E5) e servidores locais (E5) chegando do processo principal ----
  function bindLive() {
    B.claude.onState((e) => {
      if (e.state === 'off') delete S.cst[e.id]; else S.cst[e.id] = e;
      if (e.ctx) S.ctx[e.id] = e.ctx;
      // você está olhando este terminal: "terminou" não precisa ficar aceso
      if (e.state === 'done' && e.id === S.focusTerm && document.hasFocus() && S.view === 'project') {
        if (window.__REMOTE) B.claude.seen(e.id).catch(() => {}); else B.ui.focusTerm(e.id).catch(() => {});
      }
      renderTabs(); renderSide(); paintPaneHeads(); paintTitle();
      if (window.ActivityUI) window.ActivityUI.Office.sync();
      if (e.state === 'done' && e.projectId === S.activeId && window.FilesPanel && S.panelTab !== 'project') window.FilesPanel.refresh();
      if (window.__REMOTE) remoteNotice(e);
    });
    B.pty.onUrl((e) => { const list = S.urls[e.id] = S.urls[e.id] || []; if (!list.some(u => u.port === e.port)) list.push(e); paintPaneHeads(); toast(`Servidor local no ar: ${e.url}${window.__REMOTE ? '' : ' (▶ no painel abre a prévia)'}`); });
    B.ui.onGoTerminal((e) => goTerminal(e.projectId, e.id));
  }
  // terminais que aparecem no Escritório: os de IA (ou com estado de Claude) deste projeto ou dos projetos em foco
  const officeLoading = new Set();
  function officeTerms(scope) {
    const pids = scope === 'all' ? [...focusProjects().map(p => p.id), ...Object.keys(S.layout)] : [S.activeId];
    const out = []; const seen = new Set();
    for (const pid of pids) {
      if (seen.has(pid)) continue; seen.add(pid);
      const p = proj(pid); if (!p) continue;
      // projeto em foco que ainda não foi aberto: busca os terminais salvos (sem criar nenhum) e redesenha a sala
      if (!S.layout[pid] && !officeLoading.has(pid)) {
        officeLoading.add(pid);
        B.terminals.list(pid).then((l) => { if (!S.layout[pid] && l && l.length) S.layout[pid] = l; if (window.ActivityUI) window.ActivityUI.Office.sync(); }).catch(() => {});   // uma vez por projeto: sem isso, projeto sem terminal buscaria em laço
      }
      for (const t of S.layout[pid] || []) {
        const st = S.cst[t.id] && S.cst[t.id].state;
        if (!st && !/^bancada:/.test(t.startup || '')) continue;
        out.push({ id: t.id, name: t.name, projectId: p.id, projectName: shortName(p.name), state: st && st !== 'off' ? st : null });
      }
    }
    return out.slice(0, 16);
  }

  async function goTerminal(projectId, termId) {
    const p = proj(projectId); if (!p) return;
    await ensureLayout(p);
    S.activeTab[p.id] = termId;
    go('project', p.id, { fromTab: true });
  }
  async function loadLive() {
    try { for (const s of await B.claude.states()) { S.cst[s.id] = s; if (s.ctx) S.ctx[s.id] = s.ctx; } } catch {}
    try { for (const t of await B.pty.live()) if (t.urls && t.urls.length) S.urls[t.id] = t.urls; } catch {}
    paintTitle();
  }
  function paintTitle() {
    const n = Object.keys(S.cst).filter(id => stateOf(id) === 'waiting').length;
    document.title = n ? `(${n}) Bancada` : 'Bancada';
  }
  // no celular não há notificação do sistema (Safari exige HTTPS): aviso na própria página
  function remoteNotice(e) {
    if (!(e.state === 'waiting' || (e.state === 'done' && e.workedMs >= 20000))) return;
    if (e.id === S.focusTerm && document.hasFocus()) return;
    const m = meta(e.id); const where = m ? `${m.p.name} · ${m.t.name}` : 'Claude';
    toast(e.state === 'waiting' ? `⏳ ${where}: esperando você` : `✓ ${where}: terminou`, 8000);
    try { if (navigator.vibrate) navigator.vibrate(e.state === 'waiting' ? [80, 60, 80] : 60); } catch {}
  }

  // ---------------- painel lateral (cartões arrastáveis e recolhíveis) ----------------
  async function renderPanel() {
    const p = proj(S.activeId); const panel = clear($('#panel'));
    if (!p) return;
    // abas do painel: Projeto (cartões) · Arquivos · Mudanças (E2)
    const seg = h('div', { class: 'panel-seg' });
    const tabsDef = [['project', 'Projeto'], ['files', 'Arquivos'], ['changes', 'Mudanças'], ['office', 'Escritório']];
    for (const [k, l] of tabsDef) seg.appendChild(h('button', { class: `seg-btn ${S.panelTab === k ? 'on' : ''}`, dataset: { k }, onclick: () => { S.panelTab = k; save('bancada.panelTab', k); renderPanel(); } }, l));
    panel.appendChild(seg);
    if (S.panelTab === 'office' && window.ActivityUI) {
      if (window.FilesPanel) window.FilesPanel.stop();
      const host = h('div', { class: 'office-host' });
      panel.appendChild(host);
      window.ActivityUI.Office.mount(host);
      return;
    }
    if (window.ActivityUI) window.ActivityUI.Office.unmount();
    if (S.panelTab === 'files' || S.panelTab === 'changes') {
      const host = h('div', { class: 'fp' });
      panel.appendChild(host);
      window.FilesPanel.render(host, S.panelTab, { project: p, pasteToTerminal, onCount: (n) => { const b = seg.querySelector('[data-k="changes"]'); if (b) b.textContent = n ? `Mudanças · ${n}` : 'Mudanças'; } });
      return;
    }
    if (window.FilesPanel) window.FilesPanel.stop();
    const items = await B.items.list(p.id);
    const sessions = await B.sessions.forProject(p.id, 5).catch(() => []);
    const builders = {
      where: () => cardWhere(p), next: () => cardNext(p), pending: () => cardPending(p, items), prompts: () => cardPrompts(p, items),
      notes: () => cardNotes(p, items), commands: () => cardCommands(p), sessions: () => cardSessions(p, sessions),
    };
    const order = S.cardOrder.filter(id => builders[id]);
    // cartão novo (ex.: Pendências, v0.4) entra no lugar dele na ordem padrão, não no fim
    CARD_IDS.forEach((id, i) => { if (!order.includes(id)) { const prev = CARD_IDS.slice(0, i).reverse().find(x => order.includes(x)); order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id); } });
    for (const id of order) { const c = builders[id](); if (c) panel.appendChild(c); }
  }

  function card(id, title, extras, body) {
    const collapsed = !!S.collapsed[id];
    const el = h('section', { class: `card aurora-glass ${collapsed ? 'collapsed' : ''}`, dataset: { id } },
      h('div', { class: 'card-head' },
        h('span', { class: 'grip', title: 'Arraste para reorganizar', text: '⠿' }),
        h('button', { class: 'card-title', title: collapsed ? 'Abrir' : 'Recolher', onclick: () => { S.collapsed[id] = !collapsed; save('bancada.collapsed', S.collapsed); renderPanel(); } }, title),
        h('span', { class: 'card-extras' }, collapsed ? [] : extras)),
      collapsed ? null : body);
    draggable(el, { kind: 'card', id }, { handle: '.card-head' });
    return el;
  }

  function cardWhere(p) {
    const ws = h('div', { class: 'card-body ws' }, p.where_stopped ? p.where_stopped : h('span', { class: 'muted', text: 'Ainda não há registro. Trabalhe numa sessão do Claude/Codex neste projeto ou escreva aqui.' }));
    editable(ws, p.where_stopped, async (val) => { await B.projects.update(p.id, { where_stopped: val || null }); await loadProjects(); renderPanel(); }, { placeholder: 'Onde você parou?' });
    return card('where', 'Onde parei', [
      p.where_stopped_src ? h('span', { class: `src src-${p.where_stopped_src}`, text: SRC_LABEL[p.where_stopped_src] }) : null,
      p.where_stopped_at ? h('span', { class: 'when', text: ago(p.where_stopped_at) }) : null,
      h('button', { class: 'mini', title: 'Atualizar com a última sessão', onclick: async (e) => { e.target.disabled = true; try { await B.summary.refresh(p.id); toast('Atualizando a partir da última sessão…'); } catch (er) { toast(er.message); } } }, '↻'),
    ], ws);
  }

  function cardNext(p) {
    const ns = h('div', { class: 'card-body next' }, p.next_step ? h('span', { text: p.next_step }) : h('span', { class: 'muted', text: 'Qual é a próxima ação? Uma só.' }));
    editable(ns, p.next_step, async (val) => { await B.projects.update(p.id, { next_step: val || null }); await loadProjects(); renderPanel(); renderSide(); }, { multiline: false, placeholder: 'Verbo + coisa. Ex.: testar o login no tablet' });
    return card('next', 'Próximo passo', [
      p.next_step_src ? h('span', { class: `src src-${p.next_step_src}`, text: SRC_LABEL[p.next_step_src] }) : null,
      p.next_step ? h('button', { class: 'mini', title: 'Mandar para o terminal', onclick: () => pasteToTerminal(p.next_step) }, '⚡') : null,
      p.next_step ? h('button', { class: 'mini ok', title: 'Feito! Qual é o próximo?', onclick: () => stepDone(p) }, '✓') : null,
      p.next_step ? h('button', { class: 'mini', title: 'Pôr no Hoje', onclick: () => addStepToToday(p) }, '☀︎') : null,
    ], ns);
  }

  function itemList(list, rowFn) {
    const box = h('div', { class: 'item-list' }, list.map(rowFn));
    sortable(box, { accepts: (d) => d.kind === 'item' && list.some(i => i.id === d.id), itemSelector: '.item[data-id]', onDrop: async (ids) => { await B.items.reorder(ids).catch(e => toast(e.message)); renderPanel(); } });
    return box;
  }

  function cardPrompts(p, items) {
    const prompts = items.filter(i => i.type === 'prompt' && i.state === 'active');
    return card('prompts', `Fila de prompts${prompts.length ? ` · ${prompts.length}` : ''}`, [], h('div', { class: 'card-body list' },
      prompts.length ? itemList(prompts, promptRow) : h('div', { class: 'muted', text: 'Prompts que você anotar aqui vão para o terminal com um clique.' }),
      addBox(p.id, 'prompt', 'Novo prompt… (⌘↩)')));
  }

  function cardNotes(p, items) {
    const notes = items.filter(i => i.type !== 'prompt' && i.type !== 'step' && i.type !== 'pending' && i.state === 'active');
    return card('notes', 'Notas e ideias', [], h('div', { class: 'card-body list' }, notes.length ? itemList(notes, noteRow) : null, addBox(p.id, 'note', 'Anotar… (⌘↩)')));
  }

  // Pendências (v0.4): o que o usuário marcou "Adiar" nos cartões, ou o Claude anotou. Sem aviso (decisão dele).
  function cardPending(p, items) {
    const list = items.filter(i => i.type === 'pending' && i.state === 'active');
    if (!list.length) return null;
    const row = (it) => h('div', { class: 'item pend', dataset: { id: it.id } },
      h('button', { class: 'mini ok', title: 'Feito', onclick: async () => { await B.items.update(it.id, { state: 'done' }).catch(e => toast(e.message)); renderPanel(); } }, '✓'),
      h('span', { class: 'item-text', text: it.text }),
      h('span', { class: 'when', text: ago(it.created_at) }),
      h('button', { class: 'mini', title: 'Mandar para o terminal', onclick: () => pasteToTerminal(it.text) }, '⚡'),
      h('button', { class: 'mini', title: 'Apagar', onclick: async () => { await B.items.remove(it.id).catch(e => toast(e.message)); renderPanel(); } }, '✕'));
    return card('pending', `Pendências · ${list.length}`, [
      h('button', { class: 'mini', title: 'Pedir ao Claude para mostrar o que resta em lista (Já fiz / Adiar / Fazer agora)', onclick: () => pasteToTerminal('o que resta? mostre em lista para eu marcar') }, '☰'),
    ], h('div', { class: 'card-body list' }, itemList(list, row)));
  }

  // Novo projeto guiado (v0.4): abre um Claude que entrevista o usuário, uma pergunta por vez, e no fim leva à forja
  function guidedModal() {
    const all = [...focusProjects(), ...shelfProjects()].filter(p => canClaude(p));
    const inbox = proj('inbox');
    const choices = [...all, ...(inbox && canClaude(inbox) ? [inbox] : [])];
    if (!choices.length) { toast('Primeiro conecte o Claude (Ajustes → Assistentes de IA) e crie um projeto.'); return; }
    modal((card, close) => {
      const what = h('textarea', { class: 'aurora-input', rows: '3', maxlength: '1500', autofocus: true, placeholder: 'Ex.: um setor novo no sistema da empresa para o almoxarifado. Pode deixar em branco: a primeira pergunta é essa.' });
      const cur = proj(S.activeId);
      const sel = h('select', { class: 'aurora-input' }, choices.map(p => h('option', { value: p.id, selected: cur && p.id === cur.id, text: p.id === 'inbox' ? 'Ainda não existe (começa pelo Inbox)' : p.name })));
      const ok = async () => {
        const p = proj(sel.value); if (!p) return;
        await ensureLayout(p);
        const t = { id: newId(), project_id: p.id, name: 'entrevista', cwd: null, startup: 'bancada:claude', skip_perms: false };
        try {
          await B.terminals.save(t);
          await B.terminals.initialPrompt(t.id, `/bancada:entrevista ${what.value.replace(/\s+/g, ' ').trim()}`.trim());
        } catch (e) { toast(e.message); return; }
        S.layout[p.id] = [...(S.layout[p.id] || []), t]; close();
        goTerminal(p.id, t.id);
      };
      what.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ok(); });
      card.append(h('h2', { text: 'Novo projeto guiado' }),
        h('p', { class: 'muted small', text: 'O Claude te faz uma pergunta por vez, com opções para tocar, até entender de verdade o que você quer. No fim mostra o resumo para você confirmar e, se tiver a athena, já manda para a forja do blueprint.' }),
        field('O que vamos criar?', what), field('Em qual projeto?', sel),
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar'), h('button', { class: 'aurora-btn aurora-btn--primary', onclick: ok }, 'Começar')));
    });
  }

  function cardSessions(p, sessions) {
    if (!sessions.length) return null;
    return card('sessions', 'Sessões recentes', [], h('div', { class: 'card-body list sessions' }, sessions.map(s =>
      h('div', { class: 'sess' },
        h('div', { class: 'sess-top' }, h('span', { class: 'chip', text: s.source === 'codex' ? 'Codex' : 'Claude' }), h('span', { class: 'when', text: ago(s.last_at) }),
          h('button', { class: 'mini', title: 'Esta sessão não é deste projeto', onclick: async () => { await B.sessions.assign(s.source, s.session_id, null); toast('Sessão tirada deste projeto'); renderPanel(); } }, '✕')),
        h('div', { class: 'sess-title', text: s.title || s.last_prompt || '(sem título)' })))));
  }

  // Comandos e skills do motor: clicar cola no terminal ("/ATHENA:tasks:forge-blueprint "), sem Enter.
  function cardCommands(p) {
    const eng = engineFor(p);
    if (!eng) return null;
    const body = h('div', { class: 'card-body list' });
    const search = h('input', { class: 'aurora-input sm full', placeholder: 'buscar comando ou skill…' });
    const out = h('div', { class: 'cmd-list' });
    body.append(search, out);
    let all = [];
    const paint = () => {
      const qv = search.value.trim().toLowerCase();
      clear(out);
      const list = all.filter(c => !qv || c.name.toLowerCase().includes(qv) || (c.description || '').toLowerCase().includes(qv)).slice(0, qv ? 30 : 12);
      for (const c of list) out.appendChild(h('button', { class: 'cmd', title: c.description || '', onclick: () => pasteToTerminal(c.kind === 'skill' ? `use a skill ${c.name}: ` : c.name + ' ') },
        h('span', { class: `cmd-name ${c.kind}`, text: c.name }), h('span', { class: 'cmd-desc', text: (c.description || '').slice(0, 90) })));
      if (!list.length) out.appendChild(h('div', { class: 'muted small', text: 'Nada encontrado.' }));
    };
    search.addEventListener('input', paint);
    if (!S.collapsed.commands) {
      B.engines.details(eng.id).then(d => {
        all = [...(d.commands || []).map(c => ({ ...c, kind: 'cmd' })), ...(d.skills || []).map(s => ({ ...s, kind: 'skill' }))];
        paint();
      }).catch(e => { out.textContent = e.message; });
    }
    return card('commands', `Comandos do motor · ${eng.name}`, [h('button', { class: 'mini', title: 'Ver todos', onclick: () => commandsModal(p) }, '⤢')], body);
  }

  function commandsModal(p) {
    const eng = engineFor(p); if (!eng) return;
    modal((c, close) => {
      c.classList.add('wide');
      const st = eng.status || {};
      const search = h('input', { class: 'aurora-input', placeholder: 'buscar…', autofocus: true });
      const list = h('div', { class: 'cmd-list tall' });
      c.append(h('h2', { text: `Motor: ${eng.name}${st.version ? ' ' + st.version : ''}` }),
        h('p', { class: 'muted small', text: `${eng.path} · ${st.ok ? `${st.commands} comandos · ${st.skills} skills · verificado ${ago(st.checked_at)}${st.updated_at ? ` · atualizado ${ago(st.updated_at)}` : ''}` : (st.error || 'não verificado')}` }),
        search, list, h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Fechar')));
      let all = [];
      const paint = () => {
        const qv = search.value.trim().toLowerCase(); clear(list);
        for (const x of all.filter(v => !qv || v.name.toLowerCase().includes(qv) || (v.description || '').toLowerCase().includes(qv))) {
          list.appendChild(h('button', { class: 'cmd', title: x.description || '', onclick: async () => { if (await pasteToTerminal(x.kind === 'skill' ? `use a skill ${x.name}: ` : x.name + ' ')) close(); } },
            h('span', { class: `cmd-name ${x.kind}`, text: x.name }), h('span', { class: 'cmd-desc', text: (x.description || '').slice(0, 160) })));
        }
      };
      search.addEventListener('input', paint);
      B.engines.details(eng.id).then(d => { all = [...((d && d.commands) || []).map(v => ({ ...v, kind: 'cmd' })), ...((d && d.skills) || []).map(v => ({ ...v, kind: 'skill' }))]; paint(); }).catch(() => {});
    });
  }

  function promptRow(it) {
    const el = h('div', { class: 'item prompt', dataset: { id: it.id } },
      h('div', { class: 'item-text', text: it.text }),
      h('div', { class: 'item-actions' },
        h('button', { class: 'mini neon', title: 'Colar no terminal ativo (você confere e aperta Enter)', onclick: async () => {
          if (await pasteToTerminal(it.text)) { await B.items.update(it.id, { state: 'sent' }); renderPanel(); }
        } }, '⚡ enviar'),
        h('button', { class: 'mini', title: 'Copiar', onclick: () => { navigator.clipboard.writeText(it.text); toast('Copiado'); } }, '⧉'),
        h('button', { class: 'mini', title: 'Arquivar', onclick: async () => { await B.items.update(it.id, { state: 'archived' }); renderPanel(); } }, '✕')));
    draggable(el, { kind: 'item', id: it.id, text: it.text });
    return el;
  }

  function noteRow(it) {
    const txt = h('div', { class: 'item-text', text: it.text });
    editable(txt, it.text, async (val) => { if (val) await B.items.update(it.id, { text: val }); renderPanel(); });
    const el = h('div', { class: `item t-${it.type}`, dataset: { id: it.id } },
      h('span', { class: 'type-dot', title: TYPE_LABEL[it.type] }), txt,
      h('div', { class: 'item-actions' },
        it.remind_at ? h('span', { class: 'when', text: new Date(it.remind_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) }) : null,
        h('button', { class: 'mini', title: 'Virar prompt', onclick: async () => { await B.items.update(it.id, { type: 'prompt' }); renderPanel(); } }, '↑⚡'),
        h('button', { class: 'mini', title: 'Pôr no Hoje', onclick: () => addItemToToday(it.id) }, '☀︎'),
        h('button', { class: 'mini', title: 'Arquivar', onclick: async () => { await B.items.update(it.id, { state: 'archived' }); renderPanel(); } }, '✕')));
    draggable(el, { kind: 'item', id: it.id, text: it.text });
    return el;
  }

  function addBox(projectId, type, placeholder) {
    const ta = h('textarea', { class: 'aurora-input add', rows: 1, placeholder });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
    ta.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault();
        const text = ta.value.trim(); if (!text) return;
        await B.items.create({ project_id: projectId, text, type }); ta.value = '';
        if (S.view === 'inbox') renderInbox(); else renderPanel();
        renderSide();
      }
    });
    return ta;
  }

  async function stepDone(p) {
    await B.items.create({ project_id: p.id, text: p.next_step, type: 'step' }).then(it => B.items.update(it.id, { state: 'done' }));
    await B.projects.update(p.id, { next_step: null });
    await loadProjects(); renderPanel(); renderSide();
    toast('Feito. Qual é o próximo passo?');
    const ns = document.querySelector('#panel .next'); if (ns) ns.click();
  }

  async function addStepToToday(p) {
    const it = await B.items.create({ project_id: p.id, text: p.next_step, type: 'step' });
    await addItemToToday(it.id);
  }

  async function addItemToToday(id) {
    const cur = await B.items.today(today());
    if (cur.some(i => i.id === id)) { toast('Já está no Hoje'); return; }
    if (cur.filter(i => i.state !== 'done').length >= 3) { toast('O Hoje já tem 3 coisas. Tire uma para pôr esta.'); return; }
    await B.today.set([...cur.map(i => i.id), id]);
    toast('No Hoje ☀︎'); renderSide(); if (S.view === 'today') renderToday();
  }

  // ---------------- foco / estante (D11) ----------------
  async function bringToFocus(p) {
    try { await B.projects.update(p.id, { status: 'focus' }); await loadProjects(); go('project', p.id); }
    catch (e) {
      if (errCode(e) !== 'FOCUS_FULL') { toast(e.message); return; }
      modal((c, close) => {
        c.append(h('h2', { text: `Já tem ${S.settings.focus_limit || 3} projetos em foco` }),
          h('p', { class: 'muted', text: `Para trazer ${p.name}, estacione um. O "onde parei" dele fica guardado.` }),
          h('div', { class: 'park-list' }, focusProjects().map(f => h('button', { class: 'park-opt', onclick: async () => { await B.projects.swapFocus(f.id, p.id); close(); await loadProjects(); go('project', p.id); } },
            h('strong', { text: f.name }), h('span', { class: 'muted', text: f.where_stopped ? f.where_stopped.slice(0, 120) : 'sem registro' }),
            f.last_touched_at ? h('span', { class: 'when', text: `mexido ${ago(f.last_touched_at)}` }) : null))),
          h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Deixar como está')));
      });
    }
  }

  async function park(p) {
    modal((c, close) => {
      const ws = h('textarea', { class: 'aurora-input', rows: 3 }); ws.value = p.where_stopped || '';
      const ns = h('input', { class: 'aurora-input', placeholder: 'Quando voltar, o primeiro passo é…' }); ns.value = p.next_step || '';
      c.append(h('h2', { text: `Estacionar ${p.name}` }), h('p', { class: 'muted', text: 'Confira o registro antes de guardar. Os terminais continuam abertos até você fechar.' }),
        field('Onde parei', ws), field('Ao voltar, o primeiro passo', ns),
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar'),
          h('button', { class: 'aurora-btn aurora-btn--primary', onclick: async () => {
            const patch = { status: 'shelf' };
            if (ws.value.trim() !== (p.where_stopped || '')) patch.where_stopped = ws.value.trim() || null;
            if (ns.value.trim() !== (p.next_step || '')) patch.next_step = ns.value.trim() || null;
            await B.projects.update(p.id, patch); close(); await loadProjects(); renderSide(); renderHead();
          } }, 'Estacionar')));
    });
  }

  // ---------------- Hoje (D12) ----------------
  async function renderToday() {
    const v = clear($('#view-today'));
    const s = await B.today.suggest();
    const chosen = s.chosen;
    const wrap = h('div', { class: 'today' });
    wrap.appendChild(h('p', { class: 'lead', text: chosen.length ? 'Suas coisas de hoje. Só isso. (arraste para mudar a ordem)' : 'Escolha até 3 coisas para hoje. O resto espera, sem problema.' }));
    const slots = h('div', { class: 'slots' });
    for (let i = 0; i < 3; i++) {
      const it = chosen[i];
      if (it) {
        const done = it.state === 'done';
        const el = h('div', { class: `slot aurora-glass ${done ? 'done' : ''}`, dataset: { id: it.id } },
          h('button', { class: `check ${done ? 'on' : ''}`, title: done ? 'Desfazer' : 'Feito', onclick: async () => { await B.items.update(it.id, { state: done ? 'active' : 'done' }); renderToday(); renderSide(); } }, done ? '✓' : ''),
          h('div', { class: 'slot-body' }, h('div', { class: 'slot-text', text: it.text }), h('button', { class: 'slot-proj', text: it.project_name, onclick: () => go('project', it.project_id) })),
          h('button', { class: 'mini', title: 'Tirar do Hoje (volta para o projeto)', onclick: async () => { await B.today.set(chosen.filter(x => x.id !== it.id).map(x => x.id)); renderToday(); renderSide(); } }, '✕'));
        draggable(el, { kind: 'today', id: it.id, text: it.text });
        slots.appendChild(el);
      } else slots.appendChild(h('div', { class: 'slot empty-slot', text: `${i + 1}` }));
    }
    sortable(slots, { accepts: (d) => d.kind === 'today', itemSelector: '.slot[data-id]', onDrop: async (ids) => { await B.today.set(ids).catch(e => toast(e.message)); renderToday(); } });
    dropTarget(slots, { accepts: (d) => d.kind === 'item', onDrop: (d) => addItemToToday(d.id) });
    wrap.appendChild(slots);
    const free = 3 - chosen.length;
    const sugg = s.suggestions.filter(x => !chosen.some(c => c.text === x.text));
    if (free > 0 && sugg.length) {
      wrap.appendChild(h('h3', { text: 'Sugestões dos seus projetos em foco' }));
      wrap.appendChild(h('div', { class: 'sugg' }, sugg.map(x => h('button', { class: 'sugg-item aurora-glass', onclick: async () => {
        let id = x.item_id;
        if (!id) id = (await B.items.create({ project_id: x.project_id, text: x.text, type: 'step' })).id;
        await B.today.set([...chosen.map(c => c.id), id]); renderToday(); renderSide();
      } }, h('span', { class: 'plus', text: '+' }), h('span', { text: x.text }), h('span', { class: 'chip', text: x.project_name })))));
    } else if (free > 0 && !chosen.length) {
      wrap.appendChild(h('p', { class: 'muted', text: 'Nenhum projeto em foco tem próximo passo ainda. Abra um projeto e escreva o próximo passo no painel.' }));
    }
    v.appendChild(wrap);
  }

  // ---------------- Inbox ----------------
  async function renderInbox() {
    const v = clear($('#view-inbox'));
    const items = await B.items.list('inbox');
    const wrap = h('div', { class: 'inbox' });
    wrap.appendChild(h('p', { class: 'lead', text: items.length ? 'O que você anotou sem projeto. Arraste cada um para um projeto da barra lateral, quando der.' : 'Inbox vazia. ⌥Space anota de qualquer lugar.' }));
    wrap.appendChild(addBox('inbox', 'note', 'Anotar… (⌘↩)'));
    const list = h('div', { class: 'item-list' });
    for (const it of items) {
      const sel = h('select', { class: 'aurora-input sm', title: 'Mover para projeto' }, h('option', { value: '', text: 'mover para…' }),
        S.projects.filter(p => !p.system).map(p => h('option', { value: p.id, text: p.name })));
      sel.addEventListener('change', () => { if (sel.value) moveItem(it.id, sel.value); });
      const type = h('select', { class: 'aurora-input sm' }, ['note', 'idea', 'prompt', 'reminder'].map(t => h('option', { value: t, text: TYPE_LABEL[t], selected: it.type === t })));
      type.addEventListener('change', async () => { await B.items.update(it.id, { type: type.value }); renderInbox(); });
      const txt = h('div', { class: 'item-text', text: it.text });
      editable(txt, it.text, async (val) => { if (val) await B.items.update(it.id, { text: val }); renderInbox(); });
      const el = h('div', { class: `item big t-${it.type}`, dataset: { id: it.id } }, h('span', { class: 'type-dot' }), txt,
        h('div', { class: 'item-actions' }, h('span', { class: 'when', text: ago(it.created_at) }), type, sel,
          h('button', { class: 'mini', title: 'Pôr no Hoje', onclick: () => addItemToToday(it.id) }, '☀︎'),
          h('button', { class: 'mini', title: 'Arquivar', onclick: async () => { await B.items.update(it.id, { state: 'archived' }); renderInbox(); renderSide(); } }, '✕')));
      draggable(el, { kind: 'item', id: it.id, text: it.text });
      list.appendChild(el);
    }
    sortable(list, { accepts: (d) => d.kind === 'item' && items.some(i => i.id === d.id), itemSelector: '.item[data-id]', onDrop: async (ids) => { await B.items.reorder(ids); renderInbox(); } });
    wrap.appendChild(list);
    v.appendChild(wrap);
  }

  // ---------------- modais ----------------
  function field(label, input) { return h('label', { class: 'field' }, h('span', { text: label }), input); }

  function engineSelect(current) {
    const def = defaultEngine();
    return h('select', { class: 'aurora-input' },
      h('option', { value: '', text: def ? `Padrão (${def.name})` : 'Padrão (nenhum configurado)', selected: !current }),
      S.engines.map(e => h('option', { value: e.id, text: e.name, selected: current === e.id })),
      h('option', { value: 'none', text: 'Nenhum: terminais na pasta do projeto', selected: current === 'none' }));
  }

  function newProjectModal() {
    modal((c, close) => {
      const name = h('input', { class: 'aurora-input', placeholder: 'Nome do projeto', autofocus: true });
      const kind = h('select', { class: 'aurora-input' }, Object.entries(KIND_LABEL).map(([k, l]) => h('option', { value: k, text: l })));
      const dir = h('input', { class: 'aurora-input', placeholder: 'Pasta (opcional para live/música)' });
      const eng = engineSelect(null);
      const pick = h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: async () => { const d = await B.app.pickFolder(); if (d) { dir.value = d; if (!name.value) name.value = d.split('/').pop(); } } }, 'Escolher…');
      const ok = async () => {
        try {
          const p = await B.projects.create({ name: name.value, kind: kind.value, paths: dir.value.trim() ? [dir.value.trim()] : [] });
          if (eng.value) await B.projects.update(p.id, { engine_id: eng.value });
          close(); await loadProjects(); go('project', p.id);
        } catch (e) { toast(e.message); }
      };
      c.append(h('h2', { text: 'Novo projeto' }), field('Nome', name), field('Tipo', kind), field('Pasta do projeto', h('div', { class: 'row' }, dir, pick)), field('Motor', eng),
        h('p', { class: 'muted small', text: 'Entra na estante. Arraste para "Em foco" quando for trabalhar nele.' }),
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar'), h('button', { class: 'aurora-btn aurora-btn--primary', onclick: ok }, 'Criar')));
    });
  }

  function projectSettingsModal(p) {
    modal((c, close) => {
      const name = h('input', { class: 'aurora-input', value: p.name });
      const kind = h('select', { class: 'aurora-input' }, Object.entries(KIND_LABEL).map(([k, l]) => h('option', { value: k, text: l, selected: p.kind === k })));
      const paths = h('textarea', { class: 'aurora-input', rows: 3 }); paths.value = (p.paths || []).join('\n');
      const aliases = h('input', { class: 'aurora-input', value: (p.aliases || []).join(', '), placeholder: 'outros nomes: meuapp, meu app' });
      const eng = engineSelect(p.engine_id);
      c.append(h('h2', { text: p.name }), field('Nome', name), field('Tipo', kind), field('Motor (onde o Claude deste projeto roda)', eng),
        field('Pastas do projeto (uma por linha)', paths), field('Apelidos (ajudam a achar as sessões e o #tag do ⌥Space)', aliases),
        h('div', { class: 'row between' },
          h('button', { class: 'aurora-btn aurora-btn--text danger', onclick: async () => { if (!confirm(`Apagar ${p.name}? As notas somem da lista.`)) return; await B.projects.update(p.id, { deleted: true }); close(); await loadProjects(); go(focusProjects()[0] ? 'project' : 'today', focusProjects()[0] && focusProjects()[0].id); } }, 'Apagar projeto'),
          h('div', { class: 'row' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar'),
            h('button', { class: 'aurora-btn aurora-btn--primary', onclick: async () => {
              try {
                await B.projects.update(p.id, { name: name.value, kind: kind.value, engine_id: eng.value || null, paths: paths.value.split('\n').map(s => s.trim()).filter(Boolean), aliases: aliases.value.split(',').map(s => s.trim()).filter(Boolean) });
                close(); await loadProjects(); renderSide(); renderHead(); renderPanel();
              } catch (e) { toast(e.message); }
            } }, 'Salvar'))));
    });
  }

  // Seção "Motores" dos Ajustes: escolher a pasta-cérebro (ex.: athena-os), ver se está ok, trocar o padrão.
  function enginesSection(onChange) {
    const box = h('div', { class: 'engines' });
    const paint = async () => {
      S.engines = await B.engines.check();      // verifica de novo cada pasta
      const sugg = await B.engines.suggest().catch(() => []);
      clear(box);
      if (!S.engines.length) box.appendChild(h('p', { class: 'muted small', text: 'Nenhum motor. Sem motor, os terminais abrem na pasta de cada projeto.' }));
      for (const e of S.engines) {
        const st = e.status || {};
        box.appendChild(h('div', { class: `engine-row ${st.ok ? '' : 'bad'}` },
          h('input', { type: 'radio', name: 'eng-default', checked: e.is_default, title: 'Motor padrão', onchange: async () => { await B.engines.setDefault(e.id); paint(); onChange(); } }),
          h('div', { class: 'engine-info' },
            h('div', { class: 'row' }, h('strong', { text: e.name }), st.version ? h('span', { class: 'chip', text: st.version }) : null, e.is_default ? h('span', { class: 'chip neon', text: 'padrão' }) : null),
            h('div', { class: 'muted small', text: e.path.replace(/^\/Users\/[^/]+/, '~') }),
            h('div', { class: `small ${st.ok ? 'ok-text' : 'danger'}`, text: st.ok ? `✓ ${st.commands} comandos · ${st.skills} skills · verificado ${ago(st.checked_at)}${st.updated_at ? ` · atualizado ${ago(st.updated_at)}` : ''}` : `✕ ${st.error || 'com problema'}` }),
            ...(st.warnings || []).map(w => h('div', { class: 'small amber-text', text: w }))),
          h('button', { class: 'mini', title: 'Remover motor', onclick: async () => { if (!confirm(`Remover o motor ${e.name}? A pasta não é apagada.`)) return; await B.engines.remove(e.id); paint(); onChange(); } }, '✕')));
      }
      const add = async (p, n) => { try { await B.engines.add({ path: p, name: n }); paint(); onChange(); } catch (er) { toast(er.message); } };
      box.appendChild(h('div', { class: 'row wrap' },
        h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: async () => { const d = await B.app.pickFolder(); if (d) add(d); } }, '+ Selecionar motor…'),
        ...sugg.map(s => h('button', { class: 'aurora-btn aurora-btn--text sm', title: s.path, onclick: () => add(s.path, s.name) }, `+ ${s.name}`))));
    };
    paint();
    return box;
  }

  // Acesso remoto: só pelo Tailscale do Mac. Liga/desliga, pareia aparelho por QR, revoga.
  function remoteSection() {
    const box = h('div', { class: 'engines' });
    const paint = async () => {
      const st = await B.remote.status(); const devs = await B.remote.devices();
      clear(box);
      box.appendChild(h('p', { class: 'muted small', text: 'Use a Bancada pelo celular ou iPad como se estivesse aqui, terminais incluídos. Só funciona pelo Tailscale (seus aparelhos); nada fica aberto no Wi-Fi. Enquanto estiver ligado, o Mac não entra em repouso.' }));
      const toggle = h('input', { type: 'checkbox', checked: st.enabled, onchange: async () => {
        const r = toggle.checked ? await B.remote.enable() : await B.remote.disable();
        if (r && r.error) toast(r.error, 6000);
        paint();
      } });
      box.appendChild(h('label', { class: 'field check' }, toggle, h('span', { text: st.running ? `Ligado em ${st.url} · ${st.clients} aparelho(s) conectado(s)` : st.enabled ? `Ligado, esperando o Tailscale${st.tailscale ? '' : ' (desligado neste Mac)'}` : 'Desligado' })));
      if (st.running) {
        const qrBox = h('div', { class: 'qr' });
        box.append(h('div', { class: 'row wrap' }, h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: async () => {
          try {
            const r = await B.remote.pairStart();
            clear(qrBox).append(h('img', { src: r.qr, alt: 'QR de pareamento', width: 200, height: 200 }),
              h('p', { class: 'muted small', text: 'Leia com a câmera do iPhone/iPad (com o Tailscale ligado nele). Vale 5 minutos e uma vez só.' }),
              h('p', { class: 'muted small mono', text: r.url.replace(/#pair=.*/, '') }));
            qrBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          } catch (e) { toast(e.message); }
        } }, 'Parear aparelho (QR)')), qrBox);
      }
      for (const d of devs) {
        box.appendChild(h('div', { class: 'engine-row' }, h('div', { class: 'engine-info' }, h('strong', { text: d.name }),
          h('div', { class: 'muted small', text: `pareado ${ago(d.created_at)}${d.last_seen ? ` · visto ${ago(d.last_seen)}` : ''}` })),
          h('button', { class: 'mini', title: 'Revogar (desconecta e exige parear de novo)', onclick: async () => { if (!confirm(`Revogar ${d.name}?`)) return; await B.remote.revoke(d.id); paint(); } }, 'revogar')));
      }
    };
    paint();
    return box;
  }

  // ---------------- Assistentes de IA (BP-2026-11-06-001) ----------------
  // Cartões de Claude, Codex e Google: instalado? versão? conectado? + Instalar / Entrar / Atualizar / Testar.
  // Tudo pelo instalador e pelo login OFICIAIS de cada empresa; a Bancada nunca vê senha.
  async function refreshAiInstalled() { try { S.aiInstalled = await B.ai.installed(); } catch {} return S.aiInstalled; }

  function aiSection({ after } = {}) {
    const box = h('div', { class: 'ai-cards' });
    const shellBox = h('div', { class: 'ai-shell' });
    const wrap = h('div', {}, box, shellBox);
    let busy = false;

    const card = (st) => {
      const icon = AI_ICON[st.id] || '•';
      const log = h('pre', { class: 'ai-log hidden' });
      const lines = [];
      lines.push(h('div', { class: `small ${st.installed ? 'ok-text' : 'muted'}`, text: st.installed ? `● instalado${st.version ? ` ${st.version}` : ''}${st.via && st.via !== 'instalador oficial' ? ` (${st.via})` : ''}` : '○ não instalado' }));
      if (st.installed) {
        lines.push(h('div', { class: `small ${st.connected ? 'ok-text' : st.connected === false ? 'amber-text' : 'muted'}`,
          text: st.connected ? `● conectado${st.account ? ` · ${st.account}` : ''}${st.accountPlan ? ` (${st.accountPlan})` : ''}` : st.connected === false ? '○ não conectado à sua conta' : '? não deu para saber se está conectado (sem internet?)' }));
      }
      if ((st.copies || []).length > 1) lines.push(h('div', { class: 'small amber-text', text: `${st.copies.length} cópias instaladas (${st.copies.map(c => c.via).join(', ')}). A Bancada usa ${st.copies[0].via === 'instalador oficial' ? 'a oficial' : 'a primeira'}: ${st.copies[0].path.replace(/^\/Users\/[^/]+/, '~')}.` }));
      const run = async (kind) => {
        if (busy) { toast('Espere a outra instalação terminar'); return; }
        busy = true; log.classList.remove('hidden'); log.textContent = '';
        const off = B.ai.onLog((m) => { if (m.tool !== st.id) return; log.textContent = (log.textContent + m.text).slice(-60000); log.scrollTop = log.scrollHeight; });
        try {
          const r = kind === 'install' ? await B.ai.install(st.id) : await B.ai.update(st.id);
          toast(r.ok ? `${st.name}: ${kind === 'install' ? 'instalado' : 'atualizado'}${r.version ? ` (${r.version})` : ''}` : `${st.name}: ${r.error || 'deu problema; veja o registro'}`, 6000);
          await refreshAiInstalled();
          if (r.ok && kind === 'install') { off(); busy = false; return aiLoginModal(st, after); }   // instalou → já oferece entrar na conta
        } catch (e) { toast(e.message, 6000); }
        off(); busy = false; paint();
      };
      const btns = window.__REMOTE ? [h('span', { class: 'muted small', text: 'Instalar e conectar só no Mac.' })] : [
        !st.installed ? h('button', { class: 'aurora-btn aurora-btn--primary sm', onclick: () => run('install') }, 'Instalar') : null,
        st.installed && st.connected !== true ? h('button', { class: 'aurora-btn aurora-btn--primary sm', onclick: () => aiLoginModal(st, after) }, 'Entrar na minha conta') : null,
        st.installed && st.connected === true ? h('button', { class: 'aurora-btn aurora-btn--text sm', title: 'Trocar de conta ou entrar de novo', onclick: () => aiLoginModal(st, after) }, 'Trocar de conta') : null,
        st.installed ? h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => run('update') }, 'Atualizar') : null,
        h('button', { class: 'aurora-btn aurora-btn--text sm', title: 'Conferir de novo instalação, versão e conta', onclick: () => paint(true) }, 'Testar'),
      ];
      return h('div', { class: `ai-card ${st.installed && st.connected ? 'on' : ''}` },
        h('div', { class: 'row' }, h('span', { class: 'ai-icon', text: icon }), h('strong', { text: st.name }), h('span', { class: 'muted small', text: st.vendor })),
        ...lines, h('div', { class: 'muted small', text: st.plan }), h('div', { class: 'row wrap' }, ...btns), log);
    };

    const paintShell = async () => {
      if (window.__REMOTE) return;
      clear(shellBox);
      let sc; try { sc = await B.ai.shellCheck(); } catch { return; }
      if (sc.ok) { shellBox.appendChild(h('p', { class: 'small ok-text', text: '✓ O Terminal do Mac (fora da Bancada) também acha as IAs.' })); return; }
      shellBox.append(
        h('p', { class: 'small muted', text: `Os terminais da Bancada acham as IAs sempre. O Terminal do Mac, fora da Bancada, ${sc.duplicates ? `tem a configuração repetida ${sc.duplicates + 1} vezes no ~/.zshrc` : sc.has_line ? 'não está achando as IAs' : 'não sabe onde as IAs ficam (falta uma linha no ~/.zshrc)'}.` }),
        h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: async () => {
          if (!confirm('Ajustar o ~/.zshrc para o Terminal do Mac achar claude, codex e agy?\n\nFaço uma cópia de segurança antes, removo linhas repetidas e acrescento só uma, se faltar. O resto do arquivo não muda.')) return;
          try { const r = await B.ai.fixShell(); toast(r.changed ? `Pronto. ${r.removed ? `${r.removed} linha(s) repetida(s) removida(s). ` : ''}${r.added ? 'Linha acrescentada. ' : ''}${r.backup ? `Cópia em ${r.backup.replace(/^\/Users\/[^/]+/, '~')}` : ''}` : 'Já estava certo.', 8000); }
          catch (e) { toast(e.message); }
          paintShell();
        } }, 'Consertar o Terminal do Mac'));
    };

    const paint = async (full) => {
      clear(box).appendChild(h('p', { class: 'muted small', text: full ? 'Conferindo de novo…' : 'Conferindo o que está instalado e conectado…' }));
      let list = [];
      try { list = await B.ai.status(); } catch (e) { clear(box).appendChild(h('p', { class: 'danger small', text: e.message })); return; }
      clear(box); for (const st of list) box.appendChild(card(st));
      if (full) paintShell();
    };
    paint(); paintShell();
    return wrap;
  }

  // Login da própria IA num terminal embutido: o navegador abre na página da empresa; código (se pedir) cola aqui.
  async function aiLoginModal(st, after) {
    if (window.__REMOTE) { toast('Conectar só no Mac'); return; }
    const id = `ai-login-${st.id}`;
    const host = h('div', { class: 'ai-login-term' });
    modal((c, close) => {
      c.classList.add('xwide');
      c.append(h('h2', { text: `Entrar no ${st.name}` }),
        h('p', { class: 'small', text: st.loginHint || 'Siga as instruções abaixo. O navegador vai abrir na página da empresa.' }),
        h('p', { class: 'muted small', text: 'Sua senha é digitada só no site oficial, nunca na Bancada.' }),
        host,
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--primary', onclick: close }, 'Pronto, fechar')));
    }, { noEscape: true, onClose: async (replaced) => { await window.Terminals.close(id).catch(() => {}); if (!replaced && after) after(); } });
    try { await window.Terminals.open({ id, projectId: 'ai', name: `login ${st.id}`, cwd: null, startup: null, container: host }); window.Terminals.focus(id); }
    catch (e) { toast(e.message); }
  }

  // Primeira abertura: quem já programa (motor + pastas) ou quem está começando (IAs + primeiro projeto)
  function welcome() {
    modal((c, close) => {
      c.classList.add('wide');
      c.append(h('h2', { text: 'Bem-vindo à Bancada' }),
        h('p', { class: 'muted small', text: 'Aqui você conversa com uma IA que programa por você, num terminal por projeto. Como você quer começar?' }),
        h('div', { class: 'park-list' },
          h('button', { class: 'park-opt', onclick: () => { close(); starterAi(); } },
            h('strong', { text: 'Estou começando' }), h('span', { class: 'muted small', text: 'Instalo e conecto a IA para você e crio uma pasta "Meu primeiro projeto". Não precisa saber terminal.' })),
          h('button', { class: 'park-opt', onclick: () => { close(); onboarding(); } },
            h('strong', { text: 'Já tenho meus projetos' }), h('span', { class: 'muted small', text: 'Escolho as pastas de projeto e, se tiver, a pasta-motor (ex.: athena-os).' }))));
    });
  }

  // Passo 1 de quem está começando: instalar/conectar pelo menos uma IA
  function starterAi() {
    modal((c, close) => {
      c.classList.add('wide');
      const next = h('button', { class: 'aurora-btn aurora-btn--primary', onclick: async () => { close(); await starterProject(); } }, 'Continuar');
      c.append(h('h2', { text: '1 de 2 · Sua IA' }),
        h('p', { class: 'small', text: 'Escolha a IA que você assina: clique em Instalar e depois em Entrar na minha conta. Basta uma.' }),
        aiSection({ after: starterAi }),
        h('div', { class: 'row between' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: () => { close(); welcome(); } }, 'Voltar'), next));
    });
  }

  // Passo 2: cria "Meu primeiro projeto" e abre o terminal com a IA conectada
  async function starterProject() {
    let list = []; try { list = await B.ai.status(); } catch {}
    const ready = list.find(x => x.installed && x.connected) || list.find(x => x.installed);
    if (!ready) { toast('Instale pelo menos uma IA primeiro', 5000); return starterAi(); }
    const tok = { claude: 'bancada:claude', codex: 'bancada:codex', google: 'bancada:agy' }[ready.id];
    let p;
    try { p = await B.ai.firstProject(); } catch (e) { toast(e.message); return; }
    await B.settings.set({ onboarded: true }); S.settings = await B.settings.get();
    await Promise.all([loadProjects(), loadEngines(), refreshAiInstalled()]);
    const existing = await B.terminals.list(p.id).catch(() => []);
    if (!existing.some(t => t.startup === tok)) {
      const t = { id: newId(), project_id: p.id, name: ready.id === 'google' ? 'google' : ready.id, cwd: null, startup: tok, skip_perms: false };
      await B.terminals.save(t).catch(e => toast(e.message));
    }
    delete S.layout[p.id];
    go('project', p.id);
    modal((c, close) => {
      c.append(h('h2', { text: '2 de 2 · Pronto!' }),
        h('p', { class: 'small', text: `A pasta "Meu primeiro projeto" está em Documentos › Bancada, e o ${ready.name} já está aberto nela.` }),
        h('p', { class: 'small amber-text', text: ready.id === 'claude'
          ? 'Na primeira vez ele pergunta, em inglês, se você confia na pasta. Aperte a seta ↓ para "Yes, I trust this folder" e depois Enter. (Só Enter direto fecha o Claude; se acontecer, aperte Enter de novo para reabrir.)'
          : 'Na primeira vez ele pergunta, em inglês, se você confia na pasta. A opção "Trust and continue" já vem marcada: é só apertar Enter.' }),
        h('p', { class: 'small', text: 'Depois, escreva no terminal o que você quer, em português, e aperte Enter. Por exemplo: "crie uma página com um relógio grande e me mostre como abrir".' }),
        h('p', { class: 'muted small', text: 'A bolinha na aba mostra o estado: roxa trabalhando, âmbar esperando você, verde terminou.' }),
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--primary', onclick: close }, 'Começar')));
    });
  }

  async function settingsModal() {
    const st = await B.settings.get(); const ai = await B.summary.status();
    modal((c, close) => {
      c.classList.add('wide');
      const hotkey = h('input', { class: 'aurora-input', value: st.hotkey });
      const morning = h('input', { class: 'aurora-input', type: 'time', value: st.morning_time });
      const limit = h('select', { class: 'aurora-input' }, [1, 2, 3, 4, 5].map(n => h('option', { value: n, text: String(n), selected: st.focus_limit === n })));
      const aiOn = h('input', { type: 'checkbox', checked: st.ai_summary });
      const skipDef = h('input', { type: 'checkbox', checked: !!st.claude_skip_default });
      const theme = h('select', { class: 'aurora-input' }, [['system', 'Igual ao Mac'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v2, l]) => h('option', { value: v2, text: l, selected: st.theme === v2 })));
      c.append(h('h2', { text: 'Ajustes' }),
        h('h3', { class: 'sec', text: 'Assistentes de IA' }),
        h('p', { class: 'muted small', text: 'Instale e conecte as IAs com um clique. Os terminais da Bancada acham cada uma sozinhos, mesmo que o Terminal do Mac dê "command not found".' }),
        aiSection({ after: settingsModal }),
        h('h3', { class: 'sec', text: 'Motores' }),
        h('p', { class: 'muted small', text: 'O motor é a pasta-cérebro (ex.: athena-os): o Claude de cada projeto abre dentro dela, com as skills e comandos dela, focado no projeto. A Bancada confere a pasta toda vez que abre e quando ela muda.' }),
        enginesSection(async () => { await loadEngines(); if (S.view === 'project') { renderHead(); renderPanel(); } }),
        window.__REMOTE ? null : h('h3', { class: 'sec', text: 'Acesso remoto (celular / iPad)' }),
        window.__REMOTE ? null : remoteSection(),
        h('h3', { class: 'sec', text: 'Geral' }),
        h('div', { class: 'grid2' }, field('Atalho de anotar', hotkey), field('Resumo da manhã', morning), field('Projetos em foco (máximo)', limit), field('Tema', theme)),
        h('label', { class: 'field check' }, skipDef, h('span', { text: 'Terminal "claude" novo abre sem permissões (--dangerously-skip-permissions) por padrão. Os dois botões na barra de abas continuam valendo.' })),
        h('label', { class: 'field check' }, aiOn, h('span', { text: `Resumo por IA do "onde parei" (Haiku pela sua assinatura). Hoje: ${ai.calls_today}/${ai.cap}${ai.claude ? '' : ' (claude não encontrado)'}${ai.last_error ? ` · último erro: ${ai.last_error}` : ''}` })),
        st.promptpad_available ? h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: async () => { const r = await B.app.importPromptPad(); toast(`PromptPad: ${r.items} itens importados, ${r.skipped} já estavam aqui`); } }, 'Importar notas do PromptPad') : null,
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Cancelar'),
          h('button', { class: 'aurora-btn aurora-btn--primary', onclick: async () => {
            try { await B.settings.set({ hotkey: hotkey.value.trim(), morning_time: morning.value, focus_limit: Number(limit.value), ai_summary: aiOn.checked, theme: theme.value, claude_skip_default: skipDef.checked }); }
            catch (e) { toast(e.message); return; }
            S.settings = await B.settings.get(); applyTheme(S.settings.theme); close(); renderSide();
          } }, 'Salvar')));
    });
  }

  // ---------------- primeira abertura (D15 + motor) ----------------
  async function onboarding() {
    const found = await B.projects.discover();
    const sugg = await B.engines.suggest().catch(() => []);
    modal((c, close) => {
      const picked = new Map();
      const list = h('div', { class: 'onb-list' });
      const counter = h('span', { class: 'muted' });
      const refresh = () => { const f = [...picked.values()].filter(x => x === 'focus').length; counter.textContent = `${picked.size} escolhido(s) · ${f}/3 em foco`; };
      for (const d of found.filter(x => !x.registered)) {
        const row = h('div', { class: 'onb-row' });
        const cb = h('input', { type: 'checkbox' });
        const star = h('button', { class: 'mini', title: 'Em foco (até 3)' }, '☆');
        cb.addEventListener('change', () => { if (cb.checked) picked.set(d.path, 'shelf'); else { picked.delete(d.path); star.textContent = '☆'; } refresh(); });
        star.addEventListener('click', () => {
          const cur = picked.get(d.path);
          if (cur === 'focus') { picked.set(d.path, 'shelf'); star.textContent = '☆'; }
          else {
            if ([...picked.values()].filter(x => x === 'focus').length >= 3) { toast('Até 3 em foco'); return; }
            cb.checked = true; picked.set(d.path, 'focus'); star.textContent = '★';
          }
          refresh();
        });
        row.append(cb, h('span', { class: 'onb-name', text: d.name }), h('span', { class: 'chip', text: d.category }), h('span', { class: 'when', text: ago(d.mtime) }), star);
        list.appendChild(row);
      }
      refresh();
      // motor: sugere as pastas com .claude/ (ex.: uma pasta com CLAUDE.md); a primeira vem marcada
      const pre = sugg.findIndex(s => /athena/i.test(s.name));
      const engSel = h('select', { class: 'aurora-input' },
        sugg.map((s, i) => h('option', { value: s.path, text: `${s.name} — ${s.path.replace(/^\/Users\/[^/]+/, '~')}`, selected: i === (pre >= 0 ? pre : 0) })),
        h('option', { value: '', text: 'Nenhum (terminais na pasta de cada projeto)' }), h('option', { value: '__pick', text: 'Outra pasta…' }));
      engSel.addEventListener('change', async () => {
        if (engSel.value !== '__pick') return;
        const d = await B.app.pickFolder();
        if (d) { engSel.insertBefore(h('option', { value: d, text: d.replace(/^\/Users\/[^/]+/, '~') }), engSel.firstChild); engSel.value = d; } else engSel.value = '';
      });
      const st_pp = h('input', { type: 'checkbox', checked: true });
      const ok = async () => {
        if (engSel.value && engSel.value !== '__pick') { try { await B.engines.add({ path: engSel.value }); } catch (e) { toast(e.message); } }
        for (const d of found) {
          if (!picked.has(d.path)) continue;
          try { await B.projects.create({ name: d.name, kind: d.kind, paths: [d.path], status: picked.get(d.path) }); } catch (e) { toast(`${d.name}: ${e.message}`); }
        }
        if (st_pp.checked) { try { const r = await B.app.importPromptPad(); toast(`PromptPad: ${r.items} itens importados`); } catch (e) { toast(e.message); } }
        await B.settings.set({ onboarded: true });
        S.settings = await B.settings.get();
        close(); await Promise.all([loadProjects(), loadEngines()]);
        const f = focusProjects()[0]; go(f ? 'project' : 'today', f && f.id);
      };
      c.classList.add('wide');
      c.append(h('h2', { text: 'Bem-vindo à Bancada' }),
        field('1. Motor: a pasta-cérebro onde o Claude de cada projeto vai rodar', engSel),
        h('p', { class: 'muted small', text: 'É o jeito que você já trabalha: abre a athena e manda no projeto. Dá para trocar ou ter vários motores nos Ajustes.' }),
        h('div', { class: 'field' }, h('span', { text: '2. Projetos: marque os que entram e dê ★ em até 3 que estão em foco agora' })),
        list,
        h('label', { class: 'field check' }, st_pp, h('span', { text: 'Trazer as notas do PromptPad' })),
        h('p', { class: 'muted small', text: 'As IAs (Claude, Codex, Google) se instalam e conectam em Ajustes → Assistentes de IA.' }),
        h('div', { class: 'row between' }, counter, h('button', { class: 'aurora-btn aurora-btn--primary', onclick: ok }, 'Começar')));
    });
  }

  window.App = { onTerminalsChanged: () => { renderTabs(); renderSide(); } };
  boot().catch(e => { console.error(e); toast('Erro ao abrir: ' + e.message, 8000); });
})();
