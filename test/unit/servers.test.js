'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http'); const net = require('net');
const { Servers, parseTarget, validate, routable, rackState, probeHttp, probeTcp, DEFAULTS } = require('../../app/main/servers');

test('parseTarget: só http(s)/tcp/ping com host e porta válidos; recusa usuário:senha, esquema estranho, injeção', () => {
  assert.deepEqual(parseTarget('tcp:172.16.0.20:22'), { kind: 'tcp', host: '172.16.0.20', port: 22 });
  assert.equal(parseTarget('ping:nas').kind, 'ping');
  assert.equal(parseTarget('https://example.com').port, 443);
  for (const bad of ['file:///etc/passwd', 'ftp://x.com', 'http://user:pw@x.com', 'tcp:x.com:0', 'tcp:x.com:70000', 'ping:-c 9 x', 'ping:x;rm -rf ~', 'tcp:a b:22', 'javascript:alert(1)', 'gopher://x', 42, null, 'x'.repeat(400)])
    assert.equal(parseTarget(bad), null, String(bad).slice(0, 30));
});

test('validate: teto de servidores e luzes, id único e seguro; a lista padrão é só exemplo (repo público: nenhum endereço real)', () => {
  const v = validate(DEFAULTS);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.servers.map(s => s.id), ['exemplo']);
  assert.doesNotMatch(require('fs').readFileSync(require.resolve('../../app/main/servers.js'), 'utf8'), /\b(?:172\.(?:1[6-9]|2\d|3[01])|10|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+\b/, 'sem IP privado/Tailscale no código');
  const big = validate({ servidores: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, checks: Array(20).fill('ping:x.com') })) });
  assert.equal(big.servers.length, 12); assert.equal(big.servers[0].checks.length, 6);
  const dup = validate({ servidores: [{ id: 'a' }, { id: 'a' }, { id: '../x' }, { id: 'b', checks: ['file:///x'] }] });
  assert.deepEqual(dup.servers.map(s => s.id), ['a', 'b']); assert.equal(dup.servers[1].checks.length, 0); assert.equal(dup.errors.length, 3);
});

test('routable: IP privado/Tailscale só se o Mac tem endereço da mesma rede; nome público sempre', () => {
  const escritorio = { en0: [{ family: 'IPv4', address: '172.16.1.5', internal: false }] };
  const casa = { en0: [{ family: 'IPv4', address: '192.168.0.5', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  assert.equal(routable('172.16.0.10', escritorio), true);
  assert.equal(routable('172.16.0.10', casa), false, 'fora do escritório = cinza');
  assert.equal(routable('100.100.1.2', casa), false, 'Tailscale desligado = cinza');
  assert.equal(routable('100.100.1.2', { utun4: [{ family: 'IPv4', address: '100.100.9.9', internal: false }] }), true);
  assert.equal(routable('example.com', casa), true);
});

test('rackState: pior luz manda; tudo cinza = cinza; sem luz = configurar', () => {
  assert.equal(rackState([]), 'configurar');
  assert.equal(rackState([{ st: 'ok' }, { st: 'lento' }]), 'lento');
  assert.equal(rackState([{ st: 'ok' }, { st: 'fora' }]), 'fora');
  assert.equal(rackState([{ st: 'sem-rota' }, { st: 'sem-rota' }]), 'sem-rota');
  assert.equal(rackState([{ st: 'sem-rota' }, { st: 'ok' }]), 'ok');
  assert.equal(rackState([{ st: 'esperando' }]), 'esperando');
});

test('os 4 estados com servidores falsos em 127.0.0.1 (http 200, http 503, lento, porta fechada)', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => { res.writeHead(200); res.end('x'); }, 900);
    res.writeHead(req.url === '/down' ? 503 : 200); res.end('corpo que não é lido');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const tcp = net.createServer(() => {}); await new Promise(r => tcp.listen(0, '127.0.0.1', r));
  const closed = tcp.address().port + 0; // vamos fechar este e usar como porta morta
  try {
    assert.equal((await probeHttp(parseTarget(`http://127.0.0.1:${port}/ok`))).st, 'ok');
    const d = await probeHttp(parseTarget(`http://127.0.0.1:${port}/down`)); assert.equal(d.st, 'lento'); assert.equal(d.code, 503);
    assert.equal((await probeHttp(parseTarget(`http://127.0.0.1:${port}/slow`))).st, 'lento');
    assert.equal((await probeTcp(parseTarget(`tcp:127.0.0.1:${closed}`))).st, 'ok');
    await new Promise(r => tcp.close(r));
    assert.equal((await probeTcp(parseTarget(`tcp:127.0.0.1:${closed}`))).st, 'fora');
    const to = await probeHttp(parseTarget(`http://127.0.0.1:${port}/slow`), 200); assert.equal(to.st, 'fora'); assert.equal(to.err, 'tempo esgotado');
  } finally { srv.close(); }
});

test('Servers: cria servidores.json 0600 com o padrão, guarda 30 medidas, não empilha consulta lenta, relê o arquivo editado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const file = path.join(dir, 'servidores.json');
  let calls = 0; let release = null;
  const s = new Servers({ file, probeFn: async () => { calls++; if (release === 'hold') await new Promise(r => { release = r; }); return { st: 'ok', ms: 12 }; } });
  s.load();
  assert.equal(s.list().servers[0].st, 'configurar', 'exemplo sem endereço');
  fs.writeFileSync(file, JSON.stringify({ servidores: [{ id: 'nas', checks: ['tcp:nas.local:22'] }, { id: 'site', checks: ['https://example.com', 'ping:example.org'] }, { id: 'vazio' }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (let i = 0; i < 35; i++) await s.run();
  const l = s.list();
  assert.equal(l.servers.find(x => x.id === 'nas').lights[0].hist.length, 30);
  assert.equal(l.servers.find(x => x.id === 'vazio').st, 'configurar');
  assert.equal(l.servers.find(x => x.id === 'site').st, 'ok');
  // consulta presa: a próxima rodada não dispara outra para o mesmo alvo
  fs.writeFileSync(file, JSON.stringify({ servidores: [{ id: 'um', checks: ['ping:um.com'] }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 9000));
  release = 'hold'; calls = 0;
  const p1 = s.run(); await new Promise(r => setTimeout(r, 20));
  const p2 = s.run(); await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 1, 'não empilha');
  release(); await p1; await p2;
  assert.deepEqual(s.list().servers.map(x => x.id), ['um'], 'arquivo editado vale na próxima rodada');
});
