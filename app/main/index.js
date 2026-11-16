// Processo principal da Bancada. Fonte: BLUEPRINT D2 (segurança), D3 (terminais), D12 (bandeja/login), D13 (captura).
'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, dialog, shell, session, screen, Notification, powerSaveBlocker, systemPreferences } = require('electron');
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
const { ProjectPulse } = require('./project-pulse');
const { Servers } = require('./servers');
const { AskBroker } = require('./asks');
const { AiTools, IDS: AI_IDS, firstProjectDir } = require('./ai-tools');
const files = require('./files');
const links = require('./links');
const { execFile } = require('child_process');
const gitview = require('./gitview');
const attachments = require('./attachments');
const contextMeter = require('./context-meter');
const preview = require('./preview');
const { clipboard } = require('electron');
const QRCode = require('qrcode');
const git = require('./git');
const v = require('./validate');
const plat = require('./platform');
const { Log, attachMain, attachRenderer, errText } = require('./log');
const { buildReport } = require('./diagnostic');
const { Feedback } = require('./feedback');
const statusMeter = require('./status');
const { Voice, binPath: whisperBin, buildPrompt } = require('./voice');
const { voiceCheckup, shotCheckup } = require('./checkup');
const { ScreenShot } = require('./screen-shot');
const { Updater, bundleOf } = require('./updater');

const RENDERER = path.join(__dirname, '..', 'renderer');
const USER_DIR = process.env.BANCADA_DATA_DIR || path.join(app.getPath('appData'), 'Bancada');
const PROMPTPAD_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'PromptPad', 'notes.json');
// Pasta de trabalho: ~/Documents e as pastas logo abaixo dela (sem caminho fixo de ninguém). Teto de 60 para não varrer demais.
const PROJECT_DIR_NAMES = ['PROJETOS', 'Projetos', 'Projects', 'projects'];
// Documentos do usuário. No Windows pode estar no OneDrive: o Electron sabe onde. No Mac é sempre ~/Documents (pelo HOME,
// que é o que os testes de "casa limpa" trocam; o app.getPath do Mac ignora o HOME e olharia a pasta real).
function userDir(name, sub) {
  if (plat.IS_WIN) { try { return app.getPath(name); } catch {} }
  return path.join(os.homedir(), sub);
}
function docsDir() { return userDir('documents', 'Documents'); }
function workRoots() {
  const docs = docsDir();
  let ents = []; try { ents = fs.readdirSync(docs, { withFileTypes: true }); } catch {}
  const subs = ents.filter(e => e.isDirectory() && !e.name.startsWith('.') && !PROJECT_DIR_NAMES.includes(e.name)).slice(0, 60).map(e => path.join(docs, e.name));
  return [docs, ...subs];
}
// a pasta PROJETOS/<categoria>/<projeto> que o cadastro inicial lista (a primeira que existir)
function projectsDir() {
  for (const r of workRoots()) for (const n of PROJECT_DIR_NAMES) { const d = path.join(r, n); try { if (fs.statSync(d).isDirectory()) return d; } catch {} }
  return null;
}
// lugares da varredura rasa do cadastro inicial (só pastas com .git): as de código primeiro, Documentos por último
function scanRoots() {
  const home = os.homedir();
  const desk = userDir('desktop', 'Desktop');
  return [
    { dir: path.join(home, 'Developer'), label: 'Developer' }, { dir: path.join(home, 'Projects'), label: 'Projects' },
    { dir: path.join(home, 'source', 'repos'), label: 'repos' }, { dir: path.join(home, 'repos'), label: 'repos' },
    { dir: desk, label: 'Área de Trabalho' }, { dir: docsDir(), label: 'Documentos' },
  ];
}
const HOTKEY_DEFAULT = 'Alt+Space';

// pasta de dados própria (testes) → perfil próprio do Electron, para não colidir com a Bancada aberta
if (process.env.BANCADA_DATA_DIR) app.setPath('userData', path.join(process.env.BANCADA_DATA_DIR, 'electron'));
if (!app.requestSingleInstanceLock()) { app.quit(); }

// v0.8: registro de problemas (logs/bancada.log, 2 × 1 MB) — erros do principal, da tela e dos processos filhos.
// Nunca saída de terminal nem prompt. Cada erro também pode puxar o cartão "Travou?" (feedback.js).
let onLogError = null;
const log = new Log({ dir: path.join(USER_DIR, 'logs'), onError: (line) => { if (onLogError) onLogError(line); } });
attachMain(log, { app, crashReporter: require('electron').crashReporter });

let ai, store, ptys, reader, summarizer, morning, engines, remote, hooks, asks, mainWin, captureWin, tray;
let activity = null;
let pulse = null;
let servers = null;   // v0.6: sala de servidores do Escritório
let feedback = null;  // v0.8: cartões de retorno
let limits = null;    // v0.8: medidor de limite (barra de status do Claude)
let voice = null;     // v0.8: voz → texto (whisper.cpp local, um processo por frase)
let shots = null;     // v0.8: recorte de tela → anexos/ → terminal
let stopAnexosCleanup = null;
let updater = null;   // v0.8: atualização automática (Windows: electron-updater; Mac: nossa, com DR conferido)
const initialPrompts = new Map();   // terminal -> 1ª mensagem do Claude (entrevista guiada); usada uma vez
const PLUGIN_DIR_NAME = 'plugin';
let focusedTerm = null;          // terminal que o usuário está olhando no Mac (para não avisar dele)
const ANEXOS_DIR = path.join(USER_DIR, 'anexos');
const NOTIFY_DONE_MIN_MS = 20000;   // "terminou" só avisa se o Claude trabalhou pelo menos 20 s
let awakeId = null;
const handlers = new Map();   // mesmos handlers do IPC, usados também pelo acesso remoto
let activeProjectId = 'inbox';

// v0.6: link da web clicado na Bancada abre no Safari; sem Safari, cai no navegador padrão
function openInSafari(url) {
  const u = links.httpUrl(url); if (!u) return false;
  if (plat.IS_WIN) { shell.openExternal(u); return true; }   // Windows: navegador padrão
  execFile('/usr/bin/open', ['-a', 'Safari', u], (err) => { if (err) shell.openExternal(u); });
  return true;
}

// ---------- segurança global ----------
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (preview.previews.has(wc)) { preview.onWindowOpen(wc, url); return { action: 'deny' }; }
    if (/^https?:\/\//.test(url)) openInSafari(url);   // links do terminal abrem no Safari (v0.6)
    return { action: 'deny' };
  });
  wc.on('will-navigate', (ev, url) => {
    // a janela de prévia navega só dentro do próprio Mac (loopback); as nossas, só nos nossos arquivos
    if (preview.previews.has(wc)) { if (!preview.allowNavigate(url)) ev.preventDefault(); return; }
    // só as nossas páginas: soltar um .html qualquer na janela trocava a tela por ele
    if (!isOurUrl(url)) ev.preventDefault();
  });
  wc.on('will-redirect', (ev, url) => { if (preview.previews.has(wc) && !preview.allowNavigate(url)) ev.preventDefault(); });
  wc.on('will-attach-webview', ev => ev.preventDefault());
  // erros de console só das nossas páginas (a prévia de localhost é o app do usuário: fica fora do log)
  attachRenderer(log, wc, { allow: () => !preview.previews.has(wc) && isOurUrl(wc.getURL()) });
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

function isOurFrame(event) { return isOurUrl(event.senderFrame && event.senderFrame.url); }
function isOurUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return false;
  // fileURLToPath: no Windows "file:///C:/…/renderer/x.html" vira "C:\…\renderer\x.html" (o pathname cru era "/C:/…" e
  // nunca batia: toda chamada da tela do PC voltava "origem recusada"). Windows sem caixa.
  let p; try { p = require('url').fileURLToPath(url); } catch { return false; }
  const root = path.resolve(RENDERER) + path.sep;
  return plat.IS_WIN ? p.toLowerCase().startsWith(root.toLowerCase()) : p.startsWith(root);
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

// só para a janela do computador (progresso do download da voz, etc.): nunca vai ao celular
function sendLocal(channel, payload) { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload); }

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
  } catch (e) { console.error('plugin da Bancada:', e.message); log.error('main', 'cópia do plugin: ' + errText(e)); }
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
    title: 'Bancada', backgroundColor: '#0a0a0c', show: false,
    // Mac: barra de título embutida (semáforos sobre a tela) · Windows: moldura normal, sem barra de menu
    ...(plat.IS_WIN ? { autoHideMenuBar: true, icon: path.join(RENDERER, 'assets', 'bancada-logo.png') } : { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }),
    webPreferences: secureWebPrefs(),
  });
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  // --hidden: aberto pelo Windows ao ligar o PC (no Mac o openAsHidden faz isso)
  mainWin.once('ready-to-show', () => { if (!process.env.BANCADA_HIDDEN && !process.argv.includes('--hidden')) mainWin.show(); });
  // v0.6: janela escondida/minimizada → a sala de servidores consulta 5× menos
  for (const [ev, v] of [['hide', false], ['minimize', false], ['show', true], ['restore', true]]) mainWin.on(ev, () => { if (servers) servers.setVisible(v); });
  mainWin.on('close', (e) => {
    // fechar a janela não mata os terminais: a Bancada continua na bandeja
    if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
}

function createCapture() {
  captureWin = new BrowserWindow({
    width: 620, height: 168, frame: false, resizable: false, show: false, alwaysOnTop: true,
    skipTaskbar: true,
    // vidro fosco só existe no Mac; no Windows a caixa é opaca
    ...(plat.IS_WIN ? { backgroundColor: '#1c1c22' } : { transparent: true, vibrancy: 'hud', visualEffectState: 'active' }),
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
  // Mac: ícone "molde" preto que o sistema pinta · Windows: o logo colorido (o molde ficaria invisível na barra escura)
  const iconPath = path.join(RENDERER, 'assets', plat.IS_WIN ? 'bancada-logo-128.png' : 'trayTemplate.png');
  let img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (plat.IS_WIN) img = img.resize({ width: 16, height: 16 }); else img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Bancada');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir a Bancada', click: showMain },
    { label: plat.IS_WIN ? 'Anotar (Alt+Espaço)' : 'Anotar (⌥Space)', click: toggleCapture },
    { label: 'Relatar problema…', click: () => { showMain(); mainWin.webContents.send('ui:report', {}); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

function registerHotkey() {
  const key = store.kvGet('hotkey', HOTKEY_DEFAULT);
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(key, toggleCapture);
  if (!ok) { console.warn('[bancada] atalho global indisponível:', key); log.warn('main', `atalho global indisponível: ${key}`); }
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

// ---------- relatar problema (v0.8) ----------
// relatórios de travamento guardados pelo crashReporter (só a contagem; o conteúdo nunca sai daqui)
function crashCount() {
  let n = 0;
  const walk = (d, depth) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (e.isDirectory() && depth < 2) walk(path.join(d, e.name), depth + 1); else if (/\.dmp$/i.test(e.name)) n++; } };
  try { walk(app.getPath('crashDumps'), 0); } catch {}
  return n;
}
const withTimeout = (p, ms, def) => Promise.race([p, new Promise(r => setTimeout(() => r(def), ms))]);
async function diagnostic() {
  const ais = await withTimeout(ai.statusAll().catch(() => null), 20000, null);
  return buildReport({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, release: os.release(), arch: process.arch,
    electron: process.versions.electron, locale: app.getLocale(), uptimeMin: Math.round(process.uptime() / 60), crashes: crashCount(),
    ais, logLines: log.tail(150), feedback: feedback ? feedback.list(20) : [] });
}

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
  handle('projects:discover', () => discoverProjects(projectsDir(), store.listProjects(), scanRoots()));
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
  handle('files:openInCursor', (pid, idx, rel) => { const abs = files.resolveInside(rootOf(pid, idx), v.text(rel, 2048)); return shell.openExternal(plat.cursorUrl(abs)); });
  handle('git:status', (pid, idx) => gitview.status(rootOf(pid, idx)));
  handle('git:diff', (pid, idx, rel) => gitview.diff(rootOf(pid, idx), v.text(rel, 2048)));
  handle('git:commit', (pid, idx, list, msg) => gitview.commit(rootOf(pid, idx), v.strList(list, 500, 2048), v.text(msg, 5000)));

  // ---- imagens no terminal (E4) ----
  const pasteFile = (id, file) => { ptys.paste(id, plat.quotePath(file) + ' '); return { file }; };
  handle('attach:clipboard', (id) => {
    const img = clipboard.readImage();
    if (img.isEmpty()) { const e = new Error('a área de transferência não tem imagem'); e.code = 'NO_IMAGE'; throw e; }
    return pasteFile(v.id(id), attachments.save(ANEXOS_DIR, img.toPNG()));
  });
  handle('attach:image', (id, o) => pasteFile(v.id(id), attachments.fromBase64(ANEXOS_DIR, o && o.b64)));
  // v0.8 recorte de tela (E7): só no computador. O caminho do PNG é gerado aqui; a página só recebe um token + miniatura.
  handle('shot:screen', async (id) => {
    const r = await shots.capture(v.id(id));
    if (r && !plat.IS_WIN) { try { r.perm = systemPreferences.getMediaAccessStatus('screen'); } catch {} }
    return r;
  });
  handle('shot:send', (token) => { const p = shots.take(v.text(token, 64)); return pasteFile(p.termId, p.file); });
  handle('shot:cancel', (token) => shots.discard(v.text(token, 64)));
  handle('shot:abort', () => shots.abort());
  // Checagem: só LÊ a permissão de Gravação de Tela (nunca pede; quem pergunta é o sistema no 1º recorte)
  handle('shot:status', () => { let perm = null; if (!plat.IS_WIN) { try { perm = systemPreferences.getMediaAccessStatus('screen'); } catch {} } return { perm, checkup: shotCheckup(perm, { win: plat.IS_WIN }) }; });

  // ---- voz → texto (v0.8, E6): só no computador (bloqueado no remoto). O texto cai no terminal SEM Enter (D-5). ----
  // estado + permissão do microfone (só lê; quem pergunta é o sistema, na 1ª vez que o 🎤 é usado) + a Checagem pronta
  const voiceStatus = () => {
    const st = voice.status();
    try { st.perm = { mic: systemPreferences.getMediaAccessStatus('microphone') }; } catch { st.perm = {}; }
    st.checkup = voiceCheckup(st, { win: plat.IS_WIN });
    return st;
  };
  // v0.8: atualização (só no computador; o remoto bloqueia o prefixo update:)
  const noUpdater = () => ({ state: 'idle', current: app.getVersion(), auto: store.kvGet('update_auto', true) !== false, lastCheck: 0, platform: process.platform });
  handle('update:status', () => (updater ? updater.status() : noUpdater()));
  handle('update:check', () => (updater ? updater.check({ manual: true }) : noUpdater()));
  handle('update:setAuto', (on) => { if (updater) return updater.setAuto(on === true); store.kvSet('update_auto', on === true); return noUpdater(); });
  handle('voice:status', () => voiceStatus());
  // ajuda fora da Bancada: só endereços fixos daqui (a página escolhe qual, nunca manda o endereço)
  const HELP_URLS = { vc: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    mic: plat.IS_WIN ? 'ms-settings:privacy-microphone' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    ...(plat.IS_WIN ? {} : { screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' }) };
  handle('voice:openHelp', (kind) => { const k = v.text(kind, 10); const u = Object.hasOwn(HELP_URLS, k) ? HELP_URLS[k] : null; if (typeof u !== 'string') throw Object.assign(new Error('ajuda desconhecida'), { code: 'INVALID' }); shell.openExternal(u); return true; });
  handle('voice:download', async () => { const r = await voice.download(); voice.warmup(); return r; });
  handle('voice:cancel', () => voice.cancel());
  handle('voice:setModel', (id) => { const m = v.text(id, 10); voice.setModel(m); store.kvSet('voice_model', m); return voiceStatus(); });
  handle('voice:transcribe', async (id, wav) => {
    const tid = v.id(id);
    if (!(wav instanceof Uint8Array) || wav.length > 2200000) throw Object.assign(new Error('áudio inválido'), { code: 'INVALID' });
    const row = store.getTerminal(tid); const p = row ? store.getProject(row.project_id) : null;
    const pl = p && pulse ? (pulse.list() || {})[p.id] : null;
    const prompt = buildPrompt({ project: p ? p.name : '', dirs: p ? p.paths || [] : [], files: (pl && pl.git && pl.git.files) || [] });
    const r = await voice.transcribe(wav, { prompt });
    const pasted = !!r.text && ptys.paste(tid, r.text + ' ');
    log.info('voz', `${r.seconds.toFixed(1)} s de fala → ${r.ms} ms${r.text ? '' : ' (sem texto)'}`);   // nunca o que foi dito
    return { text: r.text, ms: r.ms, seconds: r.seconds, short: !!r.short, pasted };
  });

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
    const dir = firstProjectDir(ai.home, process.env.BANCADA_AI_HOME ? undefined : docsDir());
    const had = store.listProjects().find(p => (p.paths || []).includes(dir));
    if (had) return had;
    try { return store.createProject({ name: 'Meu primeiro projeto', kind: 'software', paths: [dir], status: 'focus' }); }
    catch { return store.createProject({ name: 'Meu primeiro projeto', kind: 'software', paths: [dir], status: 'shelf' }); }
  });
  handle('ui:layoutGet', () => store.kvGet('pane_tree', null));
  handle('ui:layoutSet', (tree) => { store.kvSet('pane_tree', v.paneTree(tree)); return true; });
  handle('terminals:byIds', (ids) => v.idList(ids, 8).map(id => store.getTerminal(id)).filter(Boolean));
  handle('activity:list', () => (activity ? activity.list() : {}));
  handle('pulse:list', () => (pulse ? pulse.list() : {}));
  // v0.6: links no terminal (caminho de pasta/arquivo .md/arquivo, http). Caminho relativo: pasta do terminal e do projeto.
  handle('links:resolve', (termId, list) => {
    const row = store.getTerminal(v.text(termId, 120)); const p = row ? store.getProject(row.project_id) : null;
    const live = ptys.list().find(t => t.id === termId);
    const bases = [...new Set([live && live.cwd, ...((p && p.paths) || [])].filter(Boolean))];
    return links.resolveMany(Array.isArray(list) ? list.slice(0, 24).map(c => ({ at: Number(c && c.at) || 0, raw: v.text(String((c && c.raw) || ''), 600) })) : [], bases);
  });
  handle('links:readMd', (abs) => links.readMd(v.text(abs, 4096)));
  // pasta abre no Finder; pacote (.app etc.) só é MOSTRADO — abrir executaria o programa (texto do modelo vira clique)
  handle('links:openDir', (abs) => { const a = v.text(abs, 4096); if (links.kindOf(a) !== 'dir') throw new Error('pasta não encontrada'); if (links.isBundle(a)) shell.showItemInFolder(a); else shell.openPath(a); return true; });
  handle('links:reveal', (abs) => { const a = v.text(abs, 4096); if (!links.kindOf(a)) throw new Error('arquivo não encontrado'); shell.showItemInFolder(a); return true; });
  handle('links:openUrl', (url) => openInSafari(v.text(url, 8192)));
  handle('servers:list', () => (servers ? servers.list() : { servers: [], errors: [] }));
  handle('servers:refresh', () => { if (servers) servers.run(); return true; });
  handle('servers:edit', () => { if (servers) shell.openPath(servers.file); return true; });
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
    ai_summary: store.kvGet('ai_summary', false),
    theme: store.kvGet('theme', 'system'),
    onboarded: store.kvGet('onboarded', false),
    claude_skip_default: store.kvGet('claude_skip_default', false),
    mac_perm_notice_ok: store.kvGet('mac_perm_notice_ok', false),
    promptpad_available: fs.existsSync(PROMPTPAD_FILE),
  }));
  handle('settings:set', (patch) => {
    const p = v.settings(patch);
    for (const [k, val] of Object.entries(p)) store.kvSet(k, val);
    if ('ai_summary' in p) store.kvSet('ai_summary_asked', true);   // escolha explícita: o cartão "manter?" não aparece
    if ('hotkey' in p) registerHotkey();
    if ('morning_time' in p) morning.schedule();
    return true;
  });
  handle('app:importPromptPad', () => importPromptPad(store, PROMPTPAD_FILE));
  handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:openInCursor', (dir) => { const d = v.dir(dir); return shell.openExternal(plat.cursorUrl(d)); });

  handle('capture:submit', ({ text, type }) => {
    const r = routeCapture(v.text(text, 20000));
    const item = store.createItem({ project_id: r.project_id, text: r.text, type: ['note', 'idea', 'prompt', 'reminder'].includes(type) ? type : 'note' });
    send('data:changed', { kind: 'items', project_id: item.project_id });
    return { id: item.id, project: projectLabel(item.project_id) };
  });
  handle('capture:hide', () => { if (captureWin) captureWin.hide(); return true; });
  // relatar problema: monta o diagnóstico redigido, copia e devolve para a prévia (só no computador; bloqueado no remoto)
  handle('limits:get', () => (limits ? limits.list() : { accounts: [] }));
  handle('feedback:current', () => (feedback ? feedback.current() : null));
  handle('feedback:answer', (kind, answer, note) => feedback.answer(v.text(kind, 10), v.text(answer, 40), note == null ? '' : v.text(String(note), 1000)));
  handle('feedback:dismiss', (kind) => feedback.dismiss(v.text(kind, 10)));
  handle('diag:report', async () => {
    const text = await diagnostic();
    if (!process.env.BANCADA_SMOKE) clipboard.writeText(text);   // o smoke não mexe na área de transferência de verdade
    log.info('main', 'diagnóstico copiado'); return { text, copied: true };
  });
}

// ---------- smoke (só com BANCADA_SMOKE=<pasta>): print da janela + webPreferences reais, depois sai ----------
function smoke(outDir) {
  // passos grandes (ex.: áudio de teste da voz) vêm de um arquivo; o resto, da variável
  const raw = process.env.BANCADA_SMOKE_STEPS_FILE ? fs.readFileSync(process.env.BANCADA_SMOKE_STEPS_FILE, 'utf8') : (process.env.BANCADA_SMOKE_STEPS || '');
  const steps = raw.split('|||').filter(Boolean);
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
// Windows: o menu padrão do Electron prende Ctrl+R (recarrega a tela), Ctrl+W, Ctrl+C… — atalhos que o terminal precisa
// (Ctrl+C interrompe o Claude, Ctrl+R busca no histórico). Sem menu; copiar/colar fica com o terminal e os campos.
// O id do app é o que faz os avisos do Windows aparecerem (e com o nome certo).
if (plat.IS_WIN) { Menu.setApplicationMenu(null); app.setAppUserModelId('com.mcpp.bancada'); }

app.whenReady().then(() => {
  // CSP também por cabeçalho (além da meta tag de cada página)
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"] } });
  });
  // v0.8: só o microfone (áudio, nada de câmera nem tela) e só para a janela principal da Bancada (nossos arquivos). A
  // prévia de localhost tem sessão própria que nega tudo; o celular não tem microfone (HTTP). No smoke, sempre não.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const types = (details && details.mediaTypes) || [];
    const ok = perm === 'media' && types.length > 0 && types.every(t => t === 'audio') && !process.env.BANCADA_SMOKE &&
      !!mainWin && !mainWin.isDestroyed() && wc === mainWin.webContents && !preview.previews.has(wc) && isOurUrl((details && details.requestingUrl) || wc.getURL());
    if (!ok || plat.IS_WIN) return cb(ok);
    // Mac: na 1ª vez quem pergunta é o sistema (em nome da Bancada, texto do NSMicrophoneUsageDescription); negado antes
    // = não pergunta de novo, e a tela mostra como liberar em Ajustes do Sistema
    const st = systemPreferences.getMediaAccessStatus('microphone');
    if (st === 'granted') return cb(true);
    if (st !== 'not-determined') return cb(false);
    systemPreferences.askForMediaAccess('microphone').then((g) => cb(!!g), () => cb(false));
  });

  fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  log.info('main', `Bancada ${app.getVersion()} aberta · ${process.platform} ${os.release()} ${process.arch} · Electron ${process.versions.electron}${app.isPackaged ? '' : ' · modo dev'}`);
  const dbFile = path.join(USER_DIR, 'bancada.db');
  const dbExisted = fs.existsSync(dbFile);
  store = open(dbFile);
  store.initAiSummary(dbExisted);
  fs.mkdirSync(ANEXOS_DIR, { recursive: true, mode: 0o700 });
  // hooks → atividade: a atividade lê a lista oficial de tarefas e os subagentes que os hooks viram; os hooks não marcam
  // "?" por silêncio enquanto a atividade vê algo em andamento
  // v0.8: medidor de limite — a barra de status do Claude (encadeada com a do usuário) grava os números em hooks/limits
  const statusLine = statusMeter.install({ dir: path.join(USER_DIR, 'hooks') });
  if (!statusLine) log.warn('main', 'medidor de limite desligado: caminho da pasta de dados não serve para a barra de status');
  hooks = new ClaudeHooks({ dir: path.join(USER_DIR, 'hooks'), onState: onClaudeState, onEvent: (id, ev) => { if (activity) activity.poke(id, ev); },
    busy: (id) => !!(activity && activity.busy(id)), extra: () => (statusLine ? { statusLine } : {}) });
  hooks.setup(); hooks.start();
  activity = new Activity({ statsFile: path.join(USER_DIR, 'hooks', 'duracoes.json'), onChange: (x) => send('activity:changed', x), hookInfo: (id) => hooks.get(id) }).start();
  limits = new statusMeter.Limits({ dir: path.join(USER_DIR, 'hooks'), onChange: (x) => send('limits:changed', x) }).start();
  servers = new Servers({ file: path.join(USER_DIR, 'servidores.json'), onChange: (x) => send('servers:changed', x) }).start();
  copyPlugin(path.join(__dirname, '..', 'plugin'), path.join(USER_DIR, PLUGIN_DIR_NAME));
  try { attachments.cleanup(ANEXOS_DIR); } catch {}
  stopAnexosCleanup = attachments.scheduleCleanup(ANEXOS_DIR);   // e a cada 6 h com o app aberto (14 dias)
  shots = new ScreenShot({ win: plat.IS_WIN, exec: execFile, openExternal: (u) => shell.openExternal(u), clipboard,
    save: (buf) => attachments.save(ANEXOS_DIR, buf), reserve: () => attachments.reserve(ANEXOS_DIR), adopt: attachments.adopt,
    thumb: (file) => { if (!attachments.fitsForDecode(file)) return {}; const img = nativeImage.createFromPath(file); const s = img.getSize(); const t = s.width > 640 ? img.resize({ width: 640 }) : img; return { dataUrl: t.toDataURL(), width: s.width, height: s.height }; },
    // smoke: a "captura" é um print da própria janela (nada de seletor do sistema nem área de transferência de verdade)
    smokeImage: process.env.BANCADA_SMOKE ? async () => (await mainWin.webContents.capturePage()).toPNG() : null });
  // voz: binário embutido + modelo em <dados>/voz (baixado sob demanda). Aquecimento em 2º plano (shaders do Metal) se
  // o modelo já existe e o binário é novo; nunca no smoke.
  voice = new Voice({ dir: path.join(USER_DIR, 'voz'), bin: whisperBin({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: path.join(__dirname, '..', '..') }),
    log, model: store.kvGet('voice_model', 'turbo'), appVersion: app.getVersion(), onProgress: (p) => sendLocal('voice:progress', p) }).setup();
  // 45 s depois de abrir: SHA-256 do modelo de novo se o marcador não vale (arquivo mudou ou app atualizado) e aquecimento
  if (!process.env.BANCADA_SMOKE) setTimeout(() => { if (voice.status().model.present) voice.recheck().finally(() => voice.warmup()); }, 45000).unref();
  // BANCADA_AI_HOME: só para teste (instalar numa pasta isolada sem tocar no ~ de verdade)
  ai = new AiTools({ home: process.env.BANCADA_AI_HOME || os.homedir(), onLog: (m) => send('ai:log', m) });
  ptys = new PtyManager({ send, envPath: (p) => ai.envPath(p) });
  // pulso de cada projeto (terminais comuns, servidor local, git, testes, Codex/Google pela saída). Tipo do terminal pelo
  // comando de abertura salvo; terminal sem tipo com Claude de hooks conta como Claude.
  pulse = new ProjectPulse({ ptys,
    kindOf: (id) => { const r = store.getTerminal(id); const st = (r && r.startup) || ''; return /^bancada:codex/.test(st) ? 'codex' : /^bancada:agy/.test(st) ? 'agy' : (/^bancada:claude/.test(st) || hooks.get(id)) ? 'claude' : 'shell'; },
    projectOf: (id) => { const r = store.getTerminal(id); return r ? r.project_id : null; },
    dirOf: (pid) => { const p = store.getProject(pid); return p && p.paths && p.paths[0] ? p.paths[0] : null; },
    git: (dir) => git.status(dir), onChange: (x) => send('pulse:changed', x) }).start();
  asks = new AskBroker({ dir: path.join(USER_DIR, 'perguntas'), store, onChange: (list) => send('asks:changed', list),
    onItems: (pid) => send('data:changed', { kind: 'items', project_id: pid }),
    // a conversa que perguntou morreu: a resposta vai como mensagem (colagem + Enter) — SÓ se o Claude ainda é o programa
    // em primeiro plano. Se o terminal voltou a ser shell, colar + Enter executaria o texto (que traz itens escritos pelo
    // Claude) como comando. Nesse caso não envia nada.
    paste: (id, text) => isClaudeFg(ptys.foreground(id)) && ptys.paste(id, text) && !!setTimeout(() => { if (isClaudeFg(ptys.foreground(id))) ptys.write(id, '\r'); }, 120) }).setup();
  asks.start();
  const resumoDir = path.join(USER_DIR, 'resumo');
  reader = new SessionReader({ store, ignoreCwds: [resumoDir], onChange: (pids) => { send('sessions:changed', { projects: pids }); summarizer.onSessionsChanged(pids); } });
  summarizer = new Summarizer({ store, reader, workDir: resumoDir, onChange: (pid) => send('data:changed', { kind: 'project', project_id: pid }) });
  engines = new EngineWatch({ store, onChange: (id) => send('engines:changed', { id }) });
  engines.checkAll();   // verifica a pasta de cada motor a cada abertura
  remote = new Remote({ store, rendererDir: RENDERER, handlers, keepAwake, port: Number(process.env.BANCADA_REMOTE_PORT) || undefined, onClientsChange: (n) => send('remote:clients', { n }) });
  feedback = new Feedback({ store, busy: () => hooks.list().some(x => x.state === 'working'), onChange: (card) => send('feedback:card', card) });
  onLogError = () => feedback.onError();
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
  if (!process.env.BANCADA_SMOKE || process.env.BANCADA_SMOKE_FEEDBACK) feedback.start();
  if (store.kvGet('remote_enabled', false)) remote.start().catch(() => {});
  // v0.8: atualização — 1× por dia (desligável) + botão nos Ajustes; instala só ao sair. Nunca no smoke nem no modo dev.
  updater = new Updater({ platform: process.platform, kv: { get: (k, d) => store.kvGet(k, d), set: (k, val) => store.kvSet(k, val) },
    currentVersion: app.getVersion(), packaged: app.isPackaged && !process.env.BANCADA_SMOKE, dir: path.join(USER_DIR, 'atualizacao'),
    app: bundleOf(process.execPath), log, onChange: (st) => sendLocal('update:changed', st),
    makeWin: plat.IS_WIN ? () => require('electron-updater').autoUpdater : null });
  updater.start().catch((e) => log.warn('atualização', e.message));

  if (app.isPackaged && store.kvGet('login_item', true)) app.setLoginItemSettings(plat.IS_WIN ? { openAtLogin: true, args: ['--hidden'] } : { openAtLogin: true, openAsHidden: true });
  app.on('activate', showMain);
  app.on('second-instance', showMain);
});

app.on('before-quit', () => { app.isQuitting = true; if (updater) updater.onBeforeQuit(); });   // Windows: instala só o arquivo conferido
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (updater) { updater.onQuit(process.pid); updater.stop(); }
  if (ptys) ptys.killAll();
  if (reader) reader.stop();
  if (summarizer) summarizer.stop();
  if (morning) morning.stop();
  if (feedback) feedback.stop();
  if (voice) voice.shutdown();   // download, transcrição em andamento e o WAV dela
  if (shots) { shots.abort(); shots.dropAll(); }
  if (stopAnexosCleanup) stopAnexosCleanup();
  if (limits) limits.stop();
  if (engines) engines.stop();
  if (hooks) hooks.stop();
  if (activity) activity.stop();
  if (pulse) pulse.stop();
  if (servers) servers.stop();
  if (asks) asks.stop();
  if (remote) remote.stop();
  if (store) store.close();
});
app.on('window-all-closed', (e) => e.preventDefault());

module.exports = { routeCapture, slug };
