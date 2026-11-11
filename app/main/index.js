// Processo principal da Bancada. Fonte: BLUEPRINT D2 (segurança), D3 (terminais), D12 (bandeja/login), D13 (captura).
'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, dialog, shell, session, screen, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { open, uid } = require('./db');
const { PtyManager } = require('./pty-manager');
const { importPromptPad } = require('./import-promptpad');
const { discoverProjects } = require('./discover');
const { SessionReader } = require('./sessions/reader');
const { Summarizer } = require('./summarizer');
const { Morning } = require('./morning');
const { EngineWatch, launchSpec } = require('./engines');
const { Remote } = require('./remote');
const { ClaudeHooks } = require('./hooks');
const { Activity } = require('./activity');
const { AskBroker } = require('./asks');
const { AiTools, IDS: AI_IDS, firstProjectDir } = require('./ai-tools');
const files = require('./files');
const gitview = require('./gitview');
const attachments = require('./attachments');
const contextMeter = require('./context-meter');
const preview = require('./preview');
const { clipboard } = require('electron');
const QRCode = require('qrcode');
const git = require('./git');
const v = require('./validate');

const RENDERER = path.join(__dirname, '..', 'renderer');
const USER_DIR = process.env.BANCADA_DATA_DIR || path.join(app.getPath('appData'), 'Bancada');
const PROMPTPAD_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'PromptPad', 'notes.json');
// Pasta de trabalho: ~/Documents e as pastas logo abaixo dela (sem caminho fixo de ninguém). Teto de 60 para não varrer demais.
const PROJECT_DIR_NAMES = ['PROJETOS', 'Projetos', 'Projects', 'projects'];
function workRoots() {
  const docs = path.join(os.homedir(), 'Documents');
  let ents = []; try { ents = fs.readdirSync(docs, { withFileTypes: true }); } catch {}
  const subs = ents.filter(e => e.isDirectory() && !e.name.startsWith('.') && !PROJECT_DIR_NAMES.includes(e.name)).slice(0, 60).map(e => path.join(docs, e.name));
  return [docs, ...subs];
}
// a pasta PROJETOS/<categoria>/<projeto> que o cadastro inicial lista (a primeira que existir)
function projectsDir() {
  for (const r of workRoots()) for (const n of PROJECT_DIR_NAMES) { const d = path.join(r, n); try { if (fs.statSync(d).isDirectory()) return d; } catch {} }
  return null;
}
const HOTKEY_DEFAULT = 'Alt+Space';

// pasta de dados própria (testes) → perfil próprio do Electron, para não colidir com a Bancada aberta
if (process.env.BANCADA_DATA_DIR) app.setPath('userData', path.join(process.env.BANCADA_DATA_DIR, 'electron'));
if (!app.requestSingleInstanceLock()) { app.quit(); }

let ai, store, ptys, reader, summarizer, morning, engines, remote, hooks, asks, mainWin, captureWin, tray;
let activity = null;
const initialPrompts = new Map();   // terminal -> 1ª mensagem do Claude (entrevista guiada); usada uma vez
const PLUGIN_DIR_NAME = 'plugin';
let focusedTerm = null;          // terminal que o usuário está olhando no Mac (para não avisar dele)
const ANEXOS_DIR = path.join(USER_DIR, 'anexos');
const NOTIFY_DONE_MIN_MS = 20000;   // "terminou" só avisa se o Claude trabalhou pelo menos 20 s
let awakeId = null;
const handlers = new Map();   // mesmos handlers do IPC, usados também pelo acesso remoto
let activeProjectId = 'inbox';

// ---------- segurança global ----------
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (preview.previews.has(wc)) { preview.onWindowOpen(wc, url); return { action: 'deny' }; }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);   // links do terminal abrem no navegador
    return { action: 'deny' };
  });
  wc.on('will-navigate', (ev, url) => {
    // a janela de prévia navega só dentro do próprio Mac (loopback); as nossas, só nos nossos arquivos
    if (preview.previews.has(wc)) { if (!preview.allowNavigate(url)) ev.preventDefault(); return; }
    if (!url.startsWith('file://')) ev.preventDefault();
  });
  wc.on('will-redirect', (ev, url) => { if (preview.previews.has(wc) && !preview.allowNavigate(url)) ev.preventDefault(); });
  wc.on('will-attach-webview', ev => ev.preventDefault());
});

function secureWebPrefs() {
  return {
    preload: path.join(__dirname, '..', 'preload', 'bridge.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
  };
}

function isOurFrame(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('file://') && decodeURIComponent(new URL(url).pathname).startsWith(RENDERER);
}

// Registra handler IPC que só aceita chamadas das nossas páginas e devolve {ok,data}|{ok:false,error,code}
function handle(channel, fn) {
  handlers.set(channel, fn);
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isOurFrame(event)) return { ok: false, error: 'origem recusada', code: 'FORBIDDEN' };
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || 'ERR' }; }
  });
}

function send(channel, payload) {
  if (channel === 'pty:exit' && hooks) hooks.reset(payload.id);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
  // a saída do login das IAs (pode ter código de autorização colado) nunca vai para o celular
  if (remote && !(payload && /^ai-login-/.test(String(payload.id || '')))) remote.broadcast(channel, payload);
}

// Mac acordado só enquanto o acesso remoto estiver ligado (decisão de projeto)
function keepAwake(on) {
  if (on && awakeId == null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && awakeId != null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
}

const isClaudeFg = (name) => /^claude$/i.test(name) || /^\d+\.\d+\.\d+$/.test(name);

// o comando /bancada:entrevista (plugin do Claude) sai do app (asar) para uma pasta comum, que o claude consegue ler
function copyPlugin(from, to) {
  try {
    fs.rmSync(to, { recursive: true, force: true });
    const walk = (a, b) => {
      fs.mkdirSync(b, { recursive: true, mode: 0o700 });
      for (const d of fs.readdirSync(a, { withFileTypes: true })) {
        if (d.isDirectory()) walk(path.join(a, d.name), path.join(b, d.name));
        else fs.writeFileSync(path.join(b, d.name), fs.readFileSync(path.join(a, d.name)), { mode: 0o600 });
      }
    };
    walk(from, to);
  } catch (e) { console.error('plugin da Bancada:', e.message); }
}

// ---------- estado do Claude (E1): bolinha na tela + aviso do macOS ----------
function onClaudeState(e) {
  const row = store.getTerminal(e.id);
  const project = row ? store.getProject(row.project_id) : null;
  const payload = { ...e, projectId: project ? project.id : null };
  if ((e.state === 'done' || e.state === 'waiting') && e.transcript) {
    const ctx = contextMeter.measure(e.transcript);
    if (ctx) { payload.ctx = ctx; const s = hooks.get(e.id); if (s) s.ctx = ctx; }
  }
  send('claude:state', payload);
  if (activity) activity.setTerm(e.id, { transcript: e.transcript, state: e.state });
  const watching = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused() && focusedTerm === e.id;
  if (watching || !Notification.isSupported() || !row) return;
  if (e.state === 'waiting' || (e.state === 'done' && e.workedMs >= NOTIFY_DONE_MIN_MS)) {
    const title = `${project ? project.name : 'Bancada'} · ${row.name}`;
    const card = e.state === 'waiting' && asks && asks.list().some(a => a.term === e.id);
    const body = card ? 'Tem um cartão para você responder' : e.state === 'waiting' ? `Esperando você${e.message ? ': ' + translateNotice(e.message) : ''}` : `Terminou (${Math.round(e.workedMs / 60000) || '<1'} min de trabalho)`;
    const n = new Notification({ title, body, silent: e.state === 'done' });
    n.on('click', () => { showMain(); send('ui:goTerminal', { id: e.id, projectId: payload.projectId }); });
    n.show();
  }
}
function translateNotice(m) {
  const perm = /^Claude needs your permission to use (.+)$/.exec(m);
  if (perm) return `quer permissão para usar ${perm[1]}`;
  if (/waiting for your input/i.test(m)) return 'aguardando sua resposta';
  return m.slice(0, 120);
}

// ---------- janelas ----------
function createMain() {
  mainWin = new BrowserWindow({
    width: 1480, height: 920, minWidth: 980, minHeight: 600,
    title: 'Bancada', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0a0c', show: false,
    webPreferences: secureWebPrefs(),
  });
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  mainWin.once('ready-to-show', () => { if (!process.env.BANCADA_HIDDEN) mainWin.show(); });
  mainWin.on('close', (e) => {
    // fechar a janela não mata os terminais: a Bancada continua na bandeja
    if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
}

function createCapture() {
  captureWin = new BrowserWindow({
    width: 620, height: 168, frame: false, resizable: false, show: false, alwaysOnTop: true,
    skipTaskbar: true, transparent: true, vibrancy: 'hud', visualEffectState: 'active',
    webPreferences: secureWebPrefs(),
  });
  captureWin.loadFile(path.join(RENDERER, 'capture.html'));
  captureWin.on('blur', () => { if (captureWin && !captureWin.isDestroyed()) captureWin.hide(); });
}

function toggleCapture() {
  if (!captureWin || captureWin.isDestroyed()) createCapture();
  if (captureWin.isVisible()) { captureWin.hide(); return; }
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt).workArea;
  captureWin.setPosition(Math.round(d.x + (d.width - 620) / 2), Math.round(d.y + d.height * 0.22));
  captureWin.show(); captureWin.focus();
  captureWin.webContents.send('capture:open', { activeProject: projectLabel(activeProjectId) });
}

function projectLabel(id) {
  const p = store.getProject(id) || store.getProject('inbox');
  return { id: p.id, name: p.name };
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMain();
  mainWin.show(); mainWin.focus();
}

function createTray() {
  const iconPath = path.join(RENDERER, 'assets', 'trayTemplate.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Bancada');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir a Bancada', click: showMain },
    { label: 'Anotar (⌥Space)', click: toggleCapture },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

function registerHotkey() {
  const key = store.kvGet('hotkey', HOTKEY_DEFAULT);
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(key, toggleCapture);
  if (!ok) console.warn('[bancada] atalho global indisponível:', key);
  return ok;
}

// Pastas que parecem motor (têm .claude/ ou CLAUDE.md) na pasta de trabalho
function suggestEngines() {
  const known = new Set(store.listEngines().map(e => e.path));
  const out = []; const seen = new Set();
  for (const base of workRoots().slice(1)) {
    let ents = []; try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch {}
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || PROJECT_DIR_NAMES.includes(e.name)) continue;
      const p = path.join(base, e.name);
      if (seen.has(p) || known.has(p)) continue; seen.add(p);
      if (fs.existsSync(path.join(p, '.claude')) || fs.existsSync(path.join(p, 'CLAUDE.md'))) out.push({ path: p, name: path.basename(p) });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

// ---------- captura (D13) ----------
// "#meuapp texto" → projeto cujo nome/alias bate com a tag; sem tag → projeto ativo; senão Inbox.
function routeCapture(text) {
  const m = /^\s*#([\p{L}\p{N}_-]{1,40})\s+([\s\S]+)$/u.exec(text);
  if (m) {
    const tag = slug(m[1]);
    const p = store.listProjects().find(x => slug(x.name) === tag || (x.aliases || []).map(slug).includes(tag));
    if (p) return { project_id: p.id, text: m[2].trim() };
  }
  return { project_id: activeProjectId || 'inbox', text: text.trim() };
}
function slug(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// ---------- IPC ----------
function registerIpc() {
  handle('projects:list', () => store.listProjects());
  handle('projects:create', (p) => { const r = store.createProject(v.projectCreate(p)); reader.reclassifyAll(); summarizer.refreshProject(r.id).catch(() => {}); return r; });
  handle('projects:update', (id, patch) => {
    const pp = v.projectPatch(patch);
    const r = store.updateProject(v.id(id), pp);
    if ('paths' in pp || 'name' in pp || 'aliases' in pp || 'deleted' in pp) { reader.reclassifyAll(); summarizer.refreshProject(r.id).catch(() => {}); }
    return r;
  });
  handle('projects:swapFocus', (parkId, focusId) => store.swapFocus(v.id(parkId), v.id(focusId)));
  handle('projects:discover', () => discoverProjects(projectsDir(), store.listProjects()));
  handle('projects:git', (id) => { const p = store.getProject(v.id(id)); return p && p.paths[0] ? git.status(p.paths[0]) : null; });
  handle('projects:setActive', (id) => { activeProjectId = store.getProject(v.id(id)) ? id : 'inbox'; return true; });

  handle('items:list', (pid, opts) => store.listItems(v.id(pid), { includeArchived: !!(opts && opts.includeArchived) }));
  handle('items:create', (it) => { const r = store.createItem(v.itemCreate(it)); send('data:changed', { kind: 'items', project_id: r.project_id }); return r; });
  handle('items:update', (id, patch) => store.updateItem(v.id(id), v.itemPatch(patch)));
  handle('items:delete', (id) => store.deleteItem(v.id(id)));
  handle('items:today', (date) => store.listToday(v.date(date)));

  handle('terminals:list', (pid) => store.listTerminals(v.id(pid)));
  handle('terminals:save', (t) => store.saveTerminal(v.terminal(t)));
  handle('terminals:remove', (id) => { hooks.reset(v.id(id)); ptys.kill(v.id(id)); store.removeTerminal(v.id(id)); return true; });

  handle('pty:create', (o) => {
    const opts = v.ptyCreate(o);
    const row = store.getTerminal(opts.id);
    // login de uma IA (Ajustes → Assistentes de IA): o comando sai do catálogo; a página só escolhe qual IA
    const login = /^ai-login-([a-z]+)$/.exec(opts.id);
    if (login) {
      if (!AI_IDS.includes(login[1])) throw Object.assign(new Error('IA desconhecida'), { code: 'INVALID' });
      ptys.kill(opts.id);
      return ptys.create({ ...opts, name: `login ${login[1]}`, cwd: ai.home, startup: null, exec: ai.loginExec(login[1]), oneShot: true });
    }
    const project = store.getProject(row ? row.project_id : opts.projectId);
    if (row && project) {
      // terminal salvo: o processo principal decide pasta e comando (motor + foco no projeto); a página não escolhe
      const initialPrompt = initialPrompts.get(row.id) || null; initialPrompts.delete(row.id);
      const spec = launchSpec({ store, terminal: row, project, promptDir: path.join(USER_DIR, 'foco'), hooksSettings: hooks.settingsFile, extraDirs: [ANEXOS_DIR],
        bins: { claude: ai.find('claude'), codex: ai.find('codex'), google: ai.find('google') },
        bridge: { mcpConfig: (tid, pid) => asks.configFor(tid, pid), pluginDir: path.join(USER_DIR, PLUGIN_DIR_NAME) }, initialPrompt });
      if (spec.sessionId) { store.setTerminalSession(row.id, spec.sessionId); store.pinSession(spec.sessionId, project.id, row.id); }
      const r = ptys.create({ ...opts, projectId: project.id, name: row.name, cwd: spec.cwd, startup: spec.command, exec: spec.exec || null });
      return { ...r, warning: spec.warning || null, engine: spec.engine ? spec.engine.name : null };
    }
    return ptys.create({ ...opts, startup: null });
  });
  // entrevista guiada: a próxima abertura deste terminal manda esta 1ª mensagem ao Claude
  handle('terminals:initialPrompt', (id, text) => { const t = v.text(text, 4000); if (!/^\/[A-Za-z0-9:_-]+( |$)/.test(t)) throw Object.assign(new Error('só comando /…'), { code: 'INVALID' }); if (initialPrompts.size >= 50) initialPrompts.clear(); initialPrompts.set(v.id(id), t); return true; });
  // cartões de pergunta (v0.4): Mac e celular respondem; a resposta volta ao Claude que perguntou
  handle('asks:list', () => asks.list());
  handle('asks:answer', (id, payload) => {
    if (JSON.stringify(payload || {}).length > 32 * 1024) throw Object.assign(new Error('resposta grande demais'), { code: 'INVALID' });
    return asks.answer(v.text(id, 200), payload || {});
  });
  handle('asks:dismiss', (id) => asks.dismiss(v.text(id, 200)));
  handle('terminals:newConversation', (id) => { store.setTerminalSession(v.id(id), null); return true; });
  handle('terminals:reorder', (pid, ids) => { store.reorderTerminals(v.id(pid), v.idList(ids, 50)); return true; });
  handle('projects:reorder', (ids) => { store.reorderProjects(v.idList(ids, 200)); return true; });
  handle('items:reorder', (ids) => { store.reorderItems(v.idList(ids, 500)); return true; });

  handle('engines:list', () => engines.list());
  handle('engines:check', () => engines.checkAll());
  handle('engines:details', (id) => engines.details(v.id(id)));
  handle('engines:add', (p) => { const e = store.addEngine({ name: v.text(p.name || path.basename(p.path), 60), path: v.dir(p.path) }); engines.checkAll(); return e; });
  handle('engines:update', (id, p) => { const e = store.updateEngine(v.id(id), { name: p.name != null ? v.text(p.name, 60) : undefined, path: p.path != null ? v.dir(p.path) : undefined }); engines.checkAll(); return e; });
  handle('engines:remove', (id) => { store.removeEngine(v.id(id)); engines.checkAll(); return true; });
  handle('engines:setDefault', (id) => { store.setDefaultEngine(v.id(id)); return true; });
  handle('engines:suggest', () => suggestEngines());
  handle('pty:kill', (id) => { hooks.reset(v.id(id)); return ptys.kill(id); });
  handle('claude:states', () => hooks.list().map(x => {
    const row = store.getTerminal(x.id); const s = hooks.get(x.id);
    return { ...x, projectId: row ? row.project_id : null, ctx: (s && s.ctx) || null };
  }));
  handle('claude:context', (id) => { const s = hooks.get(v.id(id)); if (!s || !s.transcript) return null; s.ctx = contextMeter.measure(s.transcript) || s.ctx || null; return s.ctx; });

  // ---- Arquivos / Mudanças (E2): sempre dentro da pasta do projeto (guarda em files.resolveInside) ----
  const rootOf = (pid, idx) => {
    const p = store.getProject(v.id(pid));
    const i = idx == null ? 0 : v.int(idx, 0, 9);
    const r = p && (p.paths || [])[i];
    if (!r) { const e = new Error('projeto sem pasta'); e.code = 'NO_DIR'; throw e; }
    return r;
  };
  handle('files:roots', (pid) => { const p = store.getProject(v.id(pid)); return p ? (p.paths || []) : []; });
  handle('files:list', (pid, idx, rel) => files.list(rootOf(pid, idx), rel == null ? '' : v.text(rel, 2048)));
  handle('files:read', (pid, idx, rel) => files.read(rootOf(pid, idx), v.text(rel, 2048)));
  handle('files:reveal', (pid, idx, rel) => { shell.showItemInFolder(files.resolveInside(rootOf(pid, idx), v.text(rel, 2048))); return true; });
  handle('files:openInCursor', (pid, idx, rel) => { const abs = files.resolveInside(rootOf(pid, idx), v.text(rel, 2048)); return shell.openExternal(`cursor://file${encodeURI(abs)}`); });
  handle('git:status', (pid, idx) => gitview.status(rootOf(pid, idx)));
  handle('git:diff', (pid, idx, rel) => gitview.diff(rootOf(pid, idx), v.text(rel, 2048)));
  handle('git:commit', (pid, idx, list, msg) => gitview.commit(rootOf(pid, idx), v.strList(list, 500, 2048), v.text(msg, 5000)));

  // ---- imagens no terminal (E4) ----
  const pasteFile = (id, file) => { ptys.paste(id, "'" + file.replace(/'/g, "'\\''") + "' "); return { file }; };
  handle('attach:clipboard', (id) => {
    const img = clipboard.readImage();
    if (img.isEmpty()) { const e = new Error('a área de transferência não tem imagem'); e.code = 'NO_IMAGE'; throw e; }
    return pasteFile(v.id(id), attachments.save(ANEXOS_DIR, img.toPNG()));
  });
  handle('attach:image', (id, o) => pasteFile(v.id(id), attachments.fromBase64(ANEXOS_DIR, o && o.b64)));

  // ---- prévia de localhost (E5) e layout dos painéis (E3) ----
  handle('preview:open', (url) => preview.open(v.text(url, 2048)));

  // ---- Assistentes de IA (BP-2026-11-06-001) ----
  const aiId = (x) => { if (!AI_IDS.includes(x)) throw Object.assign(new Error('IA desconhecida'), { code: 'INVALID' }); return x; };
  handle('ai:installed', () => Object.fromEntries(AI_IDS.map(id => [id, !!ai.find(id)])));   // rápido, sem rede
  handle('ai:status', (id) => (id ? ai.status(aiId(id)) : ai.statusAll()));
  handle('ai:install', (id) => ai.install(aiId(id)));
  handle('ai:update', (id) => ai.update(aiId(id)));
  handle('ai:cancel', () => ai.cancel());
  handle('ai:shellCheck', () => ai.shellCheck());
  handle('ai:fixShell', () => ai.fixShell());
  // leigo: cria ~/Documents/Bancada/Meu primeiro projeto e o projeto na Bancada (em foco se couber)
  handle('ai:firstProject', () => {
    const dir = firstProjectDir(ai.home);
    const had = store.listProjects().find(p => (p.paths || []).includes(dir));
    if (had) return had;
    try { return store.createProject({ name: 'Meu primeiro projeto', kind: 'software', paths: [dir], status: 'focus' }); }
    catch { return store.createProject({ name: 'Meu primeiro projeto', kind: 'software', paths: [dir], status: 'shelf' }); }
  });
  handle('ui:layoutGet', () => store.kvGet('pane_tree', null));
  handle('ui:layoutSet', (tree) => { store.kvSet('pane_tree', v.paneTree(tree)); return true; });
  handle('terminals:byIds', (ids) => v.idList(ids, 8).map(id => store.getTerminal(id)).filter(Boolean));
  handle('activity:list', () => (activity ? activity.list() : {}));
  handle('claude:seen', (id) => { hooks.seen(v.id(id)); return true; });
  handle('ui:focusTerm', (id) => { focusedTerm = id ? v.id(id) : null; if (focusedTerm) hooks.seen(focusedTerm); return true; });
  handle('pty:paste', (id, text) => ptys.paste(v.id(id), v.text(text, 64 * 1024)));
  handle('pty:live', () => ptys.list());
  // escrita e resize em alta frequência: canal sem resposta, mesma checagem de origem
  const ptyWrite = (id, data) => { if (typeof data === 'string' && data.length <= 64 * 1024) ptys.write(String(id), data); };
  const ptyResize = (id, cols, rows) => ptys.resize(String(id), cols, rows);
  handlers.set('pty:write', ptyWrite); handlers.set('pty:resize', ptyResize);
  ipcMain.on('pty:write', (e, id, data) => { if (isOurFrame(e)) ptyWrite(id, data); });
  ipcMain.on('pty:resize', (e, id, cols, rows) => { if (isOurFrame(e)) ptyResize(id, cols, rows); });
  handle('pty:replay', (id) => ptys.replay(v.id(id)));

  // acesso remoto (só Tailscale) — gerenciado só pelo Mac (canais bloqueados no remoto)
  handle('remote:status', () => remote.status());
  handle('remote:enable', () => remote.enable());
  handle('remote:disable', () => remote.disable());
  handle('remote:devices', () => remote.devices());
  handle('remote:revoke', (id) => remote.revoke(v.text(id, 40)));
  handle('remote:pairStart', async () => { const r = remote.pairStart(); return { ...r, qr: await QRCode.toDataURL(r.url, { margin: 1, width: 240 }) }; });

  handle('sessions:forProject', (pid, limit) => reader.forProject(v.id(pid), Math.min(50, (limit | 0) || 10)));
  handle('sessions:unassigned', (limit) => reader.unassigned(Math.min(50, (limit | 0) || 20)));
  handle('sessions:assign', (source, sessionId, pid) => reader.assign(v.text(source, 10), v.text(sessionId, 100), pid ? v.id(pid) : null));
  handle('sessions:rescan', () => reader.scan());
  handle('summary:refresh', (pid) => summarizer.refreshProject(v.id(pid), { force: true }));
  handle('summary:status', () => summarizer.status());

  handle('today:suggest', () => morning.suggest());
  handle('today:set', (ids) => morning.setToday(v.idList(ids)));

  handle('settings:get', () => ({
    hotkey: store.kvGet('hotkey', HOTKEY_DEFAULT),
    focus_limit: store.focusLimit(),
    morning_time: store.kvGet('morning_time', '09:00'),
    ai_summary: store.kvGet('ai_summary', true),
    theme: store.kvGet('theme', 'system'),
    onboarded: store.kvGet('onboarded', false),
    claude_skip_default: store.kvGet('claude_skip_default', false),
    promptpad_available: fs.existsSync(PROMPTPAD_FILE),
  }));
  handle('settings:set', (patch) => {
    const p = v.settings(patch);
    for (const [k, val] of Object.entries(p)) store.kvSet(k, val);
    if ('hotkey' in p) registerHotkey();
    if ('morning_time' in p) morning.schedule();
    return true;
  });
  handle('app:importPromptPad', () => importPromptPad(store, PROMPTPAD_FILE));
  handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:openInCursor', (dir) => { const d = v.dir(dir); return shell.openExternal(`cursor://file${encodeURI(d)}`); });

  handle('capture:submit', ({ text, type }) => {
    const r = routeCapture(v.text(text, 20000));
    const item = store.createItem({ project_id: r.project_id, text: r.text, type: ['note', 'idea', 'prompt', 'reminder'].includes(type) ? type : 'note' });
    send('data:changed', { kind: 'items', project_id: item.project_id });
    return { id: item.id, project: projectLabel(item.project_id) };
  });
  handle('capture:hide', () => { if (captureWin) captureWin.hide(); return true; });
}

// ---------- smoke (só com BANCADA_SMOKE=<pasta>): print da janela + webPreferences reais, depois sai ----------
function smoke(outDir) {
  const steps = (process.env.BANCADA_SMOKE_STEPS || '').split('|||').filter(Boolean);
  mainWin.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const series = []; const t0 = Date.now();
    const sampler = setInterval(() => series.push({ s: Math.round((Date.now() - t0) / 1000), mb: app.getAppMetrics().reduce((a, m) => a + Math.round(m.memory.workingSetSize / 1024), 0), ptys: ptys.count() }), 5000);
    await wait(2500);
    const prefs = mainWin.webContents.getLastWebPreferences();
    const probe = await mainWin.webContents.executeJavaScript(`({ require: typeof require, process: typeof process, bancada: Object.keys(window.bancada || {}).sort(), errors: window.__errors || [] })`);
    fs.writeFileSync(path.join(outDir, 'smoke-security.json'), JSON.stringify({
      contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity, probe }, null, 1));
    let i = 0;
    for (const js of steps) {
      await mainWin.webContents.executeJavaScript(js).catch(e => fs.appendFileSync(path.join(outDir, 'smoke-errors.txt'), String(e) + '\n'));
      await wait(1800);
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `smoke-${++i}.png`), img.toPNG());
    }
    const img = await mainWin.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-final.png'), img.toPNG());
    fs.writeFileSync(path.join(outDir, 'smoke-windows.json'), JSON.stringify(BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), url: w.webContents.getURL().slice(0, 80), visible: w.isVisible() }))));
    for (const w of BrowserWindow.getAllWindows()) if (/^http/.test(w.webContents.getURL())) { try { fs.writeFileSync(path.join(outDir, 'smoke-preview.png'), (await w.webContents.capturePage()).toPNG()); } catch {} }
    fs.writeFileSync(path.join(outDir, 'smoke-log.json'), await mainWin.webContents.executeJavaScript('JSON.stringify({ log: window.__smokeLog || [], errors: window.__errors || [] })').catch(e => JSON.stringify({ err: String(e) })));
    if (process.env.BANCADA_SMOKE_REMOTE) {
      // simula o iPhone: liga o remoto (IP do Tailscale), pareia pelo link do QR e abre a página numa janela 390×844
      const st = await remote.enable();
      fs.writeFileSync(path.join(outDir, 'smoke-remote-status.json'), JSON.stringify(st));
      if (st.running) {
        const { url } = remote.pairStart();
        const phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'smoke-phone' } });
        phone.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
        await phone.loadURL(url);
        await wait(6000);
        fs.writeFileSync(path.join(outDir, 'smoke-phone-1.png'), (await phone.webContents.capturePage()).toPNG());
        for (const js of (process.env.BANCADA_SMOKE_REMOTE_STEPS || '').split('|||').filter(Boolean)) {
          await phone.webContents.executeJavaScript(js).catch(e => fs.appendFileSync(path.join(outDir, 'smoke-errors.txt'), 'phone: ' + e + '\n'));
          await wait(3000);
        }
        fs.writeFileSync(path.join(outDir, 'smoke-phone-2.png'), (await phone.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(outDir, 'smoke-phone-errors.json'), JSON.stringify(await phone.webContents.executeJavaScript('window.__errors || []')));
        phone.destroy();
        // o celular encolheu o pty; o Mac volta a ser usado (foco) e retoma o próprio tamanho
        fs.writeFileSync(path.join(outDir, 'smoke-mac-during-phone.png'), (await mainWin.webContents.capturePage()).toPNG());
        await mainWin.webContents.executeJavaScript('window.dispatchEvent(new Event("focus"))');
        await wait(2500);
        fs.writeFileSync(path.join(outDir, 'smoke-mac-after-phone.png'), (await mainWin.webContents.capturePage()).toPNG());
      }
      remote.disable();
    }
    if (process.env.BANCADA_SMOKE_CAPTURE) {
      toggleCapture(); await wait(800);
      await captureWin.webContents.executeJavaScript(`(() => { const t = document.getElementById('t'); t.value = ${JSON.stringify(process.env.BANCADA_SMOKE_CAPTURE)}; t.dispatchEvent(new Event('input')); })()`);
      await wait(400);
      fs.writeFileSync(path.join(outDir, 'smoke-capture.png'), (await captureWin.webContents.capturePage()).toPNG());
      await captureWin.webContents.executeJavaScript(`document.getElementById('t').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))`);
      await wait(1200);
      fs.writeFileSync(path.join(outDir, 'smoke-capture-result.json'), JSON.stringify(store.listProjects().map(p => ({ name: p.name, items: store.listItems(p.id).map(i => i.text) })).filter(p => p.items.length)));
    }
    clearInterval(sampler); fs.writeFileSync(path.join(outDir, 'smoke-mem-series.json'), JSON.stringify(series));
    fs.writeFileSync(path.join(outDir, 'smoke-mem.json'), JSON.stringify(app.getAppMetrics().map(m => ({ type: m.type, mb: Math.round(m.memory.workingSetSize / 1024) })), null, 1));
    app.isQuitting = true; app.quit();
  });
}

// ---------- ciclo de vida ----------
app.whenReady().then(() => {
  // CSP também por cabeçalho (além da meta tag de cada página)
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  store = open(path.join(USER_DIR, 'bancada.db'));
  fs.mkdirSync(ANEXOS_DIR, { recursive: true, mode: 0o700 });
  hooks = new ClaudeHooks({ dir: path.join(USER_DIR, 'hooks'), onState: onClaudeState });
  hooks.setup(); hooks.start();
  activity = new Activity({ statsFile: path.join(USER_DIR, 'hooks', 'duracoes.json'), onChange: (x) => send('activity:changed', x) }).start();
  copyPlugin(path.join(__dirname, '..', 'plugin'), path.join(USER_DIR, PLUGIN_DIR_NAME));
  try { attachments.cleanup(ANEXOS_DIR); } catch {}
  // BANCADA_AI_HOME: só para teste (instalar numa pasta isolada sem tocar no ~ de verdade)
  ai = new AiTools({ home: process.env.BANCADA_AI_HOME || os.homedir(), onLog: (m) => send('ai:log', m) });
  ptys = new PtyManager({ send, envPath: (p) => ai.envPath(p) });
  asks = new AskBroker({ dir: path.join(USER_DIR, 'perguntas'), store, onChange: (list) => send('asks:changed', list),
    onItems: (pid) => send('data:changed', { kind: 'items', project_id: pid }),
    // a conversa que perguntou morreu: a resposta vai como mensagem (colagem + Enter) — SÓ se o Claude ainda é o programa
    // em primeiro plano. Se o terminal voltou a ser shell, colar + Enter executaria o texto (que traz itens escritos pelo
    // Claude) como comando: pentest 2026-11-06 F-001. Nesse caso não envia nada.
    paste: (id, text) => isClaudeFg(ptys.foreground(id)) && ptys.paste(id, text) && !!setTimeout(() => { if (isClaudeFg(ptys.foreground(id))) ptys.write(id, '\r'); }, 120) }).setup();
  asks.start();
  const resumoDir = path.join(USER_DIR, 'resumo');
  reader = new SessionReader({ store, ignoreCwds: [resumoDir], onChange: (pids) => { send('sessions:changed', { projects: pids }); summarizer.onSessionsChanged(pids); } });
  summarizer = new Summarizer({ store, reader, workDir: resumoDir, onChange: (pid) => send('data:changed', { kind: 'project', project_id: pid }) });
  engines = new EngineWatch({ store, onChange: (id) => send('engines:changed', { id }) });
  engines.checkAll();   // verifica a pasta de cada motor a cada abertura
  remote = new Remote({ store, rendererDir: RENDERER, handlers, keepAwake, port: Number(process.env.BANCADA_REMOTE_PORT) || undefined, onClientsChange: (n) => send('remote:clients', { n }) });
  morning = new Morning({ store, notify: (title, body) => { if (Notification.isSupported()) { const n = new Notification({ title, body }); n.on('click', showMain); n.show(); } } });

  if (process.env.BANCADA_SMOKE) store.kvSet('ai_summary', false);   // smoke nunca gasta IA
  // no modo dev o Dock mostra o ícone do Electron; usa o logo da Bancada
  if (!app.isPackaged && app.dock) { try { app.dock.setIcon(path.join(RENDERER, 'assets', 'bancada-logo.png')); } catch {} }
  registerIpc();
  createMain();
  if (process.env.BANCADA_SMOKE) smoke(process.env.BANCADA_SMOKE);
  createCapture();
  createTray();
  if (!process.env.BANCADA_SMOKE) registerHotkey();
  reader.start();
  morning.start();
  if (store.kvGet('remote_enabled', false)) remote.start().catch(() => {});

  if (app.isPackaged && store.kvGet('login_item', true)) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  app.on('activate', showMain);
  app.on('second-instance', showMain);
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (ptys) ptys.killAll();
  if (reader) reader.stop();
  if (summarizer) summarizer.stop();
  if (morning) morning.stop();
  if (engines) engines.stop();
  if (hooks) hooks.stop();
  if (activity) activity.stop();
  if (asks) asks.stop();
  if (remote) remote.stop();
  if (store) store.close();
});
app.on('window-all-closed', (e) => e.preventDefault());

module.exports = { routeCapture, slug };
