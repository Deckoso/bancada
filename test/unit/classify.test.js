'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../../app/main/sessions/classify');
const { parseClaudeLine, parseCodexLine, dirHits } = require('../../app/main/sessions/parse');

const R = '/Users/v/Documents/Trabalho';
const P = (id, name, dir, extra = {}) => ({ id, name, paths: [dir], aliases: [], ...extra });
const projects = [
  P('ath', 'athena-os', `${R}/motor-ia`),
  P('wo', 'loja-app', `${R}/PROJETOS/01-trabalho/loja-app`),
  P('on', 'onda-site', `${R}/PROJETOS/04-live/onda-site`),
];

test('dirHits acha pastas de projeto (com espaço na raiz)', () => {
  const h = dirHits(JSON.stringify({ command: `cd "${R}/PROJETOS/01-trabalho/loja-app" && git status`, file_path: `${R}/motor-ia/STATE.yaml` }));
  assert.equal(h[`${R}/PROJETOS/01-trabalho/loja-app`], 1);
  assert.equal(h[`${R}/motor-ia`], 1);
});

test('sessão parada no hub (motor) mas mexendo no loja-app vai para o loja-app', () => {
  const s = { cwd: `${R}/motor-ia`, hits: { [`${R}/motor-ia`]: 6, [`${R}/PROJETOS/01-trabalho/loja-app`]: 3 }, prompts_sample: ['como tá o loja app?'], title: 'Status do loja app' };
  assert.equal(classify(s, projects), 'wo');
});

test('sessão no hub sem outro projeto fica no hub', () => {
  const s = { cwd: `${R}/motor-ia`, hits: { [`${R}/motor-ia`]: 5 }, prompts_sample: ['pesquisa de RFID'] };
  assert.equal(classify(s, projects), 'ath');
});

test('pasta não cadastrada dominando → sem projeto (não chuta o vizinho)', () => {
  const s = { cwd: `${R}/motor-ia`, hits: { [`${R}/PROJETOS/01-trabalho/loja-rh`]: 9, [`${R}/PROJETOS/01-trabalho/loja-app`]: 1 }, prompts_sample: ['atualiza o loja rh'] };
  assert.equal(classify(s, projects), null);
});

test('empate e evidência fraca → null', () => {
  assert.equal(classify({ hits: {}, prompts_sample: ['oi'] }, projects), null);
  assert.equal(classify({ hits: { [`${R}/PROJETOS/01-trabalho/loja-app`]: 1, [`${R}/PROJETOS/04-live/onda-site`]: 1 }, prompts_sample: [] }, projects), null);
});

test('nome citado: "loja app", "lojaapp", "LOJA-APP" — mas "ondas" não é "onda"', () => {
  const pr = [P('wo', 'LOJA-APP', '/x/a'), P('on', 'onda', '/x/b')];
  for (const t of ['e o loja app?', 'lojaapp caiu', 'LOJA-APP deploy']) assert.equal(classify({ hits: {}, prompts_sample: [t, t] }, pr), 'wo', t);
  assert.equal(classify({ hits: {}, prompts_sample: ['as ondas do mar', 'ondas'] }, pr), null);
});

test('parse do Claude: prompt humano, ignora meta/comandos, junta ferramentas e arquivos', () => {
  const u = parseClaudeLine(JSON.stringify({ type: 'user', timestamp: '2026-11-04T10:00:00Z', cwd: '/c', message: { content: 'corrige o login' } }));
  assert.equal(u.prompt, 'corrige o login');
  assert.equal((parseClaudeLine(JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })) || {}).prompt, undefined);
  assert.equal(parseClaudeLine(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' } })), null);
  const a = parseClaudeLine(JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:01:00Z', message: { content: [
    { type: 'text', text: 'Pronto.' }, { type: 'tool_use', name: 'Edit', input: { file_path: `${R}/PROJETOS/01-trabalho/loja-app/api/x.ts` } }] } }));
  assert.equal(a.reply, 'Pronto.'); assert.deepEqual(a.files, [`${R}/PROJETOS/01-trabalho/loja-app/api/x.ts`]);
  assert.equal(a.hits[`${R}/PROJETOS/01-trabalho/loja-app`], 1);
  assert.equal(parseClaudeLine('não é json'), undefined);
});

test('parse do Codex: meta, pedido, fim de tarefa, function_call', () => {
  assert.equal(parseCodexLine(JSON.stringify({ type: 'session_meta', payload: { id: 'abc', cwd: '/w', timestamp: '2026-11-04T10:00:00Z' } })).sessionId, 'abc');
  assert.equal(parseCodexLine(JSON.stringify({ type: 'event_msg', timestamp: 't', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'faz o deploy' }] } } })).prompt, 'faz o deploy');
  assert.equal(parseCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Feito.' } })).reply, 'Feito.');
  const f = parseCodexLine(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ cmd: `ls ${R}/PROJETOS/04-live/onda-site/app` }) } }));
  assert.equal(f.hits[`${R}/PROJETOS/04-live/onda-site`], 1, 'chave = pasta do projeto (PROJETOS/<cat>/<nome>)');
});
