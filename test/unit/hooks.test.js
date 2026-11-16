'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { ClaudeHooks, parseLine, nextState } = require('../../app/main/hooks');

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks dir-'));
  const got = [];
  const h = new ClaudeHooks({ dir, onState: (e) => got.push(e) });
  h.setup();
  return { dir, h, got };
}
const emit = (dir, termId, ev, payload) => execFileSync('/bin/sh', [path.join(dir, 'emit.sh'), ev], { input: JSON.stringify(payload), env: { ...process.env, BANCADA_TERM_ID: termId } });

test('settings.json tem os 10 hooks apontando para emit.sh (com aspas no caminho com espaço) e permissões fechadas', () => {
  const { dir, h } = mk();
  const s = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'));
  assert.deepEqual(Object.keys(s.hooks).sort(), ['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  assert.match(s.hooks.Stop[0].hooks[0].command, /^\/bin\/sh '.*hooks dir-.*\/emit\.sh' Stop$/);
  assert.equal(fs.statSync(path.join(dir, 'emit.sh')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(h.settingsFile).mode & 0o777, 0o600);
  assert.deepEqual(s.permissions.allow, ['mcp__bancada__lista', 'mcp__bancada__perguntar', 'mcp__bancada__pendencias'], 'só as 3 ferramentas de cartão, nada mais');
});

test('emit.sh grava 1 linha por evento, não escreve no stdout e ignora id estranho/ausente', () => {
  const { dir } = mk();
  const out = emit(dir, 'tA', 'UserPromptSubmit', { session_id: 's1', prompt: 'oi\nquebra' });
  assert.equal(String(out), '', 'stdout vazio (no UserPromptSubmit viraria contexto)');
  emit(dir, '../fora', 'Stop', {});
  execFileSync('/bin/sh', [path.join(dir, 'emit.sh'), 'Stop'], { input: '{}', env: { ...process.env, BANCADA_TERM_ID: '' } });
  const files = fs.readdirSync(path.join(dir, 'events'));
  assert.deepEqual(files, ['tA.log']);
  const lines = fs.readFileSync(path.join(dir, 'events', 'tA.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(fs.statSync(path.join(dir, 'events', 'tA.log')).mode & 0o777, 0o600, 'eventos só do usuário');
  assert.equal(parseLine(lines[0]).session_id, 's1');
});

test('ciclo: prompt → trabalhando; permissão → esperando; aprovado → trabalhando; fim → terminou; idle_prompt não muda', () => {
  const { dir, h, got } = mk();
  emit(dir, 't1', 'UserPromptSubmit', { session_id: 's', transcript_path: '/tmp/s.jsonl' }); h.scan();
  emit(dir, 't1', 'PreToolUse', { tool_name: 'Bash' }); h.scan();
  emit(dir, 't1', 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }); h.scan();
  emit(dir, 't1', 'PostToolUse', { tool_name: 'Bash' }); h.scan();
  emit(dir, 't1', 'Stop', {}); h.scan();
  emit(dir, 't1', 'Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }); h.scan();
  assert.deepEqual(got.map(e => e.state), ['working', 'waiting', 'working', 'done']);
  assert.equal(got[1].message, 'Claude needs your permission to use Bash');
  assert.equal(h.get('t1').transcript, '/tmp/s.jsonl');
  h.seen('t1'); assert.equal(h.get('t1').state, 'idle');
  h.reset('t1'); assert.equal(h.get('t1'), null); assert.equal(got.at(-1).state, 'off');
});

test('PreToolUse logo após o pedido de permissão (ferramentas em paralelo) não apaga o "esperando"', () => {
  assert.equal(nextState('waiting', { event: 'PreToolUse', now: 1000 }, 500), null);
  assert.equal(nextState('waiting', { event: 'PreToolUse', now: 5000 }, 500), 'working');
  assert.equal(nextState('done', { event: 'Notification', notification_type: 'idle_prompt' }), null);
});

test('arquivo de eventos é zerado ao passar de 256 KB e a leitura continua', () => {
  const { dir, h, got } = mk();
  const f = path.join(dir, 'events', 'tB.log');
  fs.writeFileSync(f, ('PreToolUse 1700000000 {"tool_name":"Read"}\n').repeat(8000));
  h.scan();
  assert.ok(fs.statSync(f).size === 0, 'zerado');
  emit(dir, 'tB', 'Stop', {}); h.scan();
  assert.deepEqual(got.map(e => e.state), ['working', 'done']);
});

test('linha incompleta espera o resto; lixo é ignorado', () => {
  const { dir, h, got } = mk();
  const f = path.join(dir, 'events', 'tC.log');
  fs.writeFileSync(f, 'lixo qualquer\nStop 1700000000 {');
  h.scan(); assert.equal(got.length, 0);
  fs.appendFileSync(f, '}\n'); h.scan();
  assert.deepEqual(got.map(e => e.state), ['done']);
});

test('pergunta (AskUserQuestion) e plano (ExitPlanMode) contam como "esperando você"; a resposta volta a trabalhando', () => {
  const { dir, h, got } = mk();
  emit(dir, 't7', 'UserPromptSubmit', {}); h.scan();
  emit(dir, 't7', 'PreToolUse', { tool_name: 'AskUserQuestion' }); h.scan();
  emit(dir, 't7', 'PostToolUse', { tool_name: 'AskUserQuestion' }); h.scan();
  emit(dir, 't7', 'PreToolUse', { tool_name: 'ExitPlanMode' }); h.scan();
  assert.deepEqual(got.map(e => e.state), ['working', 'waiting', 'working', 'waiting']);
  assert.equal(got[1].message, 'tem uma pergunta para você'); assert.equal(got[3].message, 'plano para aprovar');
});

test('cartões da Bancada (mcp__bancada__lista/perguntar) contam como "esperando você"; pendencias não', () => {
  const { dir, h, got } = mk();
  emit(dir, 't8', 'UserPromptSubmit', {}); h.scan();
  emit(dir, 't8', 'PreToolUse', { tool_name: 'mcp__bancada__lista' }); h.scan();
  emit(dir, 't8', 'PostToolUse', { tool_name: 'mcp__bancada__lista' }); h.scan();
  emit(dir, 't8', 'PreToolUse', { tool_name: 'mcp__bancada__pendencias' }); h.scan();
  emit(dir, 't8', 'PreToolUse', { tool_name: 'mcp__bancada__perguntar' }); h.scan();
  assert.deepEqual(got.map(e => e.state), ['working', 'waiting', 'working', 'waiting']);
  assert.equal(got[1].message, 'tem uma lista para você marcar'); assert.equal(got[3].message, 'tem uma pergunta para você');
});

test('Stop com tarefa em segundo plano rodando → "esperando tarefa"; quando ela acaba e o Claude para → terminou (e o aviso conta o tempo todo)', () => {
  const { dir, h, got } = mk();
  const tr = path.join(dir, 'sess.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(tr, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run build', run_in_background: true } }] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: bk1abc. Output is being written to: /tmp/x' }] } }));
  emit(dir, 't8', 'UserPromptSubmit', { transcript_path: tr }); h.scan();
  emit(dir, 't8', 'Stop', { transcript_path: tr }); h.scan();
  assert.equal(h.get('t8').state, 'background');
  h.seen('t8'); assert.equal(h.get('t8').state, 'background', 'olhar o terminal não apaga o azul');
  fs.appendFileSync(tr, line({ type: 'user', message: { content: '<task-notification>\n<task-id>bk1abc</task-id>\n<status>completed</status>\n</task-notification>' } }));
  emit(dir, 't8', 'Stop', { transcript_path: tr }); h.scan();
  assert.deepEqual(got.map(e => e.state), ['working', 'background', 'done']);
  assert.ok(got[2].workedMs >= 0 && got[2].prev === 'background');
});

test('pendingBackground: tarefa parada pelo Claude (TaskStop) não conta; transcrição real desta máquina não quebra', () => {
  const { pendingBackground } = require('../../app/main/hooks');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-')), 's.jsonl');
  const L = (o) => JSON.stringify(o) + '\n';
  const bash = (id, tid) => L({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'x', run_in_background: true } }] } })
    + L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${tid}. Output is being written to: /tmp/y` }] } });
  fs.writeFileSync(f, bash('u1', 'aaaa1') + bash('u2', 'bbbb2')
    + L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u3', name: 'TaskStop', input: { task_id: 'bbbb2' } }] } })
    + L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u3', content: 'Stopped task bbbb2' }] } }));
  assert.equal(pendingBackground(f), 1);
  // agente em segundo plano: o texto real é "Async agent launched successfully … agentId: X" (o detector antigo do Stop
  // procurava "launched in the background" e nunca achava)
  fs.appendFileSync(f, L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u4', name: 'Agent', input: { description: 'd', run_in_background: true } }] } })
    + L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u4', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: agx12345 (internal ID)' }] }] } }));
  assert.equal(pendingBackground(f), 2);
  assert.equal(pendingBackground('/nao/existe.jsonl'), 0);
});

// ---- v0.6: eventos novos + cutucão do Escritório ----
test('v0.6: SubagentStart traz agent_id/agent_type (formato real do 2.1.323); PermissionRequest = esperando você', () => {
  const ev = parseLine('SubagentStart 1763000000 {"session_id":"s","transcript_path":"/x/s.jsonl","agent_id":"abbb020cfaa1a2c13","agent_type":"Explore","hook_event_name":"SubagentStart"}');
  assert.equal(ev.event, 'SubagentStart'); assert.equal(ev.agent_id, 'abbb020cfaa1a2c13'); assert.equal(ev.agent_type, 'Explore');
  assert.equal(nextState('working', { event: 'PermissionRequest' }), 'waiting');
  assert.equal(nextState('waiting', { event: 'PostToolUseFailure' }), 'working');
  assert.equal(nextState('working', { event: 'SubagentStart' }), null, 'subagente não muda o estado do terminal');
});

test('v0.6: todo evento chega no onEvent, mesmo quando o estado não muda (PreToolUse com o Claude já trabalhando)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks ev-'));
  const evs = []; const states = [];
  const h = new ClaudeHooks({ dir, onState: (e) => states.push(e.state), onEvent: (id, ev) => evs.push([id, ev.event]) });
  h.setup();
  emit(dir, 'tE', 'UserPromptSubmit', { session_id: 's' });
  emit(dir, 'tE', 'PreToolUse', { session_id: 's', tool_name: 'Read' });
  emit(dir, 'tE', 'SubagentStart', { session_id: 's', agent_id: 'a1234', agent_type: 'Explore' });
  h.readFile('tE.log');
  assert.deepEqual(evs.map(x => x[1]), ['UserPromptSubmit', 'PreToolUse', 'SubagentStart']);
  assert.deepEqual(states, ['working'], 'só uma mudança de estado');
});

// ---- v0.8: lista oficial (background_tasks) e corte do payload ----
test('emit.sh: payload grande guarda começo + fim (o background_tasks do fim não se perde) e bate com clipPayload', () => {
  const { clipPayload } = require('../../app/main/hooks');
  const { dir, h } = mk();
  const payload = { session_id: 's', transcript_path: '/x/s.jsonl', hook_event_name: 'Stop', last_assistant_message: 'abc '.repeat(5000),
    background_tasks: [{ id: 'a1b2c3d4', type: 'subagent', status: 'running', description: 'Revisar [tudo] com "aspas"', agent_type: 'Explore' }, { id: 'mon00001', type: 'monitor', status: 'running', description: 'log' }] };
  emit(dir, 'tZ', 'Stop', payload);
  const line = fs.readFileSync(path.join(dir, 'events', 'tZ.log'), 'utf8').trim();
  assert.ok(line.length < 8200, 'linha com teto');
  assert.equal(line.replace(/^Stop \d+ /, ''), clipPayload(JSON.stringify(payload)), 'emit.sh = clipPayload');
  const ev = parseLine(line);
  assert.deepEqual(ev.bg_tasks.map(t => [t.id, t.type, t.status, t.agent_type]), [['a1b2c3d4', 'subagent', 'running', 'Explore'], ['mon00001', 'monitor', 'running', null]]);
  assert.equal(ev.bg_tasks[0].description, 'Revisar [tudo] com "aspas"');
  assert.equal(ev.agent_type, null, 'agent_type de dentro da lista não vira campo do evento');
  emit(dir, 'tZ', 'Stop', { session_id: 's' }); h.scan();
  assert.equal(parseLine(fs.readFileSync(path.join(dir, 'events', 'tZ.log'), 'utf8').trim().split('\n').pop()).bg_tasks, null, 'sem o campo: null');
});

test('background_tasks cortado no meio: aproveita os objetos completos; lista vazia = nada rodando', () => {
  const { bgTasks } = require('../../app/main/hooks');
  const cut = '{"x":1,"background_tasks":[{"id":"aaaa1111","type":"subagent","status":"running","description":"um"},{"id":"bbbb2222","type":"mon';
  assert.deepEqual(bgTasks(cut).map(t => t.id), ['aaaa1111']);
  assert.deepEqual(bgTasks('{"background_tasks":[]}'), []);
  assert.deepEqual(bgTasks('{"background_tasks":[{"id":"../x","type":"a"}]}'), [], 'id fora do padrão é descartado');
});

test('Stop com a lista oficial: subagentes e monitor rodando → "background" mesmo sem nada na transcrição', () => {
  const { dir, h, got } = mk();
  emit(dir, 'tL', 'UserPromptSubmit', {}); h.scan();
  emit(dir, 'tL', 'Stop', { background_tasks: [{ id: 'ag000001', type: 'subagent', status: 'running', description: 'x' }, { id: 'mon00001', type: 'monitor', status: 'running', description: 'y' }] }); h.scan();
  assert.equal(h.get('tL').state, 'background');
  assert.deepEqual(h.background('tL').list.map(t => t.id), ['ag000001', 'mon00001']);
  emit(dir, 'tL', 'UserPromptSubmit', {}); h.scan();
  emit(dir, 'tL', 'Stop', { background_tasks: [{ id: 'ag000001', type: 'subagent', status: 'completed', description: 'x' }] }); h.scan();
  assert.deepEqual(got.map(e => e.state), ['working', 'background', 'working', 'done']);
});

test('emit.ps1 (Windows) aplica o mesmo corte começo + fim', () => {
  const { emitScriptPs } = require('../../app/main/hooks');
  const ps = emitScriptPs('C:\\Users\\x\\ev');
  assert.match(ps, /\$p\.Length -gt 8000\) \{ \$p = \$p\.Substring\(0, 2000\) \+ ' \.\.\. ' \+ \$p\.Substring\(\$p\.Length - 6000\)/);
  assert.doesNotMatch(ps, /1500/);
});

test('subagente: Pre/PostToolUse com agent_id depois do Stop não reabre "trabalhando"; SubagentStart/Stop entram e saem', () => {
  const { dir, h, got } = mk();
  emit(dir, 'tS', 'UserPromptSubmit', {}); h.scan();
  emit(dir, 'tS', 'SubagentStart', { agent_id: 'ag777777', agent_type: 'Explore' }); h.scan();
  emit(dir, 'tS', 'Stop', { background_tasks: [{ id: 'ag777777', type: 'subagent', status: 'running', description: 'x', agent_type: 'Explore' }] }); h.scan();
  emit(dir, 'tS', 'PreToolUse', { tool_name: 'Grep', agent_id: 'ag777777', agent_type: 'Explore' }); h.scan();
  emit(dir, 'tS', 'PostToolUse', { tool_name: 'Grep', agent_id: 'ag777777', agent_type: 'Explore' }); h.scan();
  assert.deepEqual(got.map(e => e.state), ['working', 'background'], 'o principal continua acompanhando');
  const a = h.get('tS').agents.get('ag777777');
  assert.equal(a.type, 'Explore'); assert.equal(a.tool, 'Grep'); assert.equal(a.done, false);
  emit(dir, 'tS', 'SubagentStop', { agent_id: 'ag777777', agent_type: 'Explore', background_tasks: [] }); h.scan();
  assert.equal(h.get('tS').agents.get('ag777777').done, true);
  assert.deepEqual(h.background('tS').list, [], 'SubagentStop atualiza a lista oficial');
  emit(dir, 'tS', 'PreToolUse', { tool_name: 'Read' }); h.scan();
  assert.equal(h.get('tS').state, 'working', 'sem agent_id = o principal');
});
