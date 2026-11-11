// Ponte remota: no celular/iPad, faz o papel do preload do Electron — mesma API window.bancada, por WebSocket.
// Pareamento: o QR do Mac abre esta página com #pair=<código>; trocamos o código por um token do aparelho.
'use strict';
(function () {
  const TOKEN_KEY = 'bancada.remoteToken';
  window.__REMOTE = true;
  let ws = null, seq = 0, backoff = 1000, timer = null, ready = null;
  const pending = new Map();
  const subs = {};
  const queue = [];

  function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch {} }

  function banner(msg, kind = '') {
    let b = document.getElementById('remote-banner');
    if (!b) { b = document.createElement('div'); b.id = 'remote-banner'; document.documentElement.appendChild(b); }
    b.className = kind; b.textContent = msg; b.hidden = !msg;
  }

  async function pairIfNeeded() {
    const m = /#pair=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname);         // tira o código da barra de endereço
    const name = /iPad/.test(navigator.userAgent) ? 'iPad' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'aparelho';
    const r = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: m[1], name }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { banner(j.error || 'Pareamento recusado. Gere um QR novo no Mac.', 'err'); return; }
    setToken(j.token);
  }

  function connect() {
    const token = getToken();
    if (!token) { banner('Este aparelho ainda não está pareado. No Mac: Ajustes → Acesso remoto → Parear aparelho, e leia o QR.', 'err'); return; }
    ready = new Promise((resolve) => {
      ws = new WebSocket(`ws://${location.host}/ws`, [`bancada.${token}`]);
      ws.onopen = () => { backoff = 1000; banner(''); resolve(); while (queue.length) ws.send(queue.shift()); };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.ev) { for (const fn of subs[m.ev] || []) { try { fn(m.payload); } catch (err) { console.error(err); } } return; }
        const p = pending.get(m.id); if (!p) return;
        pending.delete(m.id); clearTimeout(p.t);
        if (m.ok) p.resolve(m.data); else p.reject(new Error(`[${m.code || 'ERR'}] ${m.error || 'falha'}`));
      };
      ws.onclose = (e) => {
        for (const p of pending.values()) { clearTimeout(p.t); p.reject(new Error('[OFFLINE] conexão com o Mac caiu')); }
        pending.clear();
        if (e.code === 4001) { setToken(null); banner('Este aparelho foi desconectado no Mac. Pareie de novo.', 'err'); return; }
        banner('Sem conexão com o Mac (ele está acordado e com o Tailscale ligado?). Tentando de novo…', 'warn');
        clearTimeout(timer);
        timer = setTimeout(connect, backoff);                  // um timer só, com espera crescente até 30 s
        backoff = Math.min(30000, backoff * 2);
      };
    });
  }

  function send(ch, args) {
    const msg = JSON.stringify({ id: ++seq, ch, args });
    if (ws && ws.readyState === 1) ws.send(msg); else if (queue.length < 200) queue.push(msg);
    return seq;
  }
  const call = (ch) => (...args) => new Promise((resolve, reject) => {
    const id = send(ch, args);
    const t = setTimeout(() => { pending.delete(id); reject(new Error('[TIMEOUT] o Mac não respondeu')); }, 20000);
    pending.set(id, { resolve, reject, t });
  });
  const fire = (ch) => (...args) => { send(ch, args); };
  const on = (ch) => (fn) => { (subs[ch] = subs[ch] || new Set()).add(fn); return () => subs[ch].delete(fn); };

  window.bancada = {
    projects: { list: call('projects:list'), create: call('projects:create'), update: call('projects:update'), swapFocus: call('projects:swapFocus'),
      discover: call('projects:discover'), git: call('projects:git'), setActive: call('projects:setActive'), reorder: call('projects:reorder') },
    items: { list: call('items:list'), create: call('items:create'), update: call('items:update'), remove: call('items:delete'), today: call('items:today'), reorder: call('items:reorder') },
    terminals: { byIds: call('terminals:byIds'), list: call('terminals:list'), save: call('terminals:save'), remove: call('terminals:remove'), newConversation: call('terminals:newConversation'), initialPrompt: call('terminals:initialPrompt'), reorder: call('terminals:reorder') },
    engines: { list: call('engines:list'), check: call('engines:check'), details: call('engines:details'), add: call('engines:add'), update: call('engines:update'),
      remove: call('engines:remove'), setDefault: call('engines:setDefault'), suggest: call('engines:suggest'), onChanged: on('engines:changed') },
    pty: { create: call('pty:create'), kill: call('pty:kill'), paste: call('pty:paste'), live: call('pty:live'), replay: call('pty:replay'),
      write: fire('pty:write'), resize: fire('pty:resize'), onData: on('pty:data'), onExit: on('pty:exit'), onSize: on('pty:size'), onUrl: on('pty:url') },
    sessions: { forProject: call('sessions:forProject'), unassigned: call('sessions:unassigned'), assign: call('sessions:assign'), rescan: call('sessions:rescan'), onChanged: on('sessions:changed') },
    summary: { refresh: call('summary:refresh'), status: call('summary:status') },
    today: { suggest: call('today:suggest'), set: call('today:set') },
    settings: { get: call('settings:get'), set: call('settings:set') },
    app: { importPromptPad: call('app:importPromptPad'), pickFolder: call('app:pickFolder'), openInCursor: call('app:openInCursor') },
    capture: { submit: call('capture:submit'), hide: call('capture:hide'), onOpen: on('capture:open') },
    remote: null,
    asks: { list: call('asks:list'), answer: call('asks:answer'), dismiss: call('asks:dismiss'), onChanged: on('asks:changed') },
  activity: { list: call('activity:list'), onChanged: on('activity:changed') },
  claude: { states: call('claude:states'), seen: call('claude:seen'), context: call('claude:context'), onState: on('claude:state') },
    // o layout dos painéis é do Mac: o celular mostra 1 painel e não grava nada
    ui: { focusTerm: async () => true, onGoTerminal: on('ui:goTerminal'), layoutGet: async () => null, layoutSet: async () => true },
    files: { roots: call('files:roots'), list: call('files:list'), read: call('files:read'), reveal: null, openInCursor: null, pathFor: () => null },
    git: { status: call('git:status'), diff: call('git:diff'), commit: call('git:commit') },
    attach: { clipboard: null, image: call('attach:image') },
    preview: null,
    ai: { installed: call('ai:installed'), status: call('ai:status'), onLog: on('ai:log') },   // no celular só o status; instalar/conectar é no Mac
    onDataChanged: on('data:changed'),
    onMorning: on('morning:open'),
  };

  pairIfNeeded().catch(() => {}).finally(connect);
})();
