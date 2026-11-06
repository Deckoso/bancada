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
  for (const ch of ['files:reveal', 'files:openInCursor', 'attach:clipboard', 'preview:open', 'ui:layoutSet', 'ui:focusTerm']) assert.ok(BLOCKED.has(ch), ch);
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
