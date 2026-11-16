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
const plat = require('./platform');

const FIRST_TAIL = 1024 * 1024;       // primeira leitura: só o último 1 MB da conversa
const CHUNK = 512 * 1024;
const MAX_PENDING = 200;
const MAX_TASKS = 50;
const MAX_AGENTS = 40;
const MAX_TRACKED = 30;               // transcrições acompanhadas ao mesmo tempo
const OUT_TAIL = 4096;
const AGENT_TAIL = 64 * 1024;
const STALL_MS = 2 * 60 * 1000;       // "Pensando" sem ferramenta, sem tarefa e sem nenhum sinal por 2 min → "sem sinal"
const SILENT_MS = 2 * 60 * 1000;      // tarefa/agente sem saída nova por 2 min → "rodando em silêncio" (NÃO é "sem sinal")
const DONE_LINGER_MS = 20 * 1000;     // agente que acabou de terminar ainda aparece um pouco (volta para o sofá)
const STATS_KEYS = 300;
const STATS_PER_KEY = 20;
const MIN_STAT_MS = 5000;             // só aprende com o que demora (o rápido não precisa de previsão)
// saída de tarefa do Claude Code: /private/tmp/claude-<uid>/<projeto>/<sessão>/tasks/<id>.output (nada fora disso é lido)
const MAX_ENDED = 400;                // ids de tarefas que já acabaram (para a lista do Stop não ressuscitar ninguém)
const ID = '[A-Za-z0-9_-]{4,60}';     // mesmo limite de id em todo lugar (lançamento, fim, lista oficial)
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
  if (typeof file !== 'string' || /[\\/]\.\.[\\/]/.test(file) || !(OUTPUT_RE.test(file) || (plat.IS_WIN && plat.OUTPUT_RE_WIN.test(file)))) return null;
  try {
    // o caminho real (sem link simbólico no arquivo nem nas pastas) também tem de estar na pasta de tarefas do Claude deste usuário
    const real = fs.realpathSync(file);
    if (!plat.taskOutputOk(real)) return null;
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
// Fonte ÚNICA de "foi para o segundo plano": a faixa, o Escritório e o Stop (hooks.js) usam esta função.
const LAUNCH = {
  Bash: new RegExp(`^Command running in background with ID: (${ID})`),
  Monitor: new RegExp(`^Monitor started \\(task (${ID})`),
  Agent: new RegExp(`^Async agent launched successfully[\\s\\S]{0,300}?agentId: (${ID})`),
  Workflow: /^Workflow[^\n]{0,80}?\b(wf_[A-Za-z0-9_-]{4,56}|[a-z0-9]{8,40})\b/i,
};
LAUNCH.Task = LAUNCH.Agent;
function launchId(name, txt) {
  const re = LAUNCH[name];
  return re ? re.exec(String(txt).slice(0, 400)) : null;
}
// tipo da lista oficial (background_tasks do Stop) → tipo da tarefa na tela
function kindOfType(type) {
  const t = String(type || '').toLowerCase();
  if (/agent/.test(t)) return 'agent';
  if (/monitor/.test(t)) return 'monitor';
  if (/workflow/.test(t)) return 'workflow';
  return 'bash';
}
const KIND_VERB = { bash: 'Rodando', monitor: 'Vigiando', workflow: 'Fluxo de agentes', agent: 'Agente' };

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
    this.ended = new Set();     // ids que a transcrição diz que acabaram (com teto)
    this.lastAt = 0;
    this.limit = null;          // { at, text }: a última resposta foi "limite de uso atingido"
    this.outDir = null;         // pasta das saídas de tarefa (aprendida dos caminhos que o Claude mostra)
  }

  // saída de uma tarefa cujo resultado não traz o caminho (Monitor, Workflow): mesma pasta das outras tarefas desta
  // conversa, ou o padrão do Claude Code (<tmp>/claude-<uid>/<pasta do projeto>/<sessão>/tasks/<id>.output)
  outputOf(id) {
    if (this.outDir) return path.join(this.outDir, `${id}.output`);
    if (plat.IS_WIN || typeof process.getuid !== 'function') return null;
    return path.join('/private/tmp', `claude-${process.getuid()}`, path.basename(path.dirname(this.transcript)), path.basename(this.transcript, '.jsonl'), 'tasks', `${id}.output`);
  }

  ingest(line) {
    if (!line || line[0] !== '{') return;
    let d; try { d = JSON.parse(line); } catch { return; }
    if (d.isSidechain) return;
    const at = ts(d.timestamp) || Date.now();
    // limite de uso: o Claude Code grava uma resposta de erro ("You've hit your limit · resets 3pm"); qualquer linha
    // normal depois disso (resposta, ferramenta, novo pedido) apaga o aviso
    if (d.type === 'assistant' || d.type === 'user') {
      const c = d.message && d.message.content;
      const txt = Array.isArray(c) ? c.map(b => (b && typeof b.text === 'string') ? b.text : '').join(' ') : typeof c === 'string' ? c : '';
      if (d.type === 'assistant' && (d.isApiErrorMessage || d.error) && (/rate_limit|limit/i.test(String(d.error || '')) || /\blimit\b|limite/i.test(txt))) { this.limit = { at, text: clip(txt, 80) }; this.lastAt = at; return; }
      if (this.limit && !d.isMeta) this.limit = null;
    }
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
          const out = /Output is being written to: ([^\n"]{1,500}?\.output)/.exec(txt);
          if (out) this.outDir = path.dirname(out[1]);
          const kind = (p.name === 'Agent' || p.name === 'Task') ? 'agent' : p.name === 'Workflow' ? 'workflow' : p.name === 'Monitor' ? 'monitor' : 'bash';
          this.tasks.set(bgId[1], { id: bgId[1], kind, verb: p.verb, what: p.what, key: p.key, at: p.at, output: out ? out[1] : (kind === 'agent' ? null : this.outputOf(bgId[1])), toolUseId: p.id });
          if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value);
        } else if (p && !p.bg) {
          this.stats.add(p.key, at - p.at, p.id);
        }
        // o Claude parou uma tarefa
        if (p && /^(TaskStop|KillShell|KillBash)$/.test(p.name)) for (const id of this.tasks.keys()) if (txt.includes(id)) this.end(id);
      }
      this.lastAt = at;
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      this.compactAt = at;
    } else if (d.type === 'queue-operation' && typeof d.content === 'string') {
      this.notification(d.content, at);
    }
  }

  notification(text, at) {
    if (!text.includes('<task-notification>')) return;
    for (const m of text.matchAll(new RegExp(`<task-id>(${ID})<\\/task-id>[\\s\\S]{0,1500}?<status>([a-z]+)<\\/status>`, 'g'))) {
      const t = this.tasks.get(m[1]);
      if (t && m[2] === 'completed') this.stats.add(t.key, at - t.at, `task:${t.id}`);
      this.end(m[1]);
    }
  }

  end(id) {
    this.tasks.delete(id); this.ended.add(id);
    if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.values().next().value);
  }

  // lê só o que foi acrescentado desde a última vez
  update() {
    let st; try { st = fs.statSync(this.transcript); } catch { return false; }
    if (st.mtimeMs === this.mtime && st.size === this.offset) return false;
    let off = this.offset;
    if (off < 0 || st.size < off) { off = Math.max(0, st.size - FIRST_TAIL); this.pending.clear(); this.tasks.clear(); this.ended.clear(); }
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

  // info (dos hooks): { bg: { at, list } } — lista oficial do que segue rodando, do último Stop/SubagentStop.
  // Junta as duas fontes: o que a transcrição sabe (o quê, desde quando, saída) + o que a lista oficial diz que roda
  // (inclusive o que a transcrição não mostra, como um Workflow de formato novo). O que a transcrição diz que acabou
  // não volta pela lista (ela é de antes).
  snapshot(now = Date.now(), info = null) {
    let tmtime = this.mtime;
    const doing = [...this.pending.values()].filter(p => !p.bg && now - p.at < 12 * 3600 * 1000)
      .map(p => ({ id: p.id, name: p.name, verb: p.verb, what: p.what, since: p.at, typical: this.stats.typical(p.key) }));
    const official = info && info.bg && Array.isArray(info.bg.list)
      ? info.bg.list.filter(o => o && o.id && !/^(completed|failed|killed|stopped|error|cancelled|canceled|done)$/i.test(o.status || '') && !this.ended.has(o.id)) : [];
    const offAt = info && info.bg ? info.bg.at : now;
    const byId = new Map(official.map(o => [o.id, o]));
    const tasks = [...this.tasks.values()].map(t => {
      const o = t.output ? lastLine(t.output) : null;
      const pct = o ? progressOf(o.line) : null;
      return { id: t.id, kind: t.kind, verb: t.verb, what: t.what, since: t.at, lastSignalAt: o ? o.mtime : null, line: o ? o.line : null, pct, typical: this.stats.typical(t.key), official: byId.has(t.id) };
    }).filter(t => t.kind !== 'agent');   // agente em segundo plano aparece como agente (abaixo), não como tarefa
    for (const o of official) {
      const kind = kindOfType(o.type);
      if (kind === 'agent' || this.tasks.has(o.id) || tasks.length >= MAX_TASKS) continue;
      const f = this.outputOf(o.id); const ol = f ? lastLine(f) : null;
      tasks.push({ id: o.id, kind, verb: KIND_VERB[kind], what: clip(o.description || '', 90), since: offAt, lastSignalAt: ol ? ol.mtime : null, line: ol ? ol.line : null, pct: ol ? progressOf(ol.line) : null, typical: null, official: true });
    }
    // em silêncio: sem saída nova há 2 min — segue rodando (a lista oficial / a falta de aviso de fim dizem isso)
    for (const t of tasks) { t.quietMs = now - (t.lastSignalAt || t.since); t.silent = t.quietMs > SILENT_MS; }
    const agents = this.agents(now);
    // agente lançado (transcrição) ou listado como rodando (lista oficial) que ainda não tem meta.json: entra assim mesmo
    const have = new Set(agents.map(a => a.id));
    const extra = [...[...this.tasks.values()].filter(t => t.kind === 'agent').map(t => ({ id: t.id, type: (/^agent:(.+)$/.exec(t.key) || [])[1], what: t.what, since: t.at })),
      ...official.filter(o => kindOfType(o.type) === 'agent').map(o => ({ id: o.id, type: o.agent_type, what: o.description, since: offAt }))];
    // subagentes vistos pelos hooks (SubagentStart antes do meta.json existir; agente em primeiro plano)
    const hooked = info && info.agents instanceof Map ? info.agents : new Map();
    for (const h of hooked.values()) if (!h.done && now - h.lastAt < 6 * 3600 * 1000) extra.push({ id: h.id, type: h.type, what: '', since: h.startedAt });
    // agente que os hooks viram sair (SubagentStop) não volta, mesmo sem o aviso de fim na transcrição
    const ended = info && info.ended instanceof Set ? info.ended : null;
    if (ended) for (const [id, t] of this.tasks) if (t.kind === 'agent' && ended.has(id)) this.tasks.delete(id);
    for (const x of extra) {
      if (have.has(x.id) || agents.length >= MAX_AGENTS || (ended && ended.has(x.id))) continue;
      have.add(x.id);
      agents.push({ id: x.id, type: clip(x.type && x.type !== 'general' ? x.type : 'agente', 40), what: clip(x.what || '', 90), done: false, since: x.since, lastSignalAt: x.since, background: true, last: null, typical: this.stats.typical(`agent:${x.type || 'general'}`) });
    }
    // o que os hooks sabem é mais novo que o arquivo do agente: ferramenta atual, último sinal, saiu
    for (let i = agents.length - 1; i >= 0; i--) {
      const ag = agents[i]; const h = hooked.get(ag.id);
      if (!h) continue;
      if (h.tool && h.toolAt >= ((ag.last && ag.last.at) || 0)) ag.last = { ...describe(h.tool, {}), at: h.toolAt };
      ag.lastSignalAt = Math.max(ag.lastSignalAt || 0, h.lastAt);
      if (h.type && ag.type === 'agente') ag.type = clip(h.type, 40);
      if (h.done) { ag.done = true; if (now - h.doneAt > DONE_LINGER_MS) agents.splice(i, 1); }
    }
    for (const a of agents) { a.quietMs = now - (a.lastSignalAt || a.since); a.silent = !a.done && a.quietMs > SILENT_MS; }
    const hookAt = info && info.lastEventAt ? info.lastEventAt : 0;
    const signals = [tmtime, hookAt, ...tasks.map(t => t.lastSignalAt || 0), ...agents.map(a => a.lastSignalAt || 0)];
    const lastSignalAt = Math.max(0, ...signals);
    const count = tasks.length + agents.filter(a => !a.done).length;
    const compacting = info && info.compacting && !(this.compactAt >= info.compacting) ? info.compacting : 0;
    const limit = this.limit ? { ...this.limit } : null;
    // "sem sinal" só quando realmente sumiu: o principal "Pensando" sem ferramenta, sem nada rodando, sem compactar e sem
    // nenhum sinal (transcrição, hooks, saídas) há 2 min. Tarefa calada com a lista oficial dizendo que roda NÃO é isso.
    const state = info && info.state;
    const stalled = !limit && !compacting && ((state === 'working' && !doing.length && !count && now - lastSignalAt > STALL_MS) || (state === 'unknown' && !doing.length && !count));
    return { doing, tasks, agents, lastSignalAt, count, compacting, limit, stalled, at: now };
  }
}

// ---------------- vários terminais ----------------
// Quem chama diz qual transcrição cada terminal usa (vem dos hooks) e em que estado está. Atualiza a cada 2 s só os
// terminais com Claude ativo; manda para a tela só quando algo mudou.
class Activity {
  constructor({ statsFile, onChange, interval = 2000, now = Date.now, hookInfo = null } = {}) {
    this.stats = new Stats(statsFile); this.onChange = onChange || (() => {});
    this.now = now;                              // relógio (injetado nos testes)
    this.hookInfo = hookInfo || (() => null);    // (termId) → estado dos hooks: lista oficial de tarefas, subagentes
    this.snaps = new Map();                      // termId -> último snapshot (objeto)
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
  stop() { if (this.pokes) { for (const t of this.pokes.values()) clearTimeout(t); this.pokes.clear(); } clearInterval(this.timer); clearInterval(this.flushTimer); this.timer = this.flushTimer = null; this.stats.flush(); }

  setTerm(id, { transcript, state }) {
    if (state === 'off') { this.terms.delete(id); this.last.delete(id); this.snaps.delete(id); this.onChange({ id, activity: null }); this.gc(); return; }
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

  tickOne(id, now = this.now()) {
    const x = this.terms.get(id);
    if (!x || !x.transcript) return;
    const t = this.tracker(x.transcript);
    try { t.update(); } catch { return; }
    let info = null; try { info = this.hookInfo(id); } catch {}
    const snap = t.snapshot(now, info);
    this.snaps.set(id, snap);
    const quiet = (x.state === 'done' || x.state === 'idle') && !snap.tasks.length && !snap.agents.length && !snap.limit;
    const activity = quiet ? null : { ...snap, state: x.state || null };
    // compara sem os campos que mudam sozinhos (hora)
    const sig = activity ? JSON.stringify({ ...activity, at: 0, stalled: activity.stalled }) : 'null';
    if (this.last.get(id) === sig) return;
    this.last.set(id, sig);
    this.onChange({ id, activity });
  }

  // v0.6: um evento de hook chegou para este terminal — relê já (com folga de 120 ms para o Claude terminar de gravar a
  // transcrição e para juntar rajadas de eventos numa leitura só). Um timer por terminal, nunca acumula.
  poke(id, ev) {
    const x = this.terms.get(id);
    if (!x) return;
    this.pokes = this.pokes || new Map();
    if (this.pokes.has(id)) return;
    this.pokes.set(id, setTimeout(() => { this.pokes.delete(id); this.tickOne(id); }, 120));
  }

  // tem coisa em andamento (ferramenta, tarefa, agente)? Os hooks não marcam "?" por silêncio enquanto houver.
  busy(id) {
    const s = this.snaps.get(id);
    return !!(s && (s.doing.length || s.tasks.length || s.agents.some(a => !a.done)));
  }

  tick() {
    const now = this.now();
    for (const [id, x] of this.terms) if (x.state === 'working' || x.state === 'background' || x.state === 'waiting' || this.last.get(id) !== 'null') this.tickOne(id, now);
  }

  list() {
    const out = {};
    for (const id of this.terms.keys()) { const s = this.last.get(id); if (s && s !== 'null') { try { out[id] = JSON.parse(s); } catch {} } }
    return out;
  }
}

// O que a transcrição diz que ainda roda em segundo plano (ids). Usado pelo Stop quando não vem a lista oficial.
function pendingLaunches(transcript) {
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return [];
  const t = new Tracker(transcript, new Stats(null));
  try { t.update(); } catch { return []; }
  return [...t.tasks.keys()];
}

module.exports = { Activity, Tracker, Stats, describe, statKey, progressOf, lastLine, launchId, kindOfType, pendingLaunches, OUTPUT_RE };
