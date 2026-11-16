'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { open } = require('../../app/main/db');
const { Remote, tailscaleIp } = require('../../app/main/remote');

const RENDERER = path.join(__dirname, '..', '..', 'app', 'renderer');
const PORT = 18791;

function req(method, p, { host, origin, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { host: host || `127.0.0.1:${PORT}`, ...(origin ? { origin } : {}), 'content-type': 'application/json' } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers })); });
    if (body) r.write(JSON.stringify(body)); r.end();
  });
}
function wsConnect(token, origin = `http://127.0.0.1:${PORT}`) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, token ? [`bancada.${token}`] : [], { origin, headers: { host: `127.0.0.1:${PORT}` } });
    ws.on('open', () => resolve({ ws, ok: true }));
    ws.on('unexpected-response', (_r, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false, status: 0 }));
  });
}
function rpc(ws, ch, args = []) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    const on = (d) => { const m = JSON.parse(d); if (m.id === id) { ws.off('message', on); resolve(m); } };
    ws.on('message', on); ws.send(JSON.stringify({ id, ch, args }));
  });
}

test('acesso remoto: Host/Origin, pareamento de uso único, token, canais bloqueados, revogação', async () => {
  const store = open(':memory:');
  const handlers = new Map([['projects:list', () => store.listProjects()], ['app:pickFolder', () => '/etc']]);
  let awake = null;
  const r = new Remote({ store, rendererDir: RENDERER, handlers, port: PORT, ipProvider: () => '127.0.0.1', keepAwake: (on) => { awake = on; } });
  const st = await r.start();
  assert.equal(st.running, true); assert.equal(awake, true, 'Mac fica acordado com o remoto ligado');

  // página servida com a ponte remota e cabeçalhos de segurança; Host errado (DNS rebinding) recusado
  const page = await req('GET', '/');
  assert.equal(page.status, 200); assert.match(page.body, /remote-bridge\.js/); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await req('GET', '/', { host: 'evil.com' })).status, 421);
  assert.equal((await req('GET', '/../main/remote.js')).status, 404, 'só a lista fechada de arquivos');
  assert.equal((await req('GET', '/app/main/db.js')).status, 404);

  // pareamento
  assert.equal((await req('POST', '/pair', { body: { code: 'x' } })).status, 401, 'sem QR aberto');
  const { url } = r.pairStart();
  const code = url.split('#pair=')[1];
  assert.equal((await req('POST', '/pair', { body: { code: 'errado' } })).status, 401);
  assert.equal((await req('POST', '/pair', { origin: 'http://evil.com', body: { code } })).status, 403);
  const ok = await req('POST', '/pair', { body: { code, name: 'iPhone' } });
  assert.equal(ok.status, 200);
  const { token } = JSON.parse(ok.body);
  assert.equal((await req('POST', '/pair', { body: { code } })).status, 401, 'código é de uso único');
  assert.ok(!store.db.prepare('SELECT * FROM remote_devices').get().token_hash.includes(token), 'token só como hash');

  // websocket
  assert.equal((await wsConnect(null)).status, 401);
  assert.equal((await wsConnect('inventado')).status, 401);
  assert.equal((await wsConnect(token, 'http://evil.com')).status, 403, 'Origin errado (CSWSH)');
  const c = await wsConnect(token);
  assert.ok(c.ok);
  const list = await rpc(c.ws, 'projects:list');
  assert.equal(list.ok, true); assert.ok(Array.isArray(list.data));
  const blocked = await rpc(c.ws, 'app:pickFolder');
  assert.equal(blocked.code, 'REMOTE_BLOCKED');
  assert.equal((await rpc(c.ws, 'remote:pairStart')).code, 'REMOTE_BLOCKED', 'celular não pareia outro aparelho');
  // v0.8: voz e recorte de tela só no computador — inclusive um canal da família que não está na lista
  for (const ch of ['voice:transcribe', 'voice:download', 'shot:screen', 'shot:send', 'voice:qualquer-novo']) assert.equal((await rpc(c.ws, ch)).code, 'REMOTE_BLOCKED', ch);

  // eventos chegam ao celular
  const got = new Promise((res) => c.ws.on('message', (d) => { const m = JSON.parse(d); if (m.ev === 'pty:data') res(m.payload); }));
  r.broadcast('pty:data', { id: 't1', data: 'ola' });
  assert.deepEqual(await got, { id: 't1', data: 'ola' });

  // revogar derruba a conexão e o token deixa de valer
  const closed = new Promise((res) => c.ws.on('close', (code2) => res(code2)));
  r.revoke(r.devices()[0].id);
  assert.equal(await closed, 4001);
  assert.equal((await wsConnect(token)).status, 401);

  r.stop();
  assert.equal(awake, false, 'desligou o remoto → Mac pode dormir');
});

test('desligar o remoto corta na hora: o que chega depois não é atendido e o socket é encerrado', async () => {
  const store = open(':memory:');
  let writes = 0;
  const handlers = new Map([['pty:write', () => { writes++; }], ['projects:list', () => []]]);
  const r = new Remote({ store, rendererDir: RENDERER, handlers, port: PORT + 2, ipProvider: () => '127.0.0.1' });
  await r.start();
  const { url } = r.pairStart();
  const pr = await new Promise((resolve) => {
    const q = http.request({ host: '127.0.0.1', port: PORT + 2, method: 'POST', path: '/pair', headers: { host: `127.0.0.1:${PORT + 2}`, 'content-type': 'application/json' } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    q.end(JSON.stringify({ code: url.split('#pair=')[1], name: 'teste' }));
  });
  const ws = await new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${PORT + 2}/ws`, [`bancada.${pr.token}`], { origin: `http://127.0.0.1:${PORT + 2}`, headers: { host: `127.0.0.1:${PORT + 2}` } }); w.on('open', () => resolve(w)); });
  ws.send(JSON.stringify({ ch: 'pty:write', args: ['t1', 'a'] }));
  await new Promise(res => setTimeout(res, 100)); assert.equal(writes, 1, 'antes de desligar: atendido');
  const server = [...r.clients][0];
  let terminated = false; const orig = server.ws.terminate.bind(server.ws); server.ws.terminate = () => { terminated = true; orig(); };
  r.stop();
  ws.send(JSON.stringify({ ch: 'pty:write', args: ['t1', 'b'] }));   // já em voo quando o remoto desliga
  r.onMessage(server, JSON.stringify({ ch: 'pty:write', args: ['t1', 'c'] }));   // cliente que ignora o fechamento
  await new Promise(res => setTimeout(res, 1300));
  assert.equal(writes, 1, 'depois de desligar: nada atendido');
  assert.equal(server.revoked, true); assert.equal(terminated, true, 'socket encerrado à força depois do fechamento');
});

test('todo canal do index.js está classificado: liberado ao celular (REMOTE_OK) ou bloqueado (BLOCKED) — nunca os dois, nunca nenhum', () => {
  const { BLOCKED, BLOCKED_PREFIX, REMOTE_OK } = require('../../app/main/remote');
  const src = require('fs').readFileSync(path.join(__dirname, '../../app/main/index.js'), 'utf8');
  const chans = new Set([...src.matchAll(/\bhandle\('([^']+)'/g), ...src.matchAll(/ipcMain\.on\('([^']+)'/g)].map(m => m[1]));
  assert.ok(chans.size > 100, `achou ${chans.size} canais`);
  const blocked = (c) => BLOCKED.has(c) || BLOCKED_PREFIX.test(c);
  const none = [...chans].filter(c => !blocked(c) && !REMOTE_OK.has(c));
  const both = [...chans].filter(c => blocked(c) && REMOTE_OK.has(c));
  assert.deepEqual(none, [], 'canal novo sem decisão: ponha em REMOTE_OK ou BLOCKED (remote.js)');
  assert.deepEqual(both, [], 'canal nas duas listas');
  const stale = [...REMOTE_OK].filter(c => !chans.has(c));
  assert.deepEqual(stale, [], 'REMOTE_OK com canal que não existe mais');
});

test('canal fora da lista de liberação é recusado no celular mesmo existindo no computador', async () => {
  const store = open(':memory:');
  const r = new Remote({ store, rendererDir: RENDERER, handlers: new Map([['novo:canal', () => 'segredo']]), port: PORT + 3, ipProvider: () => '127.0.0.1' });
  const sent = [];
  await r.onMessage({ ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) } }, JSON.stringify({ id: 1, ch: 'novo:canal', args: [] }));
  assert.equal(sent[0].code, 'REMOTE_BLOCKED');
});

test('sem Tailscale o remoto não sobe (nunca cai para a LAN)', async () => {
  const store = open(':memory:');
  const r = new Remote({ store, rendererDir: RENDERER, handlers: new Map(), port: PORT + 1, ipProvider: () => null });
  const st = await r.start();
  assert.equal(st.running, false); assert.match(st.error, /Tailscale/);
  r.stop();
});

test('tailscaleIp só aceita a faixa 100.64.0.0/10', () => {
  const ip = tailscaleIp();
  if (ip) { const [a, b] = ip.split('.').map(Number); assert.equal(a, 100); assert.ok(b >= 64 && b <= 127); }
});

test('v0.2: no celular ficam bloqueados Finder, Cursor, área de transferência do Mac, prévia de localhost, layout e foco', () => {
  const { BLOCKED } = require('../../app/main/remote');
  for (const ch of ['files:reveal', 'files:openInCursor', 'attach:clipboard', 'preview:open', 'ui:layoutSet', 'ui:focusTerm', 'servers:refresh', 'servers:edit', 'links:openDir', 'links:reveal', 'links:openUrl']) assert.ok(BLOCKED.has(ch), ch);
  for (const ch of ['files:list', 'files:read', 'git:status', 'git:diff', 'attach:image', 'claude:states']) assert.ok(!BLOCKED.has(ch), ch);
});

test('v0.2: arquivos estáticos novos (layout.js, files-panel.js) estão na lista fechada', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../app/main/remote.js'), 'utf8');
  assert.match(src, /'\/layout\.js': 'layout\.js'/); assert.match(src, /'\/files-panel\.js': 'files-panel\.js'/);
});

test('celular não abre, não vê e não digita no terminal de login das IAs; instalar/consertar bloqueados', () => {
  const { BLOCKED, isLoginTerm } = require('../../app/main/remote');
  for (const ch of ['ai:install', 'ai:update', 'ai:fixShell', 'ai:shellCheck', 'ai:firstProject', 'ai:cancel']) assert.ok(BLOCKED.has(ch), ch);
  assert.ok(!BLOCKED.has('ai:status'));
  assert.ok(isLoginTerm({ ch: 'pty:create', args: [{ id: 'ai-login-claude' }] }));
  assert.ok(isLoginTerm({ ch: 'pty:write', args: ['ai-login-google', 'x'] }));
  assert.ok(isLoginTerm({ ch: 'pty:replay', args: ['ai-login-codex'] }));
  assert.ok(!isLoginTerm({ ch: 'pty:write', args: ['abc', 'x'] }));
  assert.ok(!isLoginTerm({ ch: 'ai:status', args: ['ai-login-x'] }));
});

test('v0.8: voz e recorte de tela bloqueados no celular; a foto do celular continua pelo attach:image', () => {
  const { BLOCKED, BLOCKED_PREFIX } = require('../../app/main/remote');
  for (const ch of ['voice:status', 'voice:download', 'voice:cancel', 'voice:setModel', 'voice:transcribe', 'shot:screen', 'shot:send', 'shot:cancel']) assert.ok(BLOCKED.has(ch), ch);
  assert.ok(BLOCKED_PREFIX.test('voice:x') && BLOCKED_PREFIX.test('shot:y') && !BLOCKED_PREFIX.test('attach:image'));
  assert.ok(!BLOCKED.has('attach:image'));
});
