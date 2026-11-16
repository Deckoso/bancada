'use strict';
// Latência hook → Escritório: a linha de evento gravada pelo hook chega à mudança de estado e ao snapshot da atividade
// (o que a tela recebe em activity:changed) em menos de 1 s, pelo caminho de verdade (fs.watch, sem varredura manual).
// O fs.watch do macOS (FSEvents) arma o fluxo de forma assíncrona: um evento escrito logo depois do start() pode cair
// antes de o vigia existir e só ser pego pela varredura de reserva (2 s). No app o vigia sobe no boot, muito antes do
// 1º hook; aqui o teste espera o vigia confirmar um evento-sentinela (outro terminal) antes de medir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ClaudeHooks } = require('../../app/main/hooks');
const { Activity } = require('../../app/main/activity');

test('evento do hook → estado e atividade em < 1 s (fs.watch + cutucão)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lat-'));
  const tr = path.join(dir, 's.jsonl'); fs.writeFileSync(tr, '');
  const marks = {};
  let activity = null;
  const hooks = new ClaudeHooks({ dir: path.join(dir, 'h'), onState: (e) => { if (e.id === 'tW') return; if (!marks[e.state]) marks[e.state] = Date.now(); activity.setTerm(e.id, { transcript: e.transcript, state: e.state }); },
    onEvent: (id, ev) => { if (id === 'tW') { marks.armed = marks.armed || Date.now(); return; } activity.poke(id, ev); }, busy: (id) => activity.busy(id) });
  activity = new Activity({ interval: 60000, hookInfo: (id) => hooks.get(id), onChange: ({ activity: a }) => {
    if (a && a.doing.some(d => d.verb === 'Lendo') && !marks.tool) marks.tool = Date.now();
    if (a && a.count === 2 && !marks.follow) marks.follow = Date.now();
  } });
  hooks.setup(); hooks.start();
  const log = path.join(dir, 'h', 'events', 'tL.log');
  const w = (ev, p) => { fs.appendFileSync(log, `${ev} ${Date.now()} ${JSON.stringify({ transcript_path: tr, ...p })}\n`); return Date.now(); };
  const until = async (k) => { const t0 = Date.now(); while (!marks[k] && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10)); return marks[k]; };
  try {
    // vigia armado? reescreve a sentinela a cada 100 ms até o fs.watch entregá-la (limite 5 s; a varredura também a pegaria,
    // mas então só confirma que o tempo passou — o que importa é que o vigia já existe quando a medição começa)
    const sent = path.join(dir, 'h', 'events', 'tW.log');
    for (const t0 = Date.now(); !marks.armed && Date.now() - t0 < 5000;) {
      fs.appendFileSync(sent, `Notification ${Date.now()} {}\n`);
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(marks.armed, 'vigia do fs.watch não armou em 5 s');
    const w1 = w('UserPromptSubmit', {});
    const r1 = await until('working');
    fs.appendFileSync(tr, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/a/b.js' } }] } }) + '\n');
    const w2 = w('PreToolUse', { tool_name: 'Read' });
    const r2 = await until('tool');
    const w3 = w('Stop', { background_tasks: [{ id: 'ag000001', type: 'subagent', status: 'running', description: 'x' }, { id: 'mon00001', type: 'monitor', status: 'running', description: 'y' }] });
    const r3 = await until('follow');
    const lat = [r1 - w1, r2 - w2, r3 - w3];
    console.log(`latência hook→estado ${lat[0]} ms · hook→ferramenta na atividade ${lat[1]} ms · Stop→"acompanhando · 2" ${lat[2]} ms`);
    for (const l of lat) assert.ok(Number.isFinite(l) && l < 1000, `latência ${l} ms`);
  } finally { hooks.stop(); activity.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
