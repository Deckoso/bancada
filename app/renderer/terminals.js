// Terminais xterm por projeto. Cada terminal vivo tem um xterm na página e um pty no processo principal.
// Trocar de projeto só esconde os terminais (não mata): voltar é instantâneo e o processo continua rodando.
// Renderização (2026-11-05, "terminal meio bugado"): larguras Unicode 11 (✻ ⏵ ● do Claude), lineHeight 1 (molduras
// sem frestas) e fonte carregada antes de medir. WebGL foi testado e DESLIGADO: media mal o SF Mono (letras miúdas e
// espaçadas, no Mac e no celular). Fica o renderizador DOM, que desenha certo.
// Mac + celular no MESMO terminal: o tamanho do pty é de quem está usando. Quando outro aparelho muda o tamanho,
// este fica "desatualizado" e retoma o próprio tamanho no próximo toque de tecla/foco — sem ping-pong automático.
// v0.2 (BP-2026-11-05-001): cada terminal vive dentro de um PAINEL (divisão de tela, layout.js). mount() move o xterm
// para o painel; os que não estão à vista ficam num depósito escondido. Colar imagem (⌘V) e soltar arquivo do Finder
// colam o caminho no terminal (o Claude lê a imagem pelo caminho).
'use strict';
(function () {
  const { h } = window.UI;
  const SCROLLBACK = 5000;
  const THEME = {
    background: '#0b0b0e', foreground: '#e8e8ed', cursor: '#7c5cff', cursorAccent: '#0b0b0e',
    selectionBackground: 'rgba(124,92,255,.35)',
    black: '#1c1c22', red: '#ff5f57', green: '#30d158', yellow: '#ffbd2e', blue: '#64a8ff', magenta: '#c08cff', cyan: '#5ad6e0', white: '#d6d6dc',
    brightBlack: '#5c5c66', brightRed: '#ff7a73', brightGreen: '#5ee07f', brightYellow: '#ffd060', brightBlue: '#8cc0ff', brightMagenta: '#d4adff', brightCyan: '#86e6ee', brightWhite: '#ffffff',
  };
  // v0.7 Windows: Ctrl no lugar do ⌘, fonte do Windows, caminho entre aspas duplas
  // no celular, platform é o do COMPUTADOR (o remote-bridge recebe do servidor): o caminho colado é para o shell de lá
  const WIN = window.bancada && window.bancada.platform === 'win32';
  const HOST = WIN ? 'PC' : 'Mac';
  const FONT = WIN ? '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace' : '"SF Mono", ui-monospace, Menlo, monospace';

  const terms = new Map();    // id -> { term, fit, el, projectId, name, alive, stale }
  let stash = null;
  let ro = null;
  let fontsReady = null;
  let onFocusCb = () => {};

  function init(container, { onFocus } = {}) {
    stash = h('div', { id: 'term-stash' });
    document.body.appendChild(stash);
    if (onFocus) onFocusCb = onFocus;
    // mede a fonte só depois de carregada (senão a largura da célula sai errada e o texto desalinha)
    fontsReady = (document.fonts && document.fonts.load ? document.fonts.load(`13px ${FONT}`).then(() => document.fonts.ready) : Promise.resolve()).catch(() => {});
    window.bancada.pty.onData(({ id, data }) => { const t = terms.get(id); if (t) t.term.write(data); });
    window.bancada.pty.onExit(({ id, exitCode }) => {
      const t = terms.get(id); if (!t) return;
      t.alive = false;
      t.term.write(`\r\n\x1b[90m[processo encerrado (${exitCode}). Enter reabre o terminal]\x1b[0m\r\n`);
      if (window.App) window.App.onTerminalsChanged();
    });
    if (window.bancada.pty.onSize) {
      window.bancada.pty.onSize(({ id, cols, rows }) => {
        const t = terms.get(id); if (!t) return;
        t.stale = cols !== t.term.cols || rows !== t.term.rows;   // outro aparelho pegou o tamanho
        markStale(t);
      });
    }
    // no Mac: o celular desconectou → o Mac retoma o tamanho dos terminais à vista (sem esperar digitar)
    if (!window.__REMOTE && window.bancada.remote && window.bancada.remote.onClients) {
      let last = 0;
      window.bancada.remote.onClients(({ n }) => { if (n < last) reclaimAll(); last = n; });
    }
    // um único ResizeObserver; observa cada terminal (o painel muda de tamanho ao arrastar a divisória)
    ro = new ResizeObserver((entries) => {
      for (const en of entries) { const t = terms.get(en.target.dataset.id); if (t && t.el.offsetParent) fitOne(t); }
    });
    // voltar para esta janela/aba: retoma o tamanho daqui
    window.addEventListener('focus', reclaimAll);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reclaimAll(); });
  }

  function reclaimAll() { for (const t of terms.values()) if (t.el.offsetParent && t.stale) fitOne(t, true); }

  // aviso no painel enquanto outro aparelho está com o tamanho do terminal (o texto sai estreito/cortado aqui)
  function markStale(t) {
    let b = t.el.querySelector(':scope > .term-stale');
    if (!t.stale) { if (b) b.remove(); return; }
    if (b) return;
    b = window.UI.h('button', { class: 'term-stale', title: 'O terminal está no tamanho do outro aparelho', onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); fitOne(t, true); } },
      window.__REMOTE ? 'Tamanho do computador · toque para ajustar aqui' : `📱 No tamanho do celular · clique para voltar ao do ${HOST}`);
    t.el.appendChild(b);
  }

  function fitOne(t, force = false) {
    try {
      const before = `${t.term.cols}x${t.term.rows}`;
      t.fit.fit();
      if (force || t.stale || before !== `${t.term.cols}x${t.term.rows}` || !t.sizedOnce) {
        if (t.alive) { window.bancada.pty.resize(t.id, t.term.cols, t.term.rows); t.stale = false; t.sizedOnce = true; markStale(t); }
      }
    } catch {}
  }

  function makeTerm() {
    const term = new window.Terminal({
      fontFamily: FONT, fontSize: 13, lineHeight: 1, letterSpacing: 0,
      cursorBlink: true, scrollback: SCROLLBACK, allowProposedApi: true, theme: THEME, macOptionIsMeta: true, windowsPty: WIN ? { backend: 'conpty' } : undefined,
      drawBoldTextInBrightColors: false,
      // links OSC 8 (o Claude Code manda com FORCE_HYPERLINK=1): http → Safari; file:// → mesmo tratamento dos caminhos
      linkHandler: { allowNonHttpProtocols: true, activate: (e, uri) => { if (/^https?:/i.test(uri)) openUrl(uri); else if (/^file:\/\//i.test(uri)) { try { const u = new URL(uri); if (u.hostname) return; let p = decodeURIComponent(u.pathname); if (WIN) p = p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\'); if (/^[\\/]{2}/.test(p)) return; openPath({ abs: p }); } catch {} } } },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    // v0.6: link da web abre no Safari (no celular, no próprio aparelho)
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => openUrl(uri)));
    if (window.Unicode11Addon) {
      try { term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch {}
    }
    return { term, fit };
  }

  // ---------- v0.6: caminho no texto vira link (pasta → Finder, .md → visualização, arquivo → Finder) ----------
  function openUrl(uri) { const L = window.bancada.links; if (L && L.openUrl) L.openUrl(uri).catch(() => {}); else window.open(uri); }
  async function openPath(r) {
    const L = window.bancada.links; if (!L) return;
    const toastErr = (e) => window.UI.toast(String((e && e.message) || e).replace(/^\[[A-Z_]+\]\s*/, ''));
    let kind = r.kind;
    if (!kind) { kind = /\.(md|markdown|mdx)$/i.test(r.abs) ? 'md' : 'dir'; }
    if (kind === 'md') { if (window.MdView) window.MdView.open(r.abs); return; }
    if (kind === 'dir') { if (L.openDir) L.openDir(r.abs).catch(toastErr); else window.UI.toast(`Abrir pasta só funciona no ${HOST}`); return; }
    if (L.reveal) L.reveal(r.abs).catch(toastErr); else window.UI.toast(WIN ? 'Mostrar no Explorador só funciona no PC' : 'Mostrar no Finder só funciona no Mac');
  }
  const linkCache = new Map();   // "termId\u0000linha" -> Promise<resultados> (teto 300, some sozinho em 15 s)
  // onde pode começar um caminho: "/x", "~/x", "./x", "../x" ou palavra com "/" (relativo); URL fica com o WebLinksAddon
  function candidates(text) {
    const out = [];
    // v0.7: no Windows também "C:\\x", ".\\x" e "pasta\\x"
    const re = WIN ? /(^|[\s(\[{"'`<=])([A-Za-z]:[\\/][^\s]|(?:~|\.{1,2})?[\\/][^\s]|[\p{L}\p{N}_@.-]+[\\/])/gu
      : /(^|[\s(\[{"'`<:=])((?:~|\.{1,2})?\/[^\s]|[\p{L}\p{N}_@.-]+\/)/gu;
    let m;
    while ((m = re.exec(text)) && out.length < 24) {
      const at = m.index + m[1].length;
      const word = text.slice(at).split(/\s/)[0];
      if (/:\/\//.test(word) || /^[\\/]{2}/.test(word)) continue;   // URL ou caminho de rede (\\servidor, //servidor, /\servidor)
      out.push({ at, raw: text.slice(at, at + 600) });
    }
    return out;
  }
  // linha lógica (junta as linhas quebradas pelo tamanho do terminal) + posição de cada caractere na tela
  function logical(term, y0) {
    const buf = term.buffer.active;
    let y = y0; while (y > 0) { const l = buf.getLine(y); if (!l || !l.isWrapped) break; y--; }
    let text = ''; const pos = [];
    const cell = buf.getNullCell ? buf.getNullCell() : undefined;
    for (let row = y; row < buf.length; row++) {
      const line = buf.getLine(row); if (!line) break;
      if (row > y && !line.isWrapped) break;
      for (let x = 0; x < line.length; x++) {
        const c = line.getCell(x, cell); if (!c) break;
        if (c.getWidth() === 0) continue;
        const ch = c.getChars() || ' ';
        for (const u of ch) { text += u; pos.push({ x: x + 1, y: row + 1 }); }
      }
      if (row - y > 20) break;
    }
    const trimmed = text.replace(/\s+$/, '');
    return { text: trimmed, pos: pos.slice(0, trimmed.length) };
  }
  function pathLinks(t) {
    return {
      provideLinks(bufferLine, cb) {
        const L = window.bancada.links; if (!L || !L.resolve) return cb(undefined);
        const { text, pos } = logical(t.term, bufferLine - 1);
        if (!text || !(WIN ? /[\\/]/ : /\//).test(text)) return cb(undefined);
        const cands = candidates(text); if (!cands.length) return cb(undefined);
        const key = `${t.id}\u0000${text}`;
        let p = linkCache.get(key);
        if (!p) {
          p = L.resolve(t.id, cands).catch(() => []);
          linkCache.set(key, p); setTimeout(() => linkCache.delete(key), 15000);
          if (linkCache.size > 300) linkCache.delete(linkCache.keys().next().value);
        }
        p.then((res) => {
          const links = []; let lastEnd = -1;
          for (const r of res || []) {
            if (!r || r.at < lastEnd || !pos[r.at] || !pos[r.at + r.len - 1]) continue;
            lastEnd = r.at + r.len;
            const start = pos[r.at], end = pos[r.at + r.len - 1];
            if (end.y < bufferLine || start.y > bufferLine) continue;   // o xterm pede por linha da tela
            links.push({ range: { start, end }, text: text.slice(r.at, r.at + r.len), decorations: { underline: true, pointerCursor: true },
              activate: (e) => { if (e && e.button && e.button !== 0) return; openPath(r); } });
          }
          cb(links.length ? links : undefined);
        });
      },
    };
  }

  // caminho entre aspas simples (shell) para colar no terminal
  // Windows: aspas simples do PowerShell (literais; ' e as tipográficas ‘ ’ ‚ ‛ dobradas) — aspas duplas expandiriam $(…)
  const quote = (p) => (WIN ? "'" + String(p).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&') + "'" : "'" + String(p).replace(/'/g, "'\\''") + "'");

  function bindInputs(t) {
    // ⌘V com imagem (print) na área de transferência: o Mac salva em anexos/ e cola o caminho
    t.el.addEventListener('paste', (e) => {
      const items = [...((e.clipboardData && e.clipboardData.items) || [])];
      const hasText = items.some(i => i.kind === 'string' && i.type === 'text/plain');
      const img = items.find(i => i.kind === 'file' && /^image\//.test(i.type));
      if (!img || hasText) return;
      e.preventDefault(); e.stopPropagation();
      if (window.__REMOTE) { const f = img.getAsFile(); if (f) sendImageFile(t.id, f); return; }
      window.bancada.attach.clipboard(t.id).catch(er => window.UI.toast(String(er.message).replace(/^\[[A-Z_]+\]\s*/, '')));
    }, true);
    // soltar arquivo do Finder: cola o caminho (sem copiar). Imagem do celular: envia.
    t.el.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    t.el.addEventListener('drop', (e) => {
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation();
      if (window.__REMOTE) { for (const f of files.slice(0, 4)) if (/^image\//.test(f.type)) sendImageFile(t.id, f); return; }
      const paths = files.slice(0, 20).map(f => window.bancada.files.pathFor(f)).filter(Boolean);
      if (paths.length) paste(t.id, paths.map(quote).join(' ') + ' ');
    });
  }

  // celular/iPad: a foto vai pelo canal remoto (teto 10 MB) e o Mac cola o caminho
  function sendImageFile(id, file) {
    if (file.size > 10 * 1024 * 1024) { window.UI.toast('Imagem grande demais (máx. 10 MB pelo celular)'); return; }
    const r = new FileReader();
    r.onload = () => {
      const b64 = String(r.result).replace(/^data:[^,]*,/, '');
      window.bancada.attach.image(id, { name: file.name || 'foto', b64 }).catch(er => window.UI.toast(String(er.message).replace(/^\[[A-Z_]+\]\s*/, '')));
    };
    r.readAsDataURL(file);
  }

  function paste(id, text) {
    if (!isAlive(id)) { window.UI.toast('Este terminal não está rodando'); return; }
    window.bancada.pty.paste(id, text).then(() => focus(id)).catch(() => {});
  }

  // Windows: Ctrl+C copia se há seleção (senão interrompe, como sempre); Ctrl+V e Ctrl+Shift+V colam (o navegador cola,
  // e a colagem de imagem passa pelo mesmo caminho do Mac); Ctrl+Shift+C copia. Ctrl+1…5 e Ctrl+Shift+T/J/F/\\ ficam
  // com o app — Ctrl+T, Ctrl+J, Ctrl+F e Ctrl+R sozinhos continuam do terminal (o Claude usa).
  function winKey(term, e) {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'c' && (e.shiftKey || term.hasSelection())) {
      const sel = term.getSelection(); if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      term.clearSelection(); e.preventDefault(); return false;
    }
    if (k === 'v') return false;                                  // deixa o navegador colar (evento paste)
    if (!e.shiftKey && ['1', '2', '3', '4', '5'].includes(k)) return false;
    if (e.shiftKey && ['t', 'j', 'f', '\\', '|', 'k'].includes(k)) {
      if (k === 'k') { term.clear(); e.preventDefault(); }
      return false;
    }
    return true;
  }

  // cria (se preciso) e coloca o terminal dentro do painel `container`; liga o processo se ainda não está rodando
  async function open({ id, projectId, name, cwd, startup, container }) {
    await fontsReady;
    let t = terms.get(id);
    if (!t) {
      const { term, fit } = makeTerm();
      const el = h('div', { class: 'term', dataset: { id } });
      (container || stash).appendChild(el);
      term.open(el);
      t = { id, term, fit, el, projectId, name, cwd, startup, alive: false, stale: false, sizedOnce: false };
      term.registerLinkProvider(pathLinks(t));
      terms.set(id, t);
      ro.observe(el);
      term.onData((d) => {
        if (!t.alive) { if (d === '\r') spawn(t); return; }
        if (t.stale) fitOne(t, true);              // quem digita é dono do tamanho
        window.bancada.pty.write(id, d);
      });
      // ⌘K limpa; o resto dos atalhos com ⌘ fica com o app
      term.attachCustomKeyEventHandler((e) => {
        if (WIN) return winKey(term, e);
        if (e.type === 'keydown' && e.metaKey && e.key === 'k') { term.clear(); return false; }
        if (e.metaKey && ['1', '2', '3', '4', '5', 't', 'j', 'f', '\\'].includes(e.key)) return false;
        return true;
      });
      if (term.textarea) term.textarea.addEventListener('focus', () => { if (t.stale) fitOne(t, true); onFocusCb(t.id); });
      // clicar no terminal também é "estou usando aqui": retoma o tamanho (o foco não dispara se já estava focado)
      el.addEventListener('mousedown', () => { if (t.stale) fitOne(t, true); });
      bindInputs(t);
    } else if (container && t.el.parentElement !== container) {
      container.appendChild(t.el);
    }
    let r = null;
    if (!t.alive) r = await spawn(t);
    else requestAnimationFrame(() => fitOne(t, true));
    return { id: t.id, warning: r && r.warning };
  }

  async function spawn(t) {
    try { t.fit.fit(); } catch {}
    try {
      const live = await window.bancada.pty.live();
      if (live.some(x => x.id === t.id)) {
        // já está rodando (outro aparelho abriu, ou a página recarregou): reconecta e reproduz a saída recente
        const tail = await window.bancada.pty.replay(t.id);
        if (tail) t.term.write(tail);
        t.alive = true;
        fitOne(t, true);
        if (window.App) window.App.onTerminalsChanged();
        return {};
      }
    } catch {}
    try {
      const r = await window.bancada.pty.create({ id: t.id, projectId: t.projectId, name: t.name, cwd: t.cwd, cols: t.term.cols || 100, rows: t.term.rows || 30, startup: t.startup || null });
      t.alive = true; t.sizedOnce = true;
      if (r && r.warning) t.term.write(`\x1b[33m${r.warning}\x1b[0m\r\n`);
      if (window.App) window.App.onTerminalsChanged();
      return r;
    } catch (e) {
      t.term.write(`\r\n\x1b[31m${String(e.message).replace(/^\[[A-Z_]+\]\s*/, '')}\x1b[0m\r\n`);
    }
    if (window.App) window.App.onTerminalsChanged();
    return null;
  }

  // guarda no depósito escondido todos os terminais que não estão nos painéis
  function stashExcept(ids) {
    for (const t of terms.values()) if (!ids.includes(t.id) && t.el.parentElement !== stash) stash.appendChild(t.el);
  }

  async function close(id) {
    const t = terms.get(id); if (!t) return;
    await window.bancada.pty.kill(id).catch(() => {});
    try { ro.unobserve(t.el); } catch {}
    t.term.dispose(); t.el.remove(); terms.delete(id);
  }

  // reinicia o processo do terminal (ex.: trocar Claude normal ↔ sem permissões); a conversa continua (--resume)
  async function restart(id) {
    const t = terms.get(id); if (!t) return;
    await window.bancada.pty.kill(id).catch(() => {});
    t.alive = false;
    t.term.reset();
    await spawn(t);
  }

  function isAlive(id) { const t = terms.get(id); return !!(t && t.alive); }
  function liveCount(projectId) { let n = 0; for (const t of terms.values()) if (t.alive && (!projectId || t.projectId === projectId)) n++; return n; }
  function focus(id) { const t = terms.get(id); if (t) t.term.focus(); }
  function has(id) { return terms.has(id); }

  window.Terminals = { init, open, stashExcept, close, restart, isAlive, liveCount, focus, has, paste, quote, sendImageFile };
})();
