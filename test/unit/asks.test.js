'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { open } = require('../../app/main/db');
const { AskBroker, normLista, normPerguntar } = require('../../app/main/asks');

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asks dir-'));
  const store = open(path.join(dir, 'b.db'));
  const p = store.createProject({ name: 'Proj', paths: [dir] });
  store.saveTerminal({ id: 'tA1', project_id: p.id, name: 'Claude', startup: 'bancada:claude' }); const t = store.getTerminal('tA1');
  const changes = []; const pasted = [];
  const broker = new AskBroker({ dir: path.join(dir, 'ask'), store, onChange: (l) => changes.push(l), paste: (id, txt) => { pasted.push([id, txt]); return !global.__noClaude; } }).setup();
  return { dir, store, p, t, broker, changes, pasted };
}

// servidor MCP de verdade, no mesmo binário (Electron em modo node), falando JSON-RPC por linha
function server(broker, termId, projectId) {
  const cfg = JSON.parse(fs.readFileSync(broker.configFor(termId, projectId), 'utf8')).mcpServers.bancada;
  const proc = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; const waiting = new Map(); let n = 0;
  proc.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
  });
  const rpc = (method, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { proc, rpc, notify: (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'), lastId: () => n };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } throw new Error('tempo esgotado'); };

test('config MCP por terminal: roda no binário da Bancada em modo node, com o id do terminal', () => {
  const { broker, t, p } = mk();
  const c = JSON.parse(fs.readFileSync(broker.configFor(t.id, p.id), 'utf8')).mcpServers.bancada;
  assert.equal(c.command, process.execPath);
  assert.equal(c.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(c.env.BANCADA_TERM_ID, t.id);
  assert.ok(fs.existsSync(c.args[0]));
  assert.equal(fs.statSync(broker.dir).mode & 0o777, 0o700);
});

test('normaliza e corta pedidos', () => {
  const l = normLista({ titulo: 'x', itens: ['a', { texto: 'b', detalhe: 'd' }, { texto: '' }] });
  assert.deepEqual(l.opcoes, ['Já fiz', 'Adiar', 'Fazer agora']); assert.equal(l.itens.length, 2);
  assert.throws(() => normLista({ itens: [] }), /sem itens/);
  assert.equal(normLista({ itens: Array(50).fill('z') }).itens.length, 30);
  const q = normPerguntar({ pergunta: 'Qual?', opcoes: ['A'], multipla: true });
  assert.equal(q.multipla, false, 'multipla só com 2+ opções'); assert.equal(q.texto_livre, true);
  assert.throws(() => normPerguntar({ pergunta: '  ' }), /vazia/);
});

test('CP-1/CP-3: lista ponta a ponta — Claude pergunta, usuário marca, Adiar vira pendência', async () => {
  const { broker, t, p, store } = mk();
  const s = server(broker, t.id, p.id);
  try {
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } });
    assert.equal(init.result.serverInfo.name, 'bancada');
    const tl = await s.rpc('tools/list', {});
    assert.deepEqual(tl.result.tools.map(x => x.name), ['lista', 'perguntar', 'pendencias']);
    const call = s.rpc('tools/call', { name: 'lista', arguments: { titulo: 'O que resta', itens: [{ texto: 'Conectar o Google' }, { texto: 'Conta Apple', detalhe: 'US$ 99' }, { texto: 'Pentest' }] } });
    const ask = await until(() => { broker.scan(); return broker.list()[0]; });
    assert.equal(ask.kind, 'lista'); assert.equal(ask.term, t.id); assert.equal(ask.project, p.id);
    broker.answer(ask.id, { escolhas: [{ opcao: 0 }, { opcao: 1, nota: 'depois do leigo' }, { opcao: 2 }] });
    const r = await call;
    const txt = r.result.content[0].text;
    assert.match(txt, /1\. \[Já fiz\] Conectar o Google/);
    assert.match(txt, /2\. \[Adiar\] Conta Apple \(nota: depois do leigo\)/);
    assert.match(txt, /3\. \[Fazer agora\] Pentest/);
    assert.match(txt, /1 item\(ns\) adiado/);
    const pend = store.listItems(p.id).filter(i => i.type === 'pending');
    assert.equal(pend.length, 1); assert.match(pend[0].text, /^Conta Apple — US\$ 99 \(nota: depois do leigo\)$/);
    // o arquivo respondido não volta como cartão novo
    await new Promise(r2 => setTimeout(r2, 400)); broker.scan(); assert.equal(broker.list().length, 0);
    // pendencias: responde na hora, sem cartão (com a Bancada vigiando a pasta, como no app)
    broker.start();
    const ls = await s.rpc('tools/call', { name: 'pendencias', arguments: { acao: 'listar' } });
    assert.match(ls.result.content[0].text, /Pendências do projeto \(1\):\n#1 Conta Apple/);
    const ok = await s.rpc('tools/call', { name: 'pendencias', arguments: { acao: 'concluir', itens: ['#1'] } });
    assert.match(ok.result.content[0].text, /1 pendência\(s\) concluída/);
    const ls2 = await s.rpc('tools/call', { name: 'pendencias', arguments: { acao: 'listar' } });
    assert.match(ls2.result.content[0].text, /nenhuma pendência/);
  } finally { broker.stop(); s.proc.kill(); }
});

test('perguntar: opções, texto, pular, chega; Esc (cancelado) tira o cartão', async () => {
  const { broker, t, p } = mk();
  const s = server(broker, t.id, p.id);
  try {
    await s.rpc('initialize', {});
    const c1 = s.rpc('tools/call', { name: 'perguntar', arguments: { pergunta: 'Qual setor?', opcoes: [{ rotulo: 'Almoxarifado' }, { rotulo: 'Frota' }], multipla: true, resumo: 'LOJA-APP' } });
    let a = await until(() => { broker.scan(); return broker.list()[0]; });
    assert.equal(a.args.resumo, 'LOJA-APP');
    broker.answer(a.id, { escolhas: [0, 1, 1, 9], texto: 'uso interno e externo' });
    assert.equal((await c1).result.content[0].text, 'Resposta: Almoxarifado; Frota\nE escreveu: uso interno e externo');
    const c2 = s.rpc('tools/call', { name: 'perguntar', arguments: { pergunta: 'E agora?' } });
    a = await until(() => { broker.scan(); return broker.list()[0]; });
    broker.answer(a.id, { acao: 'chega' });
    assert.match((await c2).result.content[0].text, /^CHEGA/);
    // cancelamento (Esc no Claude): o servidor apaga o pedido e o cartão some
    s.rpc('tools/call', { name: 'perguntar', arguments: { pergunta: 'vai ser cancelada' } });
    const id = s.lastId();
    await until(() => { broker.scan(); return broker.list()[0]; });
    s.notify('notifications/cancelled', { requestId: id });
    await until(() => { broker.scan(); return broker.list().length === 0; });
    assert.throws(() => broker.answer('nada.1-1.json', {}), /já foi respondido/);
  } finally { s.proc.kill(); }
});

test('conversa morreu: a resposta é colada no terminal', async () => {
  const { broker, t, p, pasted } = mk();
  const s = server(broker, t.id, p.id);
  await s.rpc('initialize', {});
  s.rpc('tools/call', { name: 'perguntar', arguments: { pergunta: 'Q?', opcoes: ['Sim', 'Não'] } });
  const a = await until(() => { broker.scan(); return broker.list()[0]; });
  // o Claude morreu sem fechar o stdin direito (kill -9): o pedido fica, o processo não
  s.proc.kill('SIGKILL');
  await until(() => { broker.scan(); return broker.list()[0] && broker.list()[0].orphan; });
  broker.answer(a.id, { escolhas: [1] });
  assert.deepEqual(pasted, [[t.id, 'Resposta: Não']]);
});

test('F-001: conversa morreu e o terminal virou shell → nada é enviado e a tela é avisada', async () => {
  const { broker, t, p } = mk();
  const s = server(broker, t.id, p.id);
  await s.rpc('initialize', {});
  s.rpc('tools/call', { name: 'lista', arguments: { titulo: 'x', itens: ['limpar $(touch /tmp/isca) cache'] } });
  const a = await until(() => { broker.scan(); return broker.list()[0]; });
  s.proc.kill('SIGKILL');
  await until(() => { broker.scan(); return broker.list()[0] && broker.list()[0].orphan; });
  global.__noClaude = true;
  try { assert.throws(() => broker.answer(a.id, { escolhas: [{ opcao: 0 }] }), (e) => e.code === 'NO_CLAUDE'); }
  finally { global.__noClaude = false; }
  assert.equal(broker.list().length, 0);
});

test('pedido forjado (id do terminal no nome ≠ no conteúdo) é ignorado', () => {
  const { broker } = mk();
  fs.writeFileSync(path.join(broker.asksDir, 'tX.123-1.json'), JSON.stringify({ kind: 'perguntar', term: 'tY', pid: 123, args: { pergunta: 'x' } }));
  broker.scan();
  assert.equal(broker.list().length, 0);
});
