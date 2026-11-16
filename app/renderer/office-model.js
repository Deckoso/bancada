// O que o Escritório mostra, sem desenhar nada: pose de cada agente, subagentes, tarefas em segundo plano, bancada de
// ferramentas (terminais comuns) e quadro do projeto. Funções puras (mesmo arquivo na tela e nos testes de cenário).
// Regra de ouro: nenhuma pose parada sem motivo. Cada pose diz o quê, desde quando e, se houver, a última linha.
'use strict';
(function (root) {
  const MAX_BENCH = 8;
  const MAX_TASKS = 24;

  // poses: work (na mesa, com ferramenta ou compactando) · think (na mesa, "Pensando") · wait (em pé, esperando você)
  //        follow (acompanhando N coisas que rodam depois do turno) · limit (limite de uso) · stalled (sem sinal) · sofa
  const MODE = { work: 'desk', think: 'desk', wait: 'waiting', follow: 'follow', limit: 'limit', stalled: 'stalled', sofa: 'sofa' };

  function dur(ms) {
    ms = Math.max(0, ms || 0); const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60); if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  }

  function poseOf({ state, act, pt, now }) {
    const a = act || null;
    const live = a ? a.agents.filter(x => !x.done) : [];
    const count = a ? (a.count != null ? a.count : a.tasks.length + live.length) : 0;
    // Codex / Google (sem hooks): pela atividade do terminal
    if (pt && (pt.kind === 'codex' || pt.kind === 'agy') && !state) {
      return pt.active ? { pose: 'work', label: 'ativo pelo terminal', verb: 'Trabalhando', what: pt.line || '', since: pt.activeSince || pt.lastOutAt, count: 0 }
        : { pose: 'sofa', label: '', count: 0 };
    }
    if (state === 'waiting') return { pose: 'wait', label: 'esperando você', count };
    if (a && a.limit) return { pose: 'limit', label: `limite atingido${a.limit.text ? ' · ' + a.limit.text : ''}`, since: a.limit.at, count };
    if (a && a.stalled) return { pose: 'stalled', label: `sem sinal há ${dur(now - a.lastSignalAt)}`, since: a.lastSignalAt, count };
    const d0 = a && (a.doing.find(d => d.name !== 'Agent' && d.name !== 'Task') || a.doing[0]);
    if (d0) return { pose: 'work', label: `${d0.verb}${d0.what ? ': ' + d0.what : ''}`, verb: d0.verb, what: d0.what, since: d0.since, count };
    if (a && a.compacting) return { pose: 'work', label: 'Compactando a conversa', verb: 'Compactando', what: 'a conversa', since: a.compacting, count };
    if (state === 'working') return { pose: 'think', label: 'Pensando', verb: 'Pensando', count };
    if (count > 0) return { pose: 'follow', label: `acompanhando · ${count}`, verb: 'Acompanhando', what: count === 1 ? '1 coisa rodando' : `${count} coisas rodando`, count };
    if (state === 'unknown') return { pose: 'stalled', label: 'sem notícia', count };
    return { pose: 'sofa', label: '', count };
  }

  const termOf = (pulse, projectId, id) => { const p = pulse && pulse[projectId]; return p && p.terms ? p.terms.find(x => x.id === id) || null : null; };

  // terms: [{ id, name, projectId, projectName, state }] · act: termId → snapshot · pulse: projectId → pulso do projeto
  function build({ terms, act, pulse, now, projects }) {
    const actors = []; const tasks = []; const bench = []; const boards = [];
    (terms || []).forEach((t, i) => {
      const a = (act && act[t.id]) || null;
      const pt = termOf(pulse, t.projectId, t.id);
      if (pt && pt.kind === 'shell' && !t.state) return;          // terminal comum: vai para a bancada, não vira boneco
      const p = poseOf({ state: t.state, act: a, pt, now });
      const kind = pt && (pt.kind === 'codex' || pt.kind === 'agy') ? pt.kind : 'claude';
      const myTasks = a ? a.tasks.slice(0, MAX_TASKS).map(k => ({ ...k, termId: t.id, projectId: t.projectId })) : [];
      actors.push({ id: t.id, termId: t.id, kind, idx: i, name: `${t.projectName || ''} · ${t.name || ''}`, pose: p.pose, mode: MODE[p.pose], label: p.label,
        verb: p.verb || null, what: p.what || '', since: p.since || null, count: p.count, taskIdx: tasks.length, nTasks: myTasks.length,
        line: p.pose === 'follow' && myTasks[0] ? myTasks[0].line || null : null });
      tasks.push(...myTasks);
      if (a) for (const ag of a.agents) {
        actors.push({ id: `ag:${ag.id}`, termId: t.id, kind: 'agent', type: ag.type, name: `${ag.type} (de ${t.name || ''})`, pose: ag.done ? 'sofa' : 'work',
          mode: ag.done ? 'leave' : 'desk', silent: !!ag.silent, verb: ag.last ? ag.last.verb : 'Agente', what: ag.last ? ag.last.what : ag.what,
          task: ag.what, since: ag.since, lastSignalAt: ag.lastSignalAt, label: ag.done ? 'terminei' : ag.what, boss: i });
      }
    });
    const want = projects ? new Set(projects) : null;
    for (const [pid, p] of Object.entries(pulse || {})) {
      if (want && !want.has(pid)) continue;
      for (const x of p.terms || []) {
        if (x.kind !== 'shell' || bench.length >= MAX_BENCH) continue;
        bench.push({ id: x.id, termId: x.id, projectId: pid, name: x.name, fg: x.fg || '', active: !!x.active, since: x.activeSince || null, lastOutAt: x.lastOutAt || null,
          line: x.line || '', url: (x.urls && x.urls[0]) || null });
      }
      boards.push({ projectId: pid, git: p.git || null, servers: p.servers || [], tests: p.tests || null });
    }
    return { actors, tasks, bench, boards };
  }

  // cartão ao passar o mouse/tocar: o quê · há quanto tempo · última linha
  function card(x, now) {
    if (!x) return null;
    const parts = [];
    const what = x.label || [x.verb, x.what].filter(Boolean).join(': ');
    if (what) parts.push(what);
    if (x.since) parts.push(`há ${dur(now - x.since)}`);
    if (x.silent) parts.push(`em silêncio há ${dur(x.quietMs != null ? x.quietMs : now - (x.lastSignalAt || x.since))}`);
    const line = x.line ? `“${x.line}”` : '';
    return { title: x.name || x.what || '', text: parts.join(' · '), line };
  }

  // texto de uma tarefa em segundo plano (faixa, legenda, estação)
  function taskText(k, now) {
    const kind = { monitor: 'vigiando', workflow: 'fluxo', agent: 'agente' }[k.kind] || 'em segundo plano';
    const head = k.silent ? `rodando em silêncio · ${dur(k.quietMs != null ? k.quietMs : now - (k.lastSignalAt || k.since))}` : kind;
    return `${k.what || 'tarefa'} · ${head} · há ${dur(now - k.since)}`;
  }

  const api = { poseOf, build, card, taskText, dur, MODE };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.OfficeModel = api;
})(typeof window !== 'undefined' ? window : this);
