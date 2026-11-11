// Atividade em tempo real (v0.5): a faixa em cada painel de terminal e o Escritório (sala com os agentes trabalhando).
// Dados: activity:changed do processo principal (app/main/activity.js). Aqui só se desenha.
// Memória e CPU: um relógio de 1 s só enquanto alguma faixa está à vista; a sala desenha a ~24 quadros/s só com a aba do
// Escritório aberta e a janela visível, e para sozinha quando não há nada à vista. Atores com teto (MAX_ACTORS).
'use strict';
(function () {
  const { h } = window.UI;
  const B = window.bancada;
  const act = {};                  // termId -> snapshot
  const rate = new Map();          // task id -> { t0, p0 } (para estimar pelo andamento)
  let opts = { termInfo: () => null, terms: () => [], goTerm: () => {}, onChange: () => {} };
  let clock = null;

  function init(o) {
    opts = { ...opts, ...o };
    if (!B.activity) return;
    B.activity.onChanged(({ id, activity }) => {
      if (activity) act[id] = activity; else delete act[id];
      for (const k of rate.keys()) if (!Object.values(act).some(a => a.tasks.some(t => t.id === k))) rate.delete(k);
      paintStrips(); opts.onChange(id); Office.sync();
    });
    B.activity.list().then((l) => { Object.assign(act, l || {}); paintStrips(); Office.sync(); }).catch(() => {});
  }

  // ---------------- tempo ----------------
  function dur(ms) {
    ms = Math.max(0, ms); const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  }
  const approx = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'menos de 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };

  // Quanto falta: pelo andamento (% ou N/M na saída) quando há; senão, pela mediana das vezes anteriores.
  function eta(item, now) {
    const el = now - item.since;
    if (item.pct != null && item.pct > 0) {
      let r = rate.get(item.id);
      if (!r || item.pct < r.p0) { r = { t0: now, p0: item.pct }; rate.set(item.id, r); }
      const dp = item.pct - r.p0; const dt = now - r.t0;
      if (dp > 0.5 && dt > 8000) { const left = ((100 - item.pct) / dp) * dt; return { text: `faltam ~${approx(left)}`, how: `pelo andamento (${item.pct}%)` }; }
      if (item.pct >= 3) { const left = (el / item.pct) * (100 - item.pct); return { text: `faltam ~${approx(left)}`, how: `pelo andamento (${item.pct}%)` }; }
    }
    if (item.typical) {
      const left = item.typical.ms - el;
      if (left > 15000) return { text: `faltam ~${approx(left)}`, how: `costuma levar ${approx(item.typical.ms)} (média de ${item.typical.n} vezes)` };
      if (left > -15000) return { text: 'deve acabar já', how: `costuma levar ${approx(item.typical.ms)}` };
      return { text: `passou do normal (${approx(item.typical.ms)})`, how: `costuma levar ${approx(item.typical.ms)} (${item.typical.n} vezes)`, late: true };
    }
    return null;
  }

  // ---------------- faixa no painel ----------------
  function rows(a, now) {
    const out = [];
    // chamar um agente já aparece na linha dos agentes (não repete como ferramenta)
    const doing = a.agents.some(x => !x.done) ? a.doing.filter(d => d.name !== 'Agent' && d.name !== 'Task') : a.doing;
    for (const d of doing) out.push({ ic: '⚙', label: d.verb, what: d.what, since: d.since, eta: eta(d, now), kind: 'doing' });
    for (const t of a.tasks) {
      const quiet = t.lastSignalAt ? now - t.lastSignalAt : null;
      out.push({ ic: t.kind === 'monitor' ? '👁' : '⏳', label: t.kind === 'monitor' ? 'Vigiando' : 'Em segundo plano', what: t.what, since: t.since, line: t.line,
        eta: eta(t, now), quiet: quiet != null && quiet > 120000 ? quiet : null, kind: 'task' });
    }
    const live = a.agents.filter(x => !x.done);
    if (live.length) out.push({ ic: '🤖', label: live.length === 1 ? '1 agente' : `${live.length} agentes`, agents: live, since: Math.min(...live.map(x => x.since)), kind: 'agents' });
    return out;
  }

  function strip(termId) {
    const a = act[termId]; if (!a) return null;
    const now = Date.now(); const list = rows(a, now);
    if (!list.length && !a.stalled) return null;
    const el = h('div', { class: `act-strip ${a.stalled ? 'stalled' : ''}`, title: 'Clique para abrir o Escritório', onmousedown: (e) => e.stopPropagation(), onclick: () => opts.openOffice && opts.openOffice() });
    for (const r of list.slice(0, 3)) {
      const parts = [h('span', { class: 'act-ic', text: r.ic }), h('b', { text: r.label })];
      if (r.what) parts.push(h('span', { class: 'act-what', text: r.what }));
      if (r.agents) parts.push(h('span', { class: 'act-what', text: r.agents.map(x => `${x.type}${x.last ? ` (${x.last.verb.toLowerCase()})` : ''}`).join(' · ') }));
      parts.push(h('span', { class: 'act-time', dataset: { since: String(r.since) }, text: dur(now - r.since) }));
      if (r.line) parts.push(h('span', { class: 'act-line', title: 'Última linha da saída', text: `“${r.line}”` }));
      if (r.eta) parts.push(h('span', { class: `act-eta ${r.eta.late ? 'late' : ''}`, title: r.eta.how, text: r.eta.text }));
      if (r.quiet) parts.push(h('span', { class: 'act-quiet', text: `sem saída há ${approx(r.quiet)}` }));
      el.appendChild(h('div', { class: 'act-row' }, parts));
    }
    if (list.length > 3) el.appendChild(h('div', { class: 'act-row muted', text: `+${list.length - 3}` }));
    if (a.stalled) el.appendChild(h('div', { class: 'act-row act-stall', text: `⚠ Nenhum sinal há ${approx(now - a.lastSignalAt)}: pode ter travado (Esc no terminal interrompe).` }));
    return el;
  }

  function paintStrips() {
    let any = false;
    for (const pane of document.querySelectorAll('#terms .pane')) {
      const old = pane.querySelector(':scope > .act-strip');
      const el = strip(pane.dataset.id);
      if (el) any = true;
      if (old && el) old.replaceWith(el); else if (el) { const head = pane.querySelector(':scope > .pane-head'); if (head) head.after(el); else pane.prepend(el); } else if (old) old.remove();
    }
    if (any && !clock) clock = setInterval(tickClock, 1000);
    if (!any && clock) { clearInterval(clock); clock = null; }
  }
  // só os relógios mudam a cada segundo; o resto se redesenha a cada 15 s (estimativas e "sem sinal")
  let ticks = 0;
  function tickClock() {
    if (document.hidden) return;
    if (++ticks % 15 === 0) return paintStrips();
    const now = Date.now();
    for (const s of document.querySelectorAll('.act-strip .act-time')) s.textContent = dur(now - Number(s.dataset.since));
  }

  // ======================= Escritório =======================
  // Sala isométrica desenhada por código (sem imagens): mesas com monitor, sofá e café para quem está parado, máquinas
  // para as tarefas em segundo plano, porta por onde os agentes entram e saem. Cada Claude é um bonequinho; os agentes que
  // ele chama entram pela porta, sentam numa mesa livre e saem quando terminam. Se ninguém está trabalhando, a sala esvazia.
  const Office = (() => {
    const TW = 44, TH = 22, GW = 12, GH = 9;            // tamanho do ladrilho e da sala (em ladrilhos)
    const MAX_ACTORS = 48;
    const DESKS = [];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) DESKS.push({ x: 1.6 + c * 2.1, y: 1.4 + r * 3.0 });
    const SOFA = [{ x: 9.6, y: 7.6 }, { x: 10.4, y: 7.6 }, { x: 11.1, y: 7.6 }, { x: 9.6, y: 8.3 }];
    const DOOR = { x: 0.4, y: 7.8 };
    const MACHINES = [{ x: 11.2, y: 1.2 }, { x: 11.2, y: 2.8 }, { x: 11.2, y: 4.4 }];
    const COLORS = ['#7c5cff', '#2bb3a3', '#e0803a', '#d0508a', '#4a8ee0', '#9bbf3a', '#c9a227', '#8a6be0'];
    const AGENT_COLORS = { 'general-purpose': '#8fa3b8', Explore: '#47b0d8', Plan: '#d8a447', executor: '#5fbf7a', reviewer: '#c76bd8', researcher: '#d86b6b' };

    let host = null, canvas = null, ctx = null, raf = 0, lastFrame = 0, lastLegend = 0, scope = 'project', big = null;
    const actors = new Map();   // id -> ator
    let deskOf = new Map();     // actor id -> índice da mesa
    let hover = null;
    let placed = [];

    function mount(container) {
      host = container;
      const bar = h('div', { class: 'office-bar' },
        h('div', { class: 'panel-seg mini' },
          h('button', { class: `seg-btn ${scope === 'project' ? 'on' : ''}`, onclick: () => { scope = 'project'; mount(host); } }, 'Este projeto'),
          h('button', { class: `seg-btn ${scope === 'all' ? 'on' : ''}`, onclick: () => { scope = 'all'; mount(host); } }, 'Todos')),
        h('span', { class: 'grow' }),
        h('button', { class: 'office-big', title: big ? 'Voltar ao painel' : 'Abrir grande', onclick: toggleBig }, big ? '✕' : '⤢'));
      canvas = h('canvas', { class: 'office-canvas' });
      const legend = h('div', { class: 'office-legend', id: 'office-legend' });
      while (host.firstChild) host.removeChild(host.firstChild);
      host.append(bar, canvas, legend);
      ctx = canvas.getContext('2d');
      canvas.addEventListener('mousemove', (e) => { hover = pick(e); canvas.style.cursor = hover ? 'pointer' : 'default'; });
      canvas.addEventListener('mouseleave', () => { hover = null; });
      canvas.addEventListener('click', (e) => { const a = pick(e); if (a && a.termId) { const info = opts.termInfo(a.termId); if (info) opts.goTerm(info.projectId, a.termId); if (big) toggleBig(); } });
      sync(); start();
    }

    function toggleBig() {
      if (big) { big.remove(); big = null; const p = document.querySelector('#panel .office-host'); if (p) mount(p); else { stop(); host = null; } return; }
      big = h('div', { class: 'office-overlay' }, h('div', { class: 'office-overlay-box' }));
      big.addEventListener('mousedown', (e) => { if (e.target === big) toggleBig(); });
      document.body.appendChild(big);
      mount(big.firstChild);
    }

    function unmount() { if (big) return; stop(); host = null; canvas = null; ctx = null; }

    // ---- quem está na sala ----
    function sync() {
      if (!host) return;
      const terms = opts.terms(scope);          // [{ id, name, projectName, projectId, state }]
      const want = new Map();
      terms.forEach((t, i) => {
        const a = act[t.id];
        const color = COLORS[i % COLORS.length];
        const st = t.state;
        const busy = st === 'working' || (a && a.doing.length);
        const mode = a && a.stalled ? 'stalled' : st === 'waiting' ? 'waiting' : busy ? 'desk' : st === 'background' || (a && a.tasks.length) ? 'machine' : 'sofa';
        const d0 = a && (a.doing.find(d => d.name !== 'Agent' && d.name !== 'Task') || a.doing[0]);
        const bubble = mode === 'waiting' ? '! esperando você' : mode === 'stalled' ? 'zzz… sem sinal' : d0 ? `${d0.verb}${d0.what ? ': ' + d0.what : ''}` : mode === 'machine' && a.tasks[0] ? `aguardando: ${a.tasks[0].what || 'tarefa'}` : null;
        want.set(t.id, { id: t.id, termId: t.id, kind: 'claude', name: `${t.projectName} · ${t.name}`, color, mode, bubble, since: d0 ? d0.since : null });
        if (a) for (const ag of a.agents) {
          want.set(`ag:${ag.id}`, { id: `ag:${ag.id}`, termId: t.id, kind: 'agent', name: ag.type, color: AGENT_COLORS[ag.type] || '#8fa3b8', mode: ag.done ? 'leave' : now() - ag.lastSignalAt > 120000 ? 'stalled' : 'desk',
            bubble: ag.done ? 'terminei' : ag.last ? `${ag.last.verb}${ag.last.what ? ': ' + ag.last.what : ''}` : ag.what, since: ag.since, what: ag.what, boss: color });
        }
      });
      // máquinas: tarefas em segundo plano (até 3 à vista)
      const tasks = [];
      for (const t of terms) { const a = act[t.id]; if (a) for (const k of a.tasks) tasks.push({ ...k, termId: t.id }); }
      machines = tasks.slice(0, MACHINES.length);
      for (const [id, a] of actors) if (!want.has(id)) { if (a.kind === 'agent' && a.mode !== 'gone') { a.mode = 'leave'; } else actors.delete(id); }
      for (const [id, w] of want) {
        if (actors.size >= MAX_ACTORS && !actors.has(id)) continue;
        let a = actors.get(id);
        if (!a) {
          const start = w.kind === 'agent' ? { ...DOOR } : { ...SOFA[actors.size % SOFA.length] };
          a = { ...w, x: start.x, y: start.y, phase: Math.random() * 6 }; actors.set(id, a);
        } else Object.assign(a, w);
      }
      // mesas: os Claudes primeiro, depois os agentes (cada um mantém a mesa que já tinha)
      const used = new Set();
      const next = new Map();
      for (const [id, d] of deskOf) { const a = actors.get(id); if (a && (a.mode === 'desk' || a.mode === 'stalled')) { next.set(id, d); used.add(d); } }
      for (const a of actors.values()) {
        if ((a.mode !== 'desk' && a.mode !== 'stalled') || next.has(a.id)) continue;
        const free = DESKS.findIndex((_, i) => !used.has(i));
        if (free < 0) { a.mode = 'stand'; continue; }
        next.set(a.id, free); used.add(free);
      }
      deskOf = next;
      legend();
      start();
    }
    let machines = [];
    const now = () => Date.now();

    function target(a, i) {
      if (a.mode === 'desk' || a.mode === 'stalled') { const d = DESKS[deskOf.get(a.id)]; return d ? { x: d.x + 0.55, y: d.y + 0.55 } : { x: 5, y: 7 }; }
      if (a.mode === 'leave') return DOOR;
      if (a.mode === 'machine') { const k = machines.findIndex(m => m.termId === a.termId); const m = MACHINES[Math.max(0, k)]; return { x: m.x - 0.9, y: m.y + 0.3 }; }
      if (a.mode === 'waiting') return { x: 5.6 + (i % 3) * 0.7, y: 7.6 };
      if (a.mode === 'stand') return { x: 3 + (i % 6) * 0.6, y: 8.2 };
      return SOFA[i % SOFA.length];
    }

    // ---- desenho ----
    function start() { if (!raf && host && canvas) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    function frame(t) {
      raf = 0;
      if (!host || !canvas || !canvas.isConnected) return;
      if (!document.hidden && t - lastFrame > 40) { lastFrame = t; draw(t); if (t - lastLegend > 2000) { lastLegend = t; legend(); } }
      raf = requestAnimationFrame(frame);
    }

    let view = { s: 1, ox: 0, oy: 0 };
    function iso(x, y) { return { x: view.ox + (x - y) * (TW / 2) * view.s, y: view.oy + (x + y) * (TH / 2) * view.s }; }

    function fit() {
      const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      const w = Math.max(200, Math.round(r.width)); const hh = Math.max(160, Math.round(r.height));
      if (canvas.width !== w * dpr || canvas.height !== hh * dpr) { canvas.width = w * dpr; canvas.height = hh * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const roomW = (GW + GH) * TW / 2; const roomH = (GW + GH) * TH / 2 + 70;
      const s = Math.min(w / (roomW + 20), hh / (roomH + 10));
      view = { s, ox: w / 2 - ((GW - GH) * TW / 4) * s, oy: 60 * s + (hh - roomH * s) / 2 };
      return { w, h: hh };
    }

    const css = (k, d) => (getComputedStyle(document.body).getPropertyValue(k) || d).trim() || d;

    function poly(pts, fill, stroke) { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); } }
    // caixa isométrica (x,y = canto; w,d = tamanho em ladrilhos; z = altura em px)
    function box(x, y, w, d, z, top, left, right, lift = 0) {
      const s = view.s; const L = (p) => ({ x: p.x, y: p.y - lift * s });
      const a = L(iso(x, y)), b = L(iso(x + w, y)), c = L(iso(x + w, y + d)), e = L(iso(x, y + d));
      const up = (p) => ({ x: p.x, y: p.y - z * s });
      poly([e, c, up(c), up(e)], left); poly([c, b, up(b), up(c)], right); poly([up(a), up(b), up(c), up(e)], top);
    }

    function draw(t) {
      const { w, h: H } = fit();
      const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
      ctx.clearRect(0, 0, w, H);
      const floorA = dark ? '#1d1c24' : '#e4e2ea', floorB = dark ? '#211f2a' : '#dcd9e4';
      const wallL = dark ? '#2a2835' : '#cfccd9', wallR = dark ? '#24222e' : '#c4c1cf';
      // paredes
      const s = view.s; const WALL = 64;
      const p00 = iso(0, 0), pG0 = iso(GW, 0), p0H = iso(0, GH);
      poly([p0H, p00, { x: p00.x, y: p00.y - WALL * s }, { x: p0H.x, y: p0H.y - WALL * s }], wallL);
      poly([p00, pG0, { x: pG0.x, y: pG0.y - WALL * s }, { x: p00.x, y: p00.y - WALL * s }], wallR);
      // porta (parede da esquerda)
      const d1 = iso(0, DOOR.y - 0.9), d2 = iso(0, DOOR.y + 0.5);
      poly([d1, d2, { x: d2.x, y: d2.y - 44 * s }, { x: d1.x, y: d1.y - 44 * s }], dark ? '#14131a' : '#a9a5b6');
      // janela com o "neon" da marca (parede do fundo)
      const w1 = iso(4, 0), w2 = iso(8, 0);
      poly([{ x: w1.x, y: w1.y - 22 * s }, { x: w2.x, y: w2.y - 22 * s }, { x: w2.x, y: w2.y - 50 * s }, { x: w1.x, y: w1.y - 50 * s }], dark ? '#17162a' : '#e9e6ff', '#7c5cff55');
      // piso
      for (let x = 0; x < GW; x++) for (let y = 0; y < GH; y++) poly([iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], (x + y) % 2 ? floorA : floorB);
      // tapete da pausa
      poly([iso(9.1, 7), iso(12, 7), iso(12, 9), iso(9.1, 9)], dark ? '#2b2440' : '#d8d0f5');

      // objetos e pessoas ordenados por profundidade (x + y)
      const items = [];
      DESKS.forEach((d, i) => items.push({ z: d.x + d.y + 0.5, draw: () => desk(d, [...deskOf.values()].includes(i), t, dark) }));
      SOFA.slice(0, 1).forEach(() => items.push({ z: 9.5 + 7.5, draw: () => sofa(dark) }));
      items.push({ z: 8.6 + 8.6, draw: () => coffee(dark) });
      MACHINES.forEach((m, i) => items.push({ z: m.x + m.y, draw: () => machine(m, machines[i], t, dark) }));
      let i = 0;
      for (const a of actors.values()) {
        const tg = target(a, i++);
        const dx = tg.x - a.x, dy = tg.y - a.y, dist = Math.hypot(dx, dy);
        const sp = 0.045;
        a.walking = dist > 0.05;
        if (a.walking) { a.x += (dx / dist) * Math.min(sp, dist); a.y += (dy / dist) * Math.min(sp, dist); a.face = dx - dy >= 0 ? 1 : -1; }
        if (a.mode === 'leave' && !a.walking) { actors.delete(a.id); deskOf.delete(a.id); continue; }
        items.push({ z: a.x + a.y + 0.6, draw: () => person(a, t, dark) });
      }
      items.sort((p, q) => p.z - q.z).forEach(o => o.draw());
      // nomes e balões por cima de tudo
      for (const a of actors.values()) nameTag(a, dark);
      placed = [];
      for (const a of [...actors.values()].sort((p, q) => (q.hit ? q.hit.y : 0) - (p.hit ? p.hit.y : 0))) bubble(a, t, dark);
      if (!actors.size) {
        ctx.fillStyle = dark ? '#8a8796' : '#6c6878'; ctx.font = `${Math.round(13 * Math.max(0.8, s))}px -apple-system, sans-serif`; ctx.textAlign = 'center';
        ctx.fillText('Ninguém trabalhando agora.', w / 2, H - 14);
      }
    }

    function desk(d, busy, t, dark) {
      box(d.x, d.y, 1.3, 0.8, 16, dark ? '#5a4a3a' : '#b8946c', dark ? '#3f3328' : '#94704c', dark ? '#4a3c2f' : '#a38059');
      // monitor
      const s = view.s; const p = iso(d.x + 0.35, d.y + 0.25);
      const glow = busy ? (Math.sin(t / 300) > 0 ? '#9d85ff' : '#7c5cff') : (dark ? '#2b2a33' : '#55525e');
      ctx.fillStyle = dark ? '#111' : '#333'; ctx.fillRect(p.x - 11 * s, p.y - 34 * s, 22 * s, 15 * s);
      ctx.fillStyle = glow; ctx.fillRect(p.x - 9.5 * s, p.y - 32.5 * s, 19 * s, 12 * s);
      ctx.fillStyle = dark ? '#111' : '#333'; ctx.fillRect(p.x - 2 * s, p.y - 19 * s, 4 * s, 4 * s);
    }
    function sofa(dark) {
      box(9.3, 7.9, 2.4, 0.8, 10, dark ? '#4b3f73' : '#9b88e0', dark ? '#352c55' : '#7a66c4', dark ? '#40366a' : '#8a76d2');
      box(9.3, 8.6, 2.4, 0.25, 22, dark ? '#55488a' : '#a796e8', dark ? '#352c55' : '#7a66c4', dark ? '#40366a' : '#8a76d2');
    }
    function coffee(dark) {
      box(8.3, 8.2, 0.6, 0.6, 26, dark ? '#666' : '#999', dark ? '#3a3a3a' : '#6f6f6f', dark ? '#4a4a4a' : '#808080');
      const p = iso(8.6, 8.5); ctx.fillStyle = '#e0803a'; ctx.fillRect(p.x - 2 * view.s, p.y - 20 * view.s, 4 * view.s, 3 * view.s);
    }
    function machine(m, task, t, dark) {
      box(m.x, m.y, 0.7, 1.0, 40, dark ? '#3c3c48' : '#a8a8b8', dark ? '#262630' : '#7c7c8c', dark ? '#30303c' : '#8e8e9e');
      const s = view.s; const p = iso(m.x + 0.7, m.y + 0.5);
      const on = !!task;
      for (let k = 0; k < 3; k++) { ctx.fillStyle = on ? (Math.floor(t / 250 + k) % 3 === 0 ? '#5fe08a' : '#2f7a49') : '#444'; ctx.fillRect(p.x + 2 * s, p.y - (34 - k * 8) * s, 3 * s, 3 * s); }
      if (task && task.pct != null) {
        ctx.fillStyle = '#0006'; ctx.fillRect(p.x - 18 * s, p.y - 52 * s, 36 * s, 5 * s);
        ctx.fillStyle = '#5fe08a'; ctx.fillRect(p.x - 18 * s, p.y - 52 * s, 36 * s * Math.min(1, task.pct / 100), 5 * s);
      }
    }

    function person(a, t, dark) {
      const s = view.s * (a.kind === 'agent' ? 0.85 : 1);
      const p = iso(a.x, a.y);
      const sitting = !a.walking && (a.mode === 'desk' || a.mode === 'stalled' || a.mode === 'sofa');
      const bob = a.walking ? Math.abs(Math.sin(t / 110 + a.phase)) * 2 : 0;
      const y0 = p.y - bob * s;
      // sombra
      ctx.fillStyle = '#0003'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 8 * s, 3.5 * s, 0, 0, Math.PI * 2); ctx.fill();
      // pernas
      ctx.fillStyle = dark ? '#2c2c3a' : '#3d3d50';
      if (sitting) ctx.fillRect(p.x - 5 * s, y0 - 8 * s, 10 * s, 4 * s);
      else { const st = a.walking ? Math.sin(t / 110 + a.phase) * 2 : 0; ctx.fillRect(p.x - 4 * s, y0 - 10 * s + st * s, 3 * s, 10 * s - st * s); ctx.fillRect(p.x + 1 * s, y0 - 10 * s - st * s, 3 * s, 10 * s + st * s); }
      // corpo
      const by = y0 - (sitting ? 20 : 22) * s;
      ctx.fillStyle = a.mode === 'stalled' ? '#777' : a.color; ctx.fillRect(p.x - 6 * s, by, 12 * s, 13 * s);
      // braços digitando
      if (a.mode === 'desk' && !a.walking) { const k = Math.sin(t / 70 + a.phase) > 0 ? 1 : 0; ctx.fillRect(p.x - 8 * s, by + (3 + k) * s, 3 * s, 7 * s); ctx.fillRect(p.x + 5 * s, by + (4 - k) * s, 3 * s, 7 * s); }
      // cabeça
      ctx.fillStyle = '#f0c8a0'; ctx.fillRect(p.x - 5 * s, by - 10 * s, 10 * s, 10 * s);
      ctx.fillStyle = a.kind === 'claude' ? '#3a2a20' : '#6a5a50'; ctx.fillRect(p.x - 5 * s, by - 11 * s, 10 * s, 3 * s);
      ctx.fillStyle = '#222'; const f = a.face || 1; ctx.fillRect(p.x + (f > 0 ? 1 : -3) * s, by - 6 * s, 1.5 * s, 1.5 * s);
      // chefe/ajudante: o agente usa a cor do Claude que o chamou no "crachá"
      if (a.kind === 'agent' && a.boss) { ctx.fillStyle = a.boss; ctx.fillRect(p.x - 2 * s, by + 3 * s, 4 * s, 4 * s); }
      if (a.kind === 'claude') { ctx.fillStyle = '#fff'; ctx.font = `${Math.round(8 * s)}px -apple-system`; ctx.textAlign = 'center'; ctx.fillText('✳', p.x, by + 9 * s); }
      a.hit = { x: p.x - 9 * s, y: by - 12 * s, w: 18 * s, h: (p.y - by) + 12 * s };
      a.foot = { x: p.x, y: p.y };
    }

    function nameTag(a, dark) {
      if (!a.foot || !(hover === a || a.kind === 'claude')) return;
      const fs = Math.round(10 * Math.max(0.85, view.s));
      ctx.font = `600 ${fs}px -apple-system, sans-serif`; ctx.textAlign = 'center';
      const txt = clipTxt(a.name, 26); const w = ctx.measureText(txt).width + 10; const y = a.foot.y + 6 * view.s;
      ctx.fillStyle = dark ? '#000a' : '#fffc'; roundRect(a.foot.x - w / 2, y, w, fs + 6, 5); ctx.fill();
      ctx.fillStyle = dark ? '#d9d6e6' : '#36323f'; ctx.fillText(txt, a.foot.x, y + fs + 1);
    }

    function bubble(a, t, dark) {
      if (!a.hit || !(a.bubble && (hover === a || a.kind === 'claude' || a.mode === 'waiting' || a.mode === 'stalled' || deskOf.size <= 6))) return;
      const fs = Math.round(10 * Math.max(0.85, view.s));
      ctx.font = `${fs}px -apple-system, sans-serif`;
      let txt = clipTxt(a.bubble, hover === a ? 60 : 30);
      if (a.since && (a.mode === 'desk' || a.mode === 'stalled')) txt += ` · ${dur(Date.now() - a.since)}`;
      const tw = ctx.measureText(txt).width + 12; const bh = fs + 8;
      const x = Math.max(4, Math.min(canvas.clientWidth - tw - 4, a.hit.x + a.hit.w / 2 - tw / 2)); let y = a.hit.y - bh - 6;
      // não cobre outro balão: sobe até achar espaço (no máximo 6 tentativas; se não achar, só mostra no hover)
      let tries = 0;
      while (placed.some(r => x < r.x + r.w && x + tw > r.x && y < r.y + r.h + 2 && y + bh + 2 > r.y) && tries++ < 6) y -= bh + 3;
      if (tries > 6 && hover !== a) return;
      placed.push({ x, y, w: tw, h: bh });
      const bg = a.mode === 'waiting' ? '#f2b23a' : a.mode === 'stalled' ? (dark ? '#3a3a44' : '#d6d6de') : (dark ? '#2a2838ee' : '#ffffffee');
      ctx.fillStyle = bg; roundRect(x, y, tw, bh, 6); ctx.fill();
      ctx.strokeStyle = a.mode === 'desk' ? '#7c5cff88' : '#0002'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = a.mode === 'waiting' ? '#2a1d00' : dark ? '#e6e3f0' : '#2a2733'; ctx.textAlign = 'left'; ctx.fillText(txt, x + 6, y + fs + 2);
    }
    function roundRect(x, y, w, hh, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    const clipTxt = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    function pick(e) {
      const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null;
      for (const a of actors.values()) if (a.hit && x >= a.hit.x && x <= a.hit.x + a.hit.w && y >= a.hit.y && y <= a.hit.y + a.hit.h) best = a;
      return best;
    }

    // legenda em texto (acessível, e dá o detalhe que não cabe no balão)
    function legend() {
      const el = host && host.querySelector('.office-legend'); if (!el) return;
      while (el.firstChild) el.removeChild(el.firstChild);
      const nowT = Date.now();
      const terms = opts.terms(scope);
      if (!terms.length) { el.appendChild(h('div', { class: 'muted small', text: 'Nenhum terminal com IA aberto.' })); return; }
      for (const t of terms) {
        const a = act[t.id];
        const row = h('div', { class: 'ol-row', onclick: () => opts.goTerm(t.projectId, t.id) },
          h('b', { text: `${t.projectName} · ${t.name}` }),
          h('span', { class: `ol-st st-${t.state || 'idle'}`, text: a && a.stalled ? 'sem sinal' : ({ working: 'trabalhando', waiting: 'esperando você', background: 'segundo plano', done: 'terminou', unknown: 'sem notícia' }[t.state] || 'parado') }));
        el.appendChild(row);
        if (!a) continue;
        for (const r of rows(a, nowT)) {
          const txt = r.agents ? r.agents.map(x => `${x.type}: ${x.what}${x.last ? ` — ${x.last.verb.toLowerCase()} ${x.last.what}` : ''} (${dur(nowT - x.since)})`).join('\n')
            : `${r.label}${r.what ? ': ' + r.what : ''} · ${dur(nowT - r.since)}${r.line ? ` · “${r.line}”` : ''}${r.eta ? ` · ${r.eta.text}` : ''}`;
          el.appendChild(h('div', { class: 'ol-item', text: `${r.ic} ${txt}` }));
        }
      }
    }

    return { mount, unmount, sync, isOpen: () => !!host };
  })();

  window.ActivityUI = { init, paintStrips, has: (id) => !!act[id], get: (id) => act[id] || null, Office };
})();
