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

test('settings.json tem os 5 hooks apontando para emit.sh (com aspas no caminho com espaço) e permissões fechadas', () => {
  const { dir, h } = mk();
  const s = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'));
  assert.deepEqual(Object.keys(s.hooks).sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
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
  fs.writeFileSync(tr, line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: bk1abc. Output is being written to: /tmp/x' }] } }));
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
  fs.writeFileSync(f, 'Command running in background with ID: aaaa1\nCommand running in background with ID: bbbb2\n{"name":"TaskStop","input":{"task_id":"bbbb2"}}\n');
  assert.equal(pendingBackground(f), 1);
  assert.equal(pendingBackground('/nao/existe.jsonl'), 0);
});
