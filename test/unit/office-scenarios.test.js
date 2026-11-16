'use strict';
// Escritório fiel: cenários-ouro. Cada test/corpus/office-*.jsonl é uma sessão SINTÉTICA no formato real (payload dos
// hooks como o Claude Code manda, linhas da transcrição .jsonl, saída de tarefas, saída de terminal comum) com o tempo de
// cada passo e o que o Escritório tem de mostrar naquele instante: pose do agente principal, contagem do que roda,
// subagentes visíveis, tarefas com o quê / desde quando / última linha, bancada de ferramentas.
// A cadeia testada é a de verdade: linha de evento → hooks.js (parseLine, máquina de estados) → activity.js (transcrição,
// subagentes, saídas) → project-pulse.js (terminais comuns) → office-model.js (o que a cena desenha). Relógio injetado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const hooksMod = require('../../app/main/hooks');
const { ClaudeHooks, parseLine } = hooksMod;
const { Activity } = require('../../app/main/activity');
let ProjectPulse = null; try { ({ ProjectPulse } = require('../../app/main/project-pulse')); } catch {}
let OM = null; try { OM = require('../../app/renderer/office-model.js'); } catch {}

const CORPUS = path.join(__dirname, '..', 'corpus');
const FILES = fs.readdirSync(CORPUS).filter(f => /^office-.+\.jsonl$/.test(f)).sort();
// cenários ainda sem correção (marcados como "a fazer" para a suíte seguir verde entre os commits)
const PENDENTE = new Set([]);   // v0.7.1: 11 de 12 falhavam; T5.2–T5.5 corrigiram todos

// O que a tela desenhava antes (activity-ui.js v0.6), para medir o "antes" quando o office-model ainda não existe.
function legacyPose(state, a) {
  const busy = state === 'working' || (a && a.doing.length);
  const mode = a && a.stalled ? 'stalled' : state === 'waiting' ? 'waiting' : busy ? 'desk' : state === 'background' || (a && a.tasks.length) ? 'machine' : 'sofa';
  const d0 = a && (a.doing.find(d => d.name !== 'Agent' && d.name !== 'Task') || a.doing[0]);
  const pose = { stalled: 'stalled', waiting: 'wait', machine: 'follow', sofa: 'sofa' }[mode] || (d0 ? 'work' : 'think');
  const label = pose === 'work' ? `${d0.verb}${d0.what ? ': ' + d0.what : ''}` : pose === 'follow' && a && a.tasks[0] ? `aguardando: ${a.tasks[0].what}` : '';
  return { pose, label, count: a ? a.tasks.length + a.agents.filter(x => !x.done).length : 0 };
}

class FakePtys {
  constructor() { this.t = new Map(); }
  feed(id, { data, fg, url, at, kind, name }) {
    const x = this.t.get(id) || { id, projectId: 'p1', name: name || id, cwd: '/tmp/projeto-exemplo', urls: [], tail: '', fg: '', lastOutAt: 0, kind };
    if (kind) x.kind = kind;
    if (fg != null) x.fg = fg;
    if (data) { x.tail = (x.tail + data).slice(-8192); x.lastOutAt = at; }
    if (url && !x.urls.some(u => u.url === url)) x.urls.push({ port: (/:(\d+)/.exec(url) || [])[1], url });
    this.t.set(id, x);
  }
  list() { return [...this.t.values()].map(x => ({ id: x.id, projectId: x.projectId, name: x.name, cwd: x.cwd, urls: x.urls })); }
  foreground(id) { const x = this.t.get(id); return x ? x.fg : ''; }
  replay(id) { const x = this.t.get(id); return x ? x.tail : null; }
  lastOutput(id) { const x = this.t.get(id); return x ? x.lastOutAt : 0; }
}

function setup() {
  const uid = process.getuid();
  const root = fs.mkdtempSync(path.join('/private/tmp', `claude-${uid}`, 'bancada-office-'));
  const tr = path.join(root, 'sess-exemplo.jsonl'); fs.writeFileSync(tr, '');
  const sub = path.join(root, 'sess-exemplo', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  const tasks = path.join(root, 'sess-exemplo', 'tasks'); fs.mkdirSync(tasks, { recursive: true });
  const hdir = path.join(root, 'hooks'); fs.mkdirSync(hdir);
  return { root, tr, sub, tasks, hdir };
}

function sub(s, P) { return s.replace(/\$TR/g, P.tr).replace(/\$TASKS/g, P.tasks).replace(/\$SUB/g, P.sub); }
const touch = (f, ms) => { const d = new Date(ms); fs.utimesSync(f, d, d); };

function run(file) {
  const steps = fs.readFileSync(path.join(CORPUS, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const P = setup();
  const T0 = Date.now() - 30 * 60 * 1000;
  const clock = { t: T0 };
  const now = () => clock.t;
  let activity = null;
  const hooks = new ClaudeHooks({ dir: P.hdir, now, busy: (id) => !!(activity && activity.busy && activity.busy(id)),
    onState: (e) => activity && activity.setTerm(e.id, { transcript: e.transcript, state: e.state }), onEvent: () => {} });
  hooks.setup();
  activity = new Activity({ now, interval: 1e9, hookInfo: (id) => hooks.get(id) });
  const ptys = new FakePtys();
  const kinds = new Map();
  const pulse = ProjectPulse ? new ProjectPulse({ ptys, now, kindOf: (id) => kinds.get(id) || 'shell', projectOf: () => 'p1', git: null }) : null;
  const clipPayload = hooksMod.clipPayload || ((s) => s.slice(0, 1500));
  const claudeTerms = new Set();
  const problems = [];
  try {
    for (const s of steps) {
      if (s.scenario) continue;
      clock.t = T0 + s.t;
      if (s.hook) {
        const term = s.term || 't1'; claudeTerms.add(term);
        const line = `${s.hook} ${clock.t} ${clipPayload(sub(JSON.stringify(s.p), P))}\n`;
        assert.ok(parseLine(line.trim()), 'linha de evento no formato real');
        fs.appendFileSync(path.join(P.hdir, 'events', `${term}.log`), line);
        hooks.readFile(`${term}.log`);
      } else if (s.tr && !s.sub) {
        const o = { timestamp: new Date(clock.t).toISOString(), ...JSON.parse(sub(JSON.stringify(s.tr), P)) };
        fs.appendFileSync(P.tr, JSON.stringify(o) + '\n'); touch(P.tr, clock.t);
      } else if (s.sub) {
        if (s.meta) { const f = path.join(P.sub, `agent-${s.sub}.meta.json`); fs.writeFileSync(f, JSON.stringify(s.meta)); }
        const jl = path.join(P.sub, `agent-${s.sub}.jsonl`);
        if (s.tr) fs.appendFileSync(jl, JSON.stringify({ timestamp: new Date(clock.t).toISOString(), ...s.tr }) + '\n'); else if (!fs.existsSync(jl)) fs.writeFileSync(jl, '');
        touch(jl, clock.t);
      } else if (s.out) {
        const f = path.join(P.tasks, `${s.out}.output`); fs.appendFileSync(f, s.text); touch(f, clock.t);
      } else if (s.pty) {
        if (s.kind) kinds.set(s.pty, s.kind);
        ptys.feed(s.pty, { data: s.data, fg: s.fg, url: s.url, at: clock.t, kind: s.kind });
      }
      hooks.scan();
      for (const id of claudeTerms) activity.tickOne(id, clock.t);
      if (pulse) pulse.tick();
      if (s.expect) check(s, { hooks, activity, pulse, ptys, kinds, claudeTerms, T0, now: clock.t }, problems);
    }
  } finally {
    hooks.stop(); activity.stop(); if (pulse && pulse.stop) pulse.stop();
    fs.rmSync(P.root, { recursive: true, force: true });
  }
  return problems;
}

function check(s, ctx, problems) {
  const e = s.expect; const term = e.term || 't1';
  const where = `t=${Math.round(s.t / 1000)}s`;
  const fail = (what, got, want) => problems.push(`${where} ${what}: veio ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`);
  const hs = ctx.hooks.get(term);
  const state = hs ? hs.state : null;
  const act = (ctx.activity.list() || {})[term] || null;
  const pl = ctx.pulse ? ctx.pulse.list() : {};
  const pt = (pl.p1 && pl.p1.terms || []).find(x => x.id === term) || null;
  const terms = [...ctx.claudeTerms].map(id => ({ id, name: id, projectId: 'p1', projectName: 'exemplo', state: ctx.hooks.get(id) ? ctx.hooks.get(id).state : null }));
  for (const [id, k] of ctx.kinds) if (k === 'codex' || k === 'agy') terms.push({ id, name: id, projectId: 'p1', projectName: 'exemplo', state: null });
  let pose, model;
  if (OM) {
    model = OM.build({ terms, act: { [term]: act, ...Object.fromEntries([...ctx.claudeTerms].map(id => [id, (ctx.activity.list() || {})[id] || null])) }, pulse: pl, now: ctx.now });
    pose = OM.poseOf({ state, act, pt, now: ctx.now });
  } else {
    pose = legacyPose(state, act);
    model = { actors: act ? act.agents.filter(a => !a.done).map(a => ({ kind: 'agent', id: `ag:${a.id}`, verb: a.last ? a.last.verb : '', mode: 'desk' })) : [], tasks: act ? act.tasks : [], bench: [] };
  }
  if ('state' in e && state !== e.state) fail('estado do hook', state, e.state);
  if ('pose' in e && pose.pose !== e.pose) fail(`pose (${pose.label || ''})`, pose.pose, e.pose);
  if ('label' in e && !String(pose.label || '').includes(e.label)) fail('texto', pose.label, `…${e.label}…`);
  if ('count' in e && pose.count !== e.count) fail('contagem', pose.count, e.count);
  if (e.notStalled && (pose.pose === 'stalled' || (act && act.stalled))) fail('"sem sinal" indevido', 'stalled', 'não');
  const agents = model.actors.filter(a => a.kind === 'agent' && a.mode !== 'leave');
  if ('agents' in e && agents.length !== e.agents) fail('subagentes visíveis', agents.length, e.agents);
  if (e.agentVerb) for (const [id, verb] of Object.entries(e.agentVerb)) { const a = agents.find(x => x.id === `ag:${id}`); if (!a || a.verb !== verb) fail(`subagente ${id}`, a ? a.verb : null, verb); }
  if (e.tasks) {
    const tasks = model.tasks.filter(t => t.termId == null || t.termId === term);
    if (!e.tasks.length && tasks.length) fail('tarefas', tasks.map(t => t.what), []);
    e.tasks.forEach((w, i) => {
      const t = tasks[i]; if (!t) return fail(`tarefa ${i}`, null, w);
      if (w.what && t.what !== w.what) fail(`tarefa ${i} o quê`, t.what, w.what);
      if (w.kind && t.kind !== w.kind) fail(`tarefa ${i} tipo`, t.kind, w.kind);
      if (w.line && t.line !== w.line) fail(`tarefa ${i} última linha`, t.line, w.line);
      if ('since' in w && t.since !== ctx.T0 + w.since) fail(`tarefa ${i} desde`, t.since - ctx.T0, w.since);
      if ('silent' in w && !!t.silent !== w.silent) fail(`tarefa ${i} em silêncio`, !!t.silent, w.silent);
    });
  }
  if (e.bench) {
    const b = model.bench || [];
    if (!e.bench.length && b.some(x => x.active)) fail('bancada', b, []);
    for (const w of e.bench) {
      const x = b.find(y => y.id === w.id); if (!x) { fail(`bancada ${w.id}`, null, w); continue; }
      if (w.fg && x.fg !== w.fg) fail('bancada programa', x.fg, w.fg);
      if ('active' in w && x.active !== w.active) fail('bancada ativo', x.active, w.active);
      if (w.url && !String(x.url || '').includes(w.url)) fail('bancada servidor', x.url, w.url);
      if (w.line && !String(x.line || '').includes(w.line)) fail('bancada última linha', x.line, w.line);
    }
  }
}

for (const f of FILES) {
  const name = f.replace(/^office-|\.jsonl$/g, '');
  const head = JSON.parse(fs.readFileSync(path.join(CORPUS, f), 'utf8').split('\n')[0]);
  test(`cenário ${name}: ${head.scenario}`, PENDENTE.has(name) ? { todo: 'falha conhecida, corrigida nas próximas tarefas' } : {}, () => {
    const p = run(f);
    assert.deepEqual(p, [], `${name}:\n  ${p.join('\n  ')}`);
  });
}

test('corpus: 12 cenários mínimos e nada de dado pessoal', () => {
  const want = ['turno-normal', 'bash-silencioso', 'agentes-async', 'monitor', 'workflow', 'permissao', 'compactacao', 'limite', 'subagente-pos-stop', 'subagent-start-stop', 'shell-npm-dev', 'codex'];
  for (const w of want) assert.ok(FILES.includes(`office-${w}.jsonl`), w);
  for (const f of FILES) {
    const txt = fs.readFileSync(path.join(CORPUS, f), 'utf8');
    assert.doesNotMatch(txt, /\/Users\/|@gmail|\b(?:\d{1,3}\.){3}\d{1,3}\b/i, f);
  }
});
