'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { open } = require('../../app/main/db');
const { importPromptPad } = require('../../app/main/import-promptpad');

function fixture() {
  const d = { version: 3, activeProject: 'inbox', theme: 'dark', snippets: [], projects: [
    { id: 'inbox', name: 'Inbox', system: true, notes: [
      { id: 'a', text: 'ideia #live', type: 'idea', state: 'active', createdAt: 1000, updatedAt: 1000, pinned: true, tags: ['live'], history: [{ at: 1000, from: '—', to: 'idea' }] },
      { id: 'b', text: 'pagar boleto', type: 'reminder', state: 'active', createdAt: 2000, remindAt: 9e12 } ] },
    { id: 'p1', name: 'LOJA-APP', path: null, armed: false, notes: [
      { id: 'c', text: 'corrige o estoque', type: 'prompt', state: 'sent', createdAt: 3000, sentAt: 3500 },
      { id: 'd', text: 'segundo', type: 'prompt', state: 'active', createdAt: 4000 } ] } ] };
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-')), 'notes.json');
  fs.writeFileSync(f, JSON.stringify(d));
  return { f, d };
}

test('importa sem perder nada e reimportar não duplica (CP-3)', () => {
  const { f, d } = fixture();
  const s = open(':memory:');
  const r1 = importPromptPad(s, f);
  assert.deepEqual(r1, { projects: 1, items: 4, skipped: 0 });
  const loja = s.listProjects().find(p => p.name === 'LOJA-APP');
  const inbox = s.listItems('inbox');
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].pinned, true);
  assert.equal(inbox.find(i => i.text === 'pagar boleto').remind_at, 9e12);
  const w = s.listItems(loja.id);
  assert.deepEqual(w.map(i => [i.text, i.type, i.state, i.created_at]), [['corrige o estoque', 'prompt', 'sent', 3000], ['segundo', 'prompt', 'active', 4000]]);
  const r2 = importPromptPad(s, f);
  assert.deepEqual(r2, { projects: 0, items: 0, skipped: 4 });
  assert.equal(s.listItems(loja.id).length, 2);
});

test('notas do PromptPad caem no projeto já cadastrado com nome parecido (LOJA-APP → loja-app)', () => {
  const { f } = fixture();
  const s = open(':memory:');
  const wo = s.createProject({ name: 'loja-app' });
  const r = importPromptPad(s, f);
  assert.equal(r.projects, 0);
  assert.equal(s.listItems(wo.id).length, 2);
  assert.equal(s.listProjects().filter(p => /loja/i.test(p.name)).length, 1);
});
