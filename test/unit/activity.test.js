'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Tracker, Stats, Activity, describe, statKey, progressOf, lastLine } = require('../../app/main/activity');

const T0 = Math.floor(Date.now() / 1000) * 1000 - 60 * 1000;   // relativo: o tracker ignora o que tem mais de 12 h
const iso = (ms) => new Date(T0 + ms).toISOString();
const use = (id, name, input, at) => JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, text, at) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const note = (taskId, status, at) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>` } });

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  const tr = path.join(dir, 'sess1.jsonl');
  fs.writeFileSync(tr, '');
  return { dir, tr, add: (...lines) => fs.appendFileSync(tr, lines.join('\n') + '\n') };
}

test('rótulos e chaves do histórico', () => {
  assert.deepEqual(describe('Bash', { command: 'npx remotion render', description: 'Renderizando o vídeo' }), { verb: 'Rodando', what: 'Renderizando o vídeo' });
  assert.equal(describe('Read', { file_path: '/a/b/segredo.env' }).what, 'segredo.env', 'só o nome do arquivo');
  assert.equal(describe('mcp__bancada__lista', {}).verb, 'lista');
  assert.equal(statKey('Bash', { command: 'cd "/x y" && FOO=1 npx remotion render a b' }), 'Bash:npx remotion');
  assert.equal(statKey('Bash', { command: 'npm run build' }), 'Bash:npm run build');
  assert.equal(statKey('Agent', { subagent_type: 'Explore' }), 'agent:Explore');
});

test('andamento na última linha', () => {
  assert.equal(progressOf('Rendered 120/900 frames'), 13.3);
  assert.equal(progressOf('encoding 45.5%'), 45.5);
  assert.equal(progressOf('frame 3 de 4'), 75);
  assert.equal(progressOf('2026/11'), null, 'data não é andamento');
  assert.equal(progressOf('nada aqui'), null);
});

test('ferramenta em andamento, terminada e o histórico aprende a duração', () => {
  const { tr, add } = mk();
  const t = new Tracker(tr, new Stats(null));
  add(use('u1', 'Bash', { command: 'npm test', description: 'Testes' }, 0));
  t.update();
  assert.equal(t.snapshot(T0 + 1000).doing[0].what, 'Testes');
  add(res('u1', 'ok', 30000));
  t.update();
  assert.equal(t.snapshot().doing.length, 0);
  add(use('u2', 'Bash', { command: 'npm test' }, 40000), res('u2', 'ok', 80000));
  t.update();
  const typ = t.stats.typical('Bash:npm test');
  assert.ok(typ && typ.n === 2 && typ.ms >= 30000);
});

test('segundo plano: começa pelo resultado da ferramenta, acaba pela notificação; imprimir a frase não conta', () => {
  const { dir, tr, add } = mk();
  const out = path.join('/private/tmp', `claude-${process.getuid()}`, 'bancada-teste', 'sess1', 'tasks');
  let canOut = true; try { fs.mkdirSync(out, { recursive: true }); } catch { canOut = false; }
  const outFile = path.join(out, 'bx123456.output');
  if (canOut) fs.writeFileSync(outFile, 'start\n\x1b[32mRendered 450/900\x1b[0m\r');
  const t = new Tracker(tr, new Stats(null));
  add(use('b1', 'Bash', { command: 'npx remotion render', description: 'Render do vídeo', run_in_background: true }, 0),
    res('b1', `Command running in background with ID: bx123456. Output is being written to: ${outFile}. You will be notified.`, 500),
    use('x1', 'Bash', { command: 'echo' }, 600), res('x1', 'texto qualquer: Command running in background with ID: falso999', 700));
  t.update();
  let s = t.snapshot(T0 + 1000);
  assert.equal(s.tasks.length, 1, 'só a tarefa de verdade');
  assert.equal(s.tasks[0].what, 'Render do vídeo');
  if (canOut) { assert.equal(s.tasks[0].line, 'Rendered 450/900'); assert.equal(s.tasks[0].pct, 50); }
  add(note('bx123456', 'completed', 600000));
  t.update();
  s = t.snapshot();
  assert.equal(s.tasks.length, 0);
  assert.ok(t.stats.typical('Bash:npx remotion') === null, 'uma vez só ainda não é média');
  try { fs.rmSync(path.join('/private/tmp', `claude-${process.getuid()}`, 'bancada-teste'), { recursive: true }); } catch {}
  fs.rmSync(dir, { recursive: true });
});

test('saída fora da pasta de tarefas do Claude nunca é lida', () => {
  assert.equal(lastLine('/etc/passwd'), null);
  assert.equal(lastLine(`/private/tmp/claude-501/x/tasks/../../../etc/a.output`), null);
  assert.equal(lastLine(path.join(os.homedir(), '.ssh', 'id_ed25519')), null);
  // link simbólico dentro da pasta de tarefas apontando para fora: recusado
  const dir = path.join('/private/tmp', `claude-${process.getuid()}`, 'bancada-teste-link', 's', 'tasks');
  let ok = true; try { fs.mkdirSync(dir, { recursive: true }); } catch { ok = false; }
  if (ok) {
    const fora = path.join(os.tmpdir(), `fora-${process.pid}.txt`); fs.writeFileSync(fora, 'segredo\n');
    const link = path.join(dir, 'lnk12345.output'); try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(fora, link);
    assert.equal(lastLine(link), null, 'link para fora não é lido');
    fs.rmSync(path.join('/private/tmp', `claude-${process.getuid()}`, 'bancada-teste-link'), { recursive: true }); fs.rmSync(fora);
  }
});

test('agentes: lê meta.json e a última ferramenta; o que terminou há muito some', () => {
  const { dir, tr } = mk();
  const sub = path.join(dir, 'sess1', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-aaa111.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Achar o bug', finished: false }));
  fs.writeFileSync(path.join(sub, 'agent-aaa111.jsonl'), use('z', 'Grep', { pattern: 'resize' }, 0) + '\n');
  fs.writeFileSync(path.join(sub, 'agent-bbb222.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'velho', finished: true }));
  fs.writeFileSync(path.join(sub, 'agent-bbb222.jsonl'), '');
  const old = new Date(Date.now() - 3600 * 1000); fs.utimesSync(path.join(sub, 'agent-bbb222.jsonl'), old, old);
  const t = new Tracker(tr, new Stats(null)); t.update();
  const ag = t.snapshot().agents;
  assert.equal(ag.length, 1);
  assert.equal(ag[0].type, 'Explore'); assert.equal(ag[0].what, 'Achar o bug');
  assert.deepEqual([ag[0].last.verb, ag[0].last.what], ['Procurando', 'resize']);
  fs.rmSync(dir, { recursive: true });
});

test('leitura incremental: a primeira leitura pega só o fim, depois só o que foi acrescentado', () => {
  const { dir, tr, add } = mk();
  const filler = JSON.stringify({ type: 'user', timestamp: iso(0), message: { content: 'x'.repeat(2000) } });
  for (let i = 0; i < 700; i++) add(filler);          // ~1,4 MB
  add(use('late', 'Read', { file_path: '/p/a.js' }, 1000));
  const t = new Tracker(tr, new Stats(null));
  assert.equal(t.update(), true);
  assert.equal(t.snapshot(T0 + 2000).doing[0].what, 'a.js');
  assert.equal(t.update(), false, 'nada novo: não relê');
  fs.rmSync(dir, { recursive: true });
});

test('Activity: avisa a tela só quando muda; terminal fechado some', () => {
  const { dir, tr, add } = mk();
  const got = [];
  const a = new Activity({ statsFile: path.join(dir, 'd.json'), onChange: (x) => got.push(x) });
  add(use('u1', 'Bash', { description: 'Build' }, 0));
  a.setTerm('t1', { transcript: tr, state: 'working' });
  assert.equal(got.length, 1); assert.equal(got[0].activity.doing[0].what, 'Build');
  a.tick(); assert.equal(got.length, 1, 'sem mudança, sem aviso');
  a.setTerm('t1', { state: 'off' });
  assert.equal(got[got.length - 1].activity, null);
  assert.equal(a.trackers.size, 0, 'libera a memória da conversa');
  a.stop();
  fs.rmSync(dir, { recursive: true });
});
