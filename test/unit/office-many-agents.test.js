'use strict';
// Sessão longa: 45 subagentes que terminam por SubagentStop (sem aviso de fim na transcrição) não podem "ressuscitar"
// quando saem do registro de 40 dos hooks (achado do soak de 1 h da 0.8).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { ClaudeHooks, parseLine } = require('../../app/main/hooks');
const { Tracker, Stats } = require('../../app/main/activity');

test('45 subagentes encerrados por SubagentStop: o Escritório termina vazio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muitos-'));
  const h = new ClaudeHooks({ dir }); h.setup();
  const tr = path.join(dir, 's.jsonl'); fs.writeFileSync(tr, '');
  const t = new Tracker(tr, new Stats(null));
  const T = Date.now() - 3600 * 1000;
  for (let i = 0; i < 45; i++) {
    const id = `agsoak${String(i).padStart(3, '0')}`;
    t.tasks.set(id, { id, kind: 'agent', key: 'agent:Explore', what: `tarefa ${i}`, at: T + i * 1000 });   // lançado (transcrição)
    h.apply('t1', parseLine(`SubagentStart ${T + i * 1000} {"agent_id":"${id}","agent_type":"Explore"}`));
    h.apply('t1', parseLine(`PreToolUse ${T + i * 1000 + 10} {"agent_id":"${id}","agent_type":"Explore","tool_name":"Read"}`));
    h.apply('t1', parseLine(`SubagentStop ${T + i * 1000 + 500} {"agent_id":"${id}","agent_type":"Explore"}`));
  }
  const info = h.get('t1');
  assert.ok(info.agents.size <= 40, 'registro continua com teto');
  assert.equal(info.ended.size, 45);
  const snap = t.snapshot(Date.now(), info);
  assert.equal(snap.agents.filter(a => !a.done).length, 0, 'nenhum agente terminado volta como rodando');
  // um agente novo continua aparecendo
  t.tasks.set('agnovo01', { id: 'agnovo01', kind: 'agent', key: 'agent:Plan', what: 'novo', at: Date.now() });
  assert.equal(t.snapshot(Date.now(), info).agents.filter(a => !a.done).length, 1);
  fs.rmSync(dir, { recursive: true });
});
