'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../../app/main/db');
const { Summarizer, extractJson, heuristic } = require('../../app/main/summarizer');

function seed() {
  const store = open(':memory:');
  const p = store.createProject({ name: 'loja-app', status: 'focus' });
  store.db.prepare(`INSERT INTO sessions_digest (source,session_id,file,project_id,title,last_at,last_prompt,prompts,files_touched,hits,prompts_sample,last_reply)
    VALUES ('claude','s1','/f',?,'Estoque',?,'corrige a entrada de unidades',3,'[]','{}','["corrige a entrada de unidades"]','Corrigi. Falta testar no tablet.')`).run(p.id, Date.now() - 20 * 60000);
  return { store, p };
}

test('extractJson tolera texto em volta e recusa JSON sem campos', () => {
  assert.deepEqual(extractJson('ok: {"feito":"a","parou_em":"b","proximo_passo":"c"} fim'), { feito: 'a', parou_em: 'b', proximo_passo: 'c' });
  assert.equal(extractJson('{"x":1}'), null);
  assert.equal(extractJson('sem json'), null);
});

test('heurística limpa markdown e não fica vazia', () => {
  const t = heuristic({}, [{ source: 'claude', last_at: Date.now(), title: 'T', last_prompt: '**faz** `isso`', last_reply: '| a | b |\n|---|---|\nFeito o deploy. Falta o teste no tablet.' }], null);
  assert.ok(!t.includes('|') && !t.includes('**'));
  assert.ok(t.includes('Falta o teste no tablet'));
});

test('IA preenche onde parei + próximo passo; 1 chamada por sessão; edição do usuário vence', async () => {
  const { store, p } = seed();
  let calls = 0;
  const sum = new Summarizer({ store, reader: null, runner: async () => { calls++; return '{"feito":"entrada corrigida","parou_em":"falta testar no tablet","proximo_passo":"Testar a entrada no tablet"}'; } });
  await sum.refreshProject(p.id);
  await new Promise(r => setTimeout(r, 50));
  let cur = store.getProject(p.id);
  assert.equal(cur.next_step, 'Testar a entrada no tablet'); assert.equal(cur.next_step_src, 'ai');
  assert.match(cur.where_stopped, /falta testar no tablet/);
  await sum.refreshProject(p.id); await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 1, 'não repete a mesma sessão');
  // usuário edita → IA não sobrescreve enquanto não houver sessão mais nova
  store.updateProject(p.id, { next_step: 'meu passo', next_step_src: 'user', where_stopped: 'meu texto', where_stopped_src: 'user', where_stopped_at: Date.now() });
  await sum.refreshProject(p.id, { force: true }); await new Promise(r => setTimeout(r, 50));
  cur = store.getProject(p.id);
  assert.equal(cur.next_step, 'meu passo'); assert.equal(cur.where_stopped, 'meu texto');
  sum.stop();
});

test('falha da IA não entra em loop e não apaga o cartão', async () => {
  const { store, p } = seed();
  let calls = 0;
  const sum = new Summarizer({ store, reader: null, runner: async () => { calls++; throw new Error('offline'); } });
  await sum.refreshProject(p.id); await new Promise(r => setTimeout(r, 50));
  await sum.refreshProject(p.id); await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.ok(store.getProject(p.id).where_stopped, 'heurística continua lá');
  assert.equal(sum.status().last_error, 'offline');
  sum.stop();
});
