// Ponte mínima entre a tela e o processo principal (contextBridge). Só esta lista existe para a página.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => async (...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  // o contextBridge apaga propriedades extras do Error: o código vai no começo da mensagem, "[CODIGO] texto"
  if (!r || !r.ok) throw new Error(`[${(r && r.code) || 'ERR'}] ${(r && r.error) || 'falha'}`);
  return r.data;
};

// Um único listener por canal no preload; a página registra callbacks aqui (sem vazar ipcRenderer).
const subs = {};
function on(channel) {
  if (!subs[channel]) {
    subs[channel] = new Set();
    ipcRenderer.on(channel, (_e, payload) => { for (const fn of subs[channel]) { try { fn(payload); } catch (err) { console.error(err); } } });
  }
  return (fn) => { subs[channel].add(fn); return () => subs[channel].delete(fn); };
}

contextBridge.exposeInMainWorld('bancada', {
  projects: {
    list: call('projects:list'), create: call('projects:create'), update: call('projects:update'),
    swapFocus: call('projects:swapFocus'), discover: call('projects:discover'), git: call('projects:git'),
    setActive: call('projects:setActive'), reorder: call('projects:reorder'),
  },
  items: {
    list: call('items:list'), create: call('items:create'), update: call('items:update'),
    remove: call('items:delete'), today: call('items:today'), reorder: call('items:reorder'),
  },
  terminals: { byIds: call('terminals:byIds'), list: call('terminals:list'), save: call('terminals:save'), remove: call('terminals:remove'), newConversation: call('terminals:newConversation'), initialPrompt: call('terminals:initialPrompt'), reorder: call('terminals:reorder') },
  engines: { list: call('engines:list'), check: call('engines:check'), details: call('engines:details'), add: call('engines:add'), update: call('engines:update'),
    remove: call('engines:remove'), setDefault: call('engines:setDefault'), suggest: call('engines:suggest'), onChanged: on('engines:changed') },
  pty: {
    create: call('pty:create'), kill: call('pty:kill'), paste: call('pty:paste'), live: call('pty:live'), replay: call('pty:replay'),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    onData: on('pty:data'), onExit: on('pty:exit'), onSize: on('pty:size'), onUrl: on('pty:url'),
  },
  sessions: {
    forProject: call('sessions:forProject'), unassigned: call('sessions:unassigned'),
    assign: call('sessions:assign'), rescan: call('sessions:rescan'), onChanged: on('sessions:changed'),
  },
  summary: { refresh: call('summary:refresh'), status: call('summary:status') },
  today: { suggest: call('today:suggest'), set: call('today:set') },
  settings: { get: call('settings:get'), set: call('settings:set') },
  app: { importPromptPad: call('app:importPromptPad'), pickFolder: call('app:pickFolder'), openInCursor: call('app:openInCursor') },
  capture: { submit: call('capture:submit'), hide: call('capture:hide'), onOpen: on('capture:open') },
  remote: { status: call('remote:status'), enable: call('remote:enable'), disable: call('remote:disable'), devices: call('remote:devices'),
    revoke: call('remote:revoke'), pairStart: call('remote:pairStart'), onClients: on('remote:clients') },
  asks: { list: call('asks:list'), answer: call('asks:answer'), dismiss: call('asks:dismiss'), onChanged: on('asks:changed') },
  claude: { states: call('claude:states'), seen: call('claude:seen'), context: call('claude:context'), onState: on('claude:state') },
  ui: { focusTerm: call('ui:focusTerm'), onGoTerminal: on('ui:goTerminal'), layoutGet: call('ui:layoutGet'), layoutSet: call('ui:layoutSet') },
  files: { roots: call('files:roots'), list: call('files:list'), read: call('files:read'), reveal: call('files:reveal'), openInCursor: call('files:openInCursor'),
    // caminho de um arquivo solto do Finder (o Electron não expõe mais File.path)
    pathFor: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } } },
  git: { status: call('git:status'), diff: call('git:diff'), commit: call('git:commit') },
  attach: { clipboard: call('attach:clipboard'), image: call('attach:image') },
  preview: { open: call('preview:open') },
  ai: { installed: call('ai:installed'), status: call('ai:status'), install: call('ai:install'), update: call('ai:update'), cancel: call('ai:cancel'),
    shellCheck: call('ai:shellCheck'), fixShell: call('ai:fixShell'), firstProject: call('ai:firstProject'), onLog: on('ai:log') },
  onDataChanged: on('data:changed'),
  onMorning: on('morning:open'),
});
