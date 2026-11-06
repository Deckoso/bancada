// Importa o notes.json do PromptPad (modelo v3; v2/v1 também) para o banco da Bancada. Fonte: BLUEPRINT D15.
// Idempotente: cada item importado guarda o id original; reimportar não duplica.
'use strict';
const fs = require('fs');

const TYPE_MAP = { note: 'note', idea: 'idea', prompt: 'prompt', reminder: 'reminder' };
const STATE_MAP = { active: 'active', sent: 'sent', archived: 'archived' };

function readPromptPad(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return { projects: [{ id: 'pp-legacy', name: 'PromptPad', notes: raw }] };
  if (!raw || !Array.isArray(raw.projects)) throw new Error('arquivo do PromptPad em formato desconhecido');
  return raw;
}

function importPromptPad(store, file) {
  const data = readPromptPad(file);
  const already = new Set(store.kvGet('promptpad_imported_ids', []));
  const projMap = store.kvGet('promptpad_project_map', {});
  const report = { projects: 0, items: 0, skipped: 0 };

  store.db.transaction(() => {
    for (const p of data.projects) {
      let target;
      if (p.system || p.id === 'inbox') target = 'inbox';
      else if (projMap[p.id] && store.getProject(projMap[p.id])) target = projMap[p.id];
      else {
        const key = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '');
        const existing = store.listProjects().find(x => key(x.name) === key(p.name));
        target = existing ? existing.id
          : store.createProject({ name: p.name || 'Projeto', kind: 'software', paths: p.path ? [p.path] : [] }).id;
        if (!existing) report.projects++;
        projMap[p.id] = target;
        if (p.armed) store.updateProject(target, { armed: true });
      }
      const notes = Array.isArray(p.notes) ? p.notes : [];
      for (const n of notes) {
        const key = `${p.id}:${n.id || n.createdAt || n.text}`;
        if (already.has(key)) { report.skipped++; continue; }
        const type = TYPE_MAP[n.type] || 'prompt';
        store.createItem({
          project_id: target,
          text: String(n.text || '').trim() || '(vazio)',
          type,
          state: STATE_MAP[n.state] || (n.status === 'sent' ? 'sent' : 'active'),
          pinned: !!n.pinned,
          remind_at: n.remindAt || null,
          sent_at: n.sentAt || null,
          created_at: n.createdAt || Date.now(),
          history: Array.isArray(n.history) ? n.history : undefined,
          tags: Array.isArray(n.tags) ? n.tags : undefined,
        });
        already.add(key);
        report.items++;
      }
    }
    store.kvSet('promptpad_imported_ids', [...already]);
    store.kvSet('promptpad_project_map', projMap);
  })();
  return report;
}

module.exports = { importPromptPad, readPromptPad };
