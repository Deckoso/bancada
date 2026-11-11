// Atividade do Claude em tempo real (v0.5): o que cada Claude está fazendo, há quanto tempo, em que parte está e quanto
// costuma faltar. Alimenta a faixa de atividade de cada painel e o Escritório (sala com os agentes).
// Fontes (só leitura, todas do próprio usuário):
//  - a transcrição .jsonl da conversa: ferramenta em andamento (tool_use sem tool_result), tarefas em segundo plano
//    ("running in background with ID: X … Output is being written to: P"), fim das tarefas (<task-notification>);
//  - <sessão>/subagents/agent-*.meta.json + .jsonl: os agentes (descrição, tipo, terminou?) e a última ferramenta de cada um;
//  - o arquivo de saída de cada tarefa em segundo plano: a última linha diz em que parte está (ex.: "frame 120/900"),
//    e a hora da última gravação diz se ainda está viva.
// Memória: leitura incremental por transcrição (offset), mapas com teto, saída lida só nos últimos 4 KB.
'use strict';
const fs = require('fs');
const path = require('path');

const FIRST_TAIL = 1024 * 1024;       // primeira leitura: só o último 1 MB da conversa
const CHUNK = 512 * 1024;
const MAX_PENDING = 200;
const MAX_TASKS = 50;
const MAX_AGENTS = 40;
const MAX_TRACKED = 30;               // transcrições acompanhadas ao mesmo tempo
const OUT_TAIL = 4096;
const AGENT_TAIL = 64 * 1024;
const STALL_MS = 2 * 60 * 1000;       // em andamento sem nenhum sinal por 2 min → "sem sinal"
const DONE_LINGER_MS = 20 * 1000;     // agente que acabou de terminar ainda aparece um pouco (volta para o sofá)
const STATS_KEYS = 300;
const STATS_PER_KEY = 20;
const MIN_STAT_MS = 5000;             // só aprende com o que demora (o rápido não precisa de previsão)
// saída de tarefa do Claude Code: /private/tmp/claude-<uid>/<projeto>/<sessão>/tasks/<id>.output (nada fora disso é lido)
const OUTPUT_RE = /^\/(?:private\/)?tmp\/claude-\d+\/[^\0]{1,400}\/tasks\/[A-Za-z0-9_-]{4,60}\.output$/;

const VERB = { Bash: 'Rodando', Read: 'Lendo', Edit: 'Editando', MultiEdit: 'Editando', Write: 'Escrevendo', NotebookEdit: 'Editando',
  Grep: 'Procurando', Glob: 'Procurando', WebSearch: 'Pesquisando', WebFetch: 'Lendo a web', Agent: 'Agente', Task: 'Agente',
  Monitor: 'Vigiando', Workflow: 'Fluxo de agentes', AskUserQuestion: 'Perguntando a você', ExitPlanMode: 'Plano para aprovar',
  TodoWrite: 'Organizando tarefas', Skill: 'Usando skill', ToolSearch: 'Carregando ferramentas' };

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const ts = (x) => { const t = Date.parse(x); return Number.isFinite(t) ? t : null; };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

// Rótulo curto do que a ferramenta está fazendo (nunca o conteúdo de arquivo: só nome, descrição, padrão).
function describe(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = (p) => p ? path.basename(String(p)) : '';
  let what = '';
  switch (name) {
    case 'Bash': what = i.description || i.command; break;
    case 'Agent': case 'Task': what = i.description || i.subagent_type; break;
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': what = base(i.file_path || i.notebook_path); break;
    case 'Grep': case 'Glob': what = i.pattern; break;
    case 'WebSearch': what = i.query; break;
    case 'WebFetch': try { what = new URL(i.url).host; } catch { what = ''; } break;
    case 'Monitor': what = i.description || i.command; break;
    case 'Skill': what = i.skill; break;
    default: what = i.description || i.title || '';
  }
  const verb = VERB[name] || (/^mcp__/.test(name) ? name.split('__').slice(2).join(' ') || 'Ferramenta' : name);
  return { verb: clip(verb, 30), what: clip(what, 90) };
}

// Chave do histórico de duração: "o que é" a coisa, para comparar com as vezes anteriores.
function statKey(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Agent' || name === 'Task') return `agent:${i.subagent_type || 'general'}`;
  if (name !== 'Bash' && name !== 'Monitor') return name;
  let cmd = String(i.command || '');
  cmd = cmd.split(/&&|;|\|\|/).map(s => s.trim()).filter(s => s && !/^(cd|export|source|set)\b/.test(s))[0] || '';
  const words = cmd.split(/\s+/).filter(w => !/^[A-Z_][A-Z0-9_]*=/.test(w));
  if (!words.length) return name;
  const prog = path.basename(words[0].replace(/^['"]|['"]$/g, ''));
  if (/^(npm|npx|pnpm|yarn|bun|node|python3?|uv|cargo|go|make|git|docker)$/.test(prog) && words[1]) {
    const sub = words[1] === 'run' && words[2] ? `run ${words[2]}` : path.basename(words[1].replace(/^['"]|['"]$/g, ''));
    return `${name}:${prog} ${clip(sub, 40)}`;
  }
  return `${name}:${clip(prog, 40)}`;
}

// Em que parte está: "45%" ou "120/900" na última linha da saída.
function progressOf(line) {
  if (!line) return null;
  const pct = /(\d{1,3}(?:[.,]\d+)?)\s?%/.exec(line);
  if (pct) { const v = parseFloat(pct[1].replace(',', '.')); if (v >= 0 && v <= 100) return v; }
  for (const m of line.matchAll(/\b(\d{1,7})\s?(?:\/|de|of)\s?(\d{1,7})\b/g)) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (b > 1 && a <= b) return Math.round((a / b) * 1000) / 10;
  }
  return null;
}

function lastLine(file) {
  if (typeof file !== 'string' || !OUTPUT_RE.test(file) || file.includes('/../')) return null;
  try {
    // o caminho real (sem link simbólico no arquivo nem nas pastas) também tem de estar na pasta de tarefas do Claude deste usuário
    const real = fs.realpathSync(file);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!OUTPUT_RE.test(real) || (uid !== null && !real.includes(`/claude-${uid}/`))) return null;
    const st = fs.statSync(real);
    if (!st.isFile()) return null;
    file = real;
    const len = Math.min(st.size, OUT_TAIL);
    let text = '';
    if (len) { const buf = Buffer.alloc(len); const fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); text = buf.toString('utf8'); }
    const lines = stripAnsi(text.replace(/\r\n/g, '\n')).split(/[\r\n]/).map(s => s.trim()).filter(Boolean);
    return { line: clip(lines[lines.length - 1] || '', 160), mtime: st.mtimeMs, size: st.size };
  } catch { return null; }
}

function readTail(file, max) {
  try {
    const st = fs.statSync(file); const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len); const fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  } catch { return null; }
}

// A tarefa foi para o segundo plano? Só pelo começo do resultado da própria ferramenta (um comando que IMPRIME essa
// frase não conta). Formatos conferidos em 2026-11-10 (Claude Code 2.1.3xx).
function launchId(name, txt) {
  const head = String(txt).slice(0, 400);
  let m = null;
  if (name === 'Bash') m = /^Command running in background with ID: ([A-Za-z0-9_-]{4,60})/.exec(head);
  else if (name === 'Monitor') m = /^Monitor started \(task ([A-Za-z0-9_-]{4,60})/.exec(head);
  else if (name === 'Agent' || name === 'Task') m = /^Async agent launched successfully[\s\S]{0,300}?agentId: ([A-Za-z0-9_-]{4,60})/.exec(head);
  else if (name === 'Workflow') m = /^Workflow[^\n]{0,80}?\b(wf_[a-z0-9-]{6,60}|[a-z0-9]{8,40})\b/i.exec(head);
  return m;
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && typeof x.text === 'string') ? x.text : '').join('\n');
  return '';
}

// ---------------- histórico de duração (média das suas sessões) ----------------
class Stats {
  constructor(file) { this.file = file; this.data = {}; this.seen = new Set(); this.dirty = false; try { if (file) this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {} }
  add(key, ms, id) {
    if (!key || !(ms >= MIN_STAT_MS) || ms > 12 * 3600 * 1000) return;
    if (id) { if (this.seen.has(id)) return; this.seen.add(id); if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-2000)); }
    const arr = (this.data[key] = (this.data[key] || []).concat(Math.round(ms)).slice(-STATS_PER_KEY));
    delete this.data[key]; this.data[key] = arr;        // reinsere: o mais usado fica no fim
    const keys = Object.keys(this.data); if (keys.length > STATS_KEYS) for (const k of keys.slice(0, keys.length - STATS_KEYS)) delete this.data[k];
    this.dirty = true;
  }
  // mediana e quantas vezes foi visto
  typical(key) { const a = this.data[key]; if (!a || a.length < 2) return null; const s = [...a].sort((x, y) => x - y); return { ms: s[Math.floor(s.length / 2)], n: a.length }; }
  flush() { if (!this.dirty || !this.file) return; this.dirty = false; try { fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 }); } catch {} }
}

// ---------------- uma conversa acompanhada ----------------
class Tracker {
  constructor(transcript, stats) {
    this.transcript = transcript; this.stats = stats;
    this.offset = -1; this.mtime = 0;
    this.pending = new Map();   // tool_use id -> { name, verb, what, key, at, sidechain }
    this.tasks = new Map();     // task id -> { id, kind, verb, what, key, at, output, toolUseId }
    this.lastAt = 0;
  }

  ingest(line) {
    if (!line || line[0] !== '{') return;
    let d; try { d = JSON.parse(line); } catch { return; }
    if (d.isSidechain) return;
    const at = ts(d.timestamp) || Date.now();
    if (d.type === 'assistant') {
      const c = d.message && d.message.content;
      if (!Array.isArray(c)) return;
      for (const b of c) if (b && b.type === 'tool_use' && b.id) {
        const { verb, what } = describe(b.name, b.input);
        const bg = !!(b.input && b.input.run_in_background);
        this.pending.set(b.id, { id: b.id, name: b.name, verb, what, key: statKey(b.name, b.input), at, bg });
        if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
      }
      this.lastAt = at;
    } else if (d.type === 'user') {
      const c = d.message && d.message.content;
      if (typeof c === 'string') { this.notification(c, at); this.lastAt = at; return; }
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string') this.notification(b.text, at);
        if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
        const p = this.pending.get(b.tool_use_id); this.pending.delete(b.tool_use_id);
        const txt = resultText(b.content);
        const bgId = p ? launchId(p.name, txt) : null;
        if (bgId && p) {
          const out = /Output is being written to: (\S+?\.output)/.exec(txt);
          const kind = (p.name === 'Agent' || p.name === 'Task') ? 'agent' : p.name === 'Workflow' ? 'workflow' : p.name === 'Monitor' ? 'monitor' : 'bash';
          this.tasks.set(bgId[1], { id: bgId[1], kind, verb: p.verb, what: p.what, key: p.key, at: p.at, output: out ? out[1] : null, toolUseId: p.id });
          if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value);
        } else if (p && !p.bg) {
          this.stats.add(p.key, at - p.at, p.id);
        }
        // o Claude parou uma tarefa
        if (p && /^(TaskStop|KillShell|KillBash)$/.test(p.name)) for (const id of this.tasks.keys()) if (txt.includes(id)) this.tasks.delete(id);
      }
      this.lastAt = at;
    } else if (d.type === 'queue-operation' && typeof d.content === 'string') {
      this.notification(d.content, at);
    }
  }

  notification(text, at) {
    if (!text.includes('<task-notification>')) return;
    for (const m of text.matchAll(/<task-id>([A-Za-z0-9_-]{4,60})<\/task-id>[\s\S]{0,1500}?<status>([a-z]+)<\/status>/g)) {
      const t = this.tasks.get(m[1]);
      if (!t) continue;
      if (m[2] === 'completed') this.stats.add(t.key, at - t.at, `task:${t.id}`);
      this.tasks.delete(m[1]);
    }
  }

  // lê só o que foi acrescentado desde a última vez
  update() {
    let st; try { st = fs.statSync(this.transcript); } catch { return false; }
    if (st.mtimeMs === this.mtime && st.size === this.offset) return false;
    let off = this.offset;
    if (off < 0 || st.size < off) { off = Math.max(0, st.size - FIRST_TAIL); this.pending.clear(); this.tasks.clear(); }
    let carry = '';
    const fd = fs.openSync(this.transcript, 'r');
    try {
      let first = this.offset < 0 && off > 0;
      while (off < st.size) {
        const len = Math.min(st.size - off, CHUNK);
        const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, off);
        const text = carry + buf.toString('utf8');
        const nl = text.lastIndexOf('\n');
        if (nl < 0) { carry = text.length > 4 * CHUNK ? '' : text; off += len; continue; }
        const lines = text.slice(0, nl).split('\n');
        if (first) { lines.shift(); first = false; }     // a 1ª linha do pedaço pode estar cortada
        for (const l of lines) this.ingest(l);
        carry = text.slice(nl + 1); off += len;
      }
    } finally { fs.closeSync(fd); }
    this.offset = st.size - Buffer.byteLength(carry); this.mtime = st.mtimeMs;
    return true;
  }

  agents(now) {
    const dir = path.join(path.dirname(this.transcript), path.basename(this.transcript, '.jsonl'), 'subagents');
    let files; try { files = fs.readdirSync(dir).filter(f => /^agent-[A-Za-z0-9_-]{4,60}\.meta\.json$/.test(f)); } catch { return []; }
    const out = [];
    for (const f of files) {
      const id = f.slice(6, -10);
      let meta; try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const jl = path.join(dir, `agent-${id}.jsonl`);
      let st; try { st = fs.statSync(jl); } catch { continue; }
      if (meta.finished && now - st.mtimeMs > DONE_LINGER_MS) continue;
      if (!meta.finished && now - st.mtimeMs > 6 * 3600 * 1000) continue;   // agente esquecido
      out.push({ id, meta, jl, st });
    }
    out.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    return out.slice(0, MAX_AGENTS).map(({ id, meta, jl, st }) => {
      let last = null; let since = st.birthtimeMs || st.ctimeMs;
      const tail = readTail(jl, AGENT_TAIL);
      if (tail) {
        const lines = tail.text.split('\n');
        for (let i = lines.length - 1; i >= 0 && !last; i--) {
          if (!lines[i].includes('"tool_use"')) continue;
          try { const d = JSON.parse(lines[i]); const b = (d.message.content || []).filter(x => x && x.type === 'tool_use').pop(); if (b) last = { ...describe(b.name, b.input), at: ts(d.timestamp) }; } catch {}
        }
      }
      const key = `agent:${meta.agentType || 'general'}`;
      return { id, type: clip(meta.agentType || 'agente', 40), what: clip(meta.description || '', 90), done: !!meta.finished, since, lastSignalAt: st.mtimeMs,
        background: meta.requestShape === 'background', last, typical: this.stats.typical(key) };
    });
  }

  snapshot(now = Date.now()) {
    let tmtime = this.mtime;
    const doing = [...this.pending.values()].filter(p => !p.bg && now - p.at < 12 * 3600 * 1000)
      .map(p => ({ id: p.id, name: p.name, verb: p.verb, what: p.what, since: p.at, typical: this.stats.typical(p.key) }));
    const tasks = [...this.tasks.values()].map(t => {
      const o = t.output ? lastLine(t.output) : null;
      const pct = o ? progressOf(o.line) : null;
      return { id: t.id, kind: t.kind, verb: t.verb, what: t.what, since: t.at, lastSignalAt: o ? o.mtime : null, line: o ? o.line : null, pct, typical: this.stats.typical(t.key) };
    }).filter(t => t.kind !== 'agent');   // agente em segundo plano aparece como agente (abaixo), não como tarefa
    const agents = this.agents(now);
    const signals = [tmtime, ...tasks.map(t => t.lastSignalAt || 0), ...agents.map(a => a.lastSignalAt || 0)];
    const lastSignalAt = Math.max(0, ...signals);
    const running = doing.length + tasks.length + agents.filter(a => !a.done).length;
    return { doing, tasks, agents, lastSignalAt, stalled: running > 0 && now - lastSignalAt > STALL_MS, at: now };
  }
}

// ---------------- vários terminais ----------------
// Quem chama diz qual transcrição cada terminal usa (vem dos hooks) e em que estado está. Atualiza a cada 2 s só os
// terminais com Claude ativo; manda para a tela só quando algo mudou.
class Activity {
  constructor({ statsFile, onChange, interval = 2000 } = {}) {
    this.stats = new Stats(statsFile); this.onChange = onChange || (() => {});
    this.trackers = new Map();   // transcript -> Tracker
    this.terms = new Map();      // termId -> { transcript, state }
    this.last = new Map();       // termId -> json enviado
    this.interval = interval; this.timer = null; this.flushTimer = null;
  }
  start() {
    this.timer = setInterval(() => this.tick(), this.interval);
    this.flushTimer = setInterval(() => this.stats.flush(), 60 * 1000);
    return this;
  }
  stop() { clearInterval(this.timer); clearInterval(this.flushTimer); this.timer = this.flushTimer = null; this.stats.flush(); }

  setTerm(id, { transcript, state }) {
    if (state === 'off') { this.terms.delete(id); this.last.delete(id); this.onChange({ id, activity: null }); this.gc(); return; }
    const cur = this.terms.get(id) || {};
    if (transcript && typeof transcript === 'string' && transcript.endsWith('.jsonl')) cur.transcript = transcript;
    if (state) cur.state = state;
    this.terms.set(id, cur);
    this.tickOne(id);
  }

  tracker(transcript) {
    let t = this.trackers.get(transcript);
    if (!t) {
      t = new Tracker(transcript, this.stats); this.trackers.set(transcript, t);
      if (this.trackers.size > MAX_TRACKED) this.gc(true);
    }
    return t;
  }

  gc(force) {
    const used = new Set([...this.terms.values()].map(x => x.transcript));
    for (const k of this.trackers.keys()) if (!used.has(k)) this.trackers.delete(k);
    if (force && this.trackers.size > MAX_TRACKED) for (const k of [...this.trackers.keys()].slice(0, this.trackers.size - MAX_TRACKED)) this.trackers.delete(k);
  }

  tickOne(id, now = Date.now()) {
    const x = this.terms.get(id);
    if (!x || !x.transcript) return;
    const t = this.tracker(x.transcript);
    try { t.update(); } catch { return; }
    const snap = t.snapshot(now);
    const quiet = (x.state === 'done' || x.state === 'idle') && !snap.tasks.length && !snap.agents.length;
    const activity = quiet ? null : { ...snap, state: x.state || null };
    // compara sem os campos que mudam sozinhos (hora)
    const sig = activity ? JSON.stringify({ ...activity, at: 0, stalled: activity.stalled }) : 'null';
    if (this.last.get(id) === sig) return;
    this.last.set(id, sig);
    this.onChange({ id, activity });
  }

  tick() {
    const now = Date.now();
    for (const [id, x] of this.terms) if (x.state === 'working' || x.state === 'background' || x.state === 'waiting' || this.last.get(id) !== 'null') this.tickOne(id, now);
  }

  list() {
    const out = {};
    for (const id of this.terms.keys()) { const s = this.last.get(id); if (s && s !== 'null') { try { out[id] = JSON.parse(s); } catch {} } }
    return out;
  }
}

module.exports = { Activity, Tracker, Stats, describe, statKey, progressOf, lastLine, OUTPUT_RE };
