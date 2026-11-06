// Estado de cada Claude aberto pela Bancada (BP-2026-11-05-001 E1): trabalhando / esperando você / terminou.
// Como: o claude é lançado com `--settings <USER_DIR/hooks/settings.json>` (soma aos hooks da athena — provado no T1.1).
// Cada hook roda `emit.sh <Evento>`, que grava UMA linha em events/<BANCADA_TERM_ID>.log. Sem porta, sem socket.
// Memória: cada arquivo é lido a partir do último byte lido; passou de 256 KB, é zerado. Nada cresce sem limite.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_LOG = 256 * 1024;
const STALE_MS = 10 * 60 * 1000;      // trabalhando sem evento por 10 min → "?" (ex.: Esc no meio, que não dispara Stop)
const BG_STALE_MS = 3 * 60 * 60 * 1000; // "esperando tarefa" sem notícia por 3 h → "?" (tarefa morta sem aviso)
const TAIL = 1024 * 1024;
const SCAN_MS = 2000;
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode', 'mcp__bancada__lista', 'mcp__bancada__perguntar']);   // v0.4: cartões da Bancada

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function emitScript(eventsDir) {
  // não escreve nada no stdout (no UserPromptSubmit, stdout viraria contexto do Claude); sempre sai 0
  return `#!/bin/sh
# Bancada: registra o evento do Claude deste terminal. Gerado automaticamente; pode apagar (é recriado).
umask 077
[ -n "$BANCADA_TERM_ID" ] || { cat >/dev/null; exit 0; }
case "$BANCADA_TERM_ID" in *[!A-Za-z0-9_-]*) cat >/dev/null; exit 0;; esac
p=$(cat | tr -d '\\n\\r' | cut -c1-1500)
printf '%s %s %s\\n' "$1" "$(date +%s)" "$p" >> ${q(eventsDir)}/"$BANCADA_TERM_ID.log" 2>/dev/null
exit 0
`;
}

// Interpreta uma linha "Evento epoch {json cortado}". Tolerante: o JSON pode vir cortado; só usamos regex.
function parseLine(line) {
  const m = /^([A-Za-z]+) (\d{9,11}) ?(.*)$/.exec(line);
  if (!m || !EVENTS.includes(m[1])) return null;
  const rest = m[3] || '';
  const pick = (k) => { const r = new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.){0,600})"`).exec(rest); return r ? r[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null; };
  return { event: m[1], at: Number(m[2]) * 1000, session_id: pick('session_id'), transcript_path: pick('transcript_path'), notification_type: pick('notification_type'), message: pick('message'), tool: pick('tool_name') };
}

// Tarefas em segundo plano ainda rodando nesta conversa (lê o fim da transcrição).
// Lançou: "Command running in background with ID: X" (Bash/Monitor) ou "agentId: X" de agente em segundo plano.
// Acabou: <task-notification> com <task-id>X</task-id> e <status>completed|failed|killed|stopped</status>,
// ou o Claude parou a tarefa (TaskStop/KillShell com o id).
function pendingBackground(transcript) {
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return 0;
  let text;
  try {
    const st = fs.statSync(transcript); const len = Math.min(st.size, TAIL);
    const buf = Buffer.alloc(len); const fd = fs.openSync(transcript, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return 0; }
  const started = new Set(); const ended = new Set();
  for (const m of text.matchAll(/running in background with ID: ([A-Za-z0-9_-]{4,40})/g)) started.add(m[1]);
  for (const m of text.matchAll(/launched in the background[^"]{0,200}?agentId: ([A-Za-z0-9_-]{4,40})/g)) started.add(m[1]);
  for (const m of text.matchAll(/<task-id>([A-Za-z0-9_-]{4,40})<\\?\/task-id>[\s\S]{0,1200}?<status>(completed|failed|killed|stopped|error|cancelled)/g)) ended.add(m[1]);
  for (const m of text.matchAll(/"(?:task_id|shell_id|bash_id)"\s*:\s*"([A-Za-z0-9_-]{4,40})"/g)) if (/TaskStop|KillShell|KillBash/.test(text.slice(Math.max(0, m.index - 400), m.index))) ended.add(m[1]);
  let n = 0; for (const id of started) if (!ended.has(id)) n++;
  return n;
}

// Máquina de estados (D2). Retorna o novo estado ou null se não muda.
// waitingSince: ferramentas em paralelo podem soltar PreToolUse logo depois do pedido de permissão; até 1,5 s isso não
// tira o "esperando você". Depois disso, PreToolUse/PostToolUse = o Claude seguiu (aprovado ou negado) → trabalhando.
function nextState(cur, ev, waitingSince = 0) {
  switch (ev.event) {
    case 'UserPromptSubmit': return 'working';
    // pergunta ao usuário (AskUserQuestion) ou plano para aprovar (ExitPlanMode): o Claude parou esperando você.
    // No "auto mode" quase não há pedido de permissão; este é o "esperando você" mais comum.
    case 'PreToolUse':
      if (ASKS.has(ev.tool)) return 'waiting';
      return cur === 'waiting' && (ev.now || ev.at) - waitingSince < 1500 ? null : 'working';
    case 'PostToolUse': return 'working';
    case 'Notification':
      // idle_prompt = "esperando seu próximo pedido" depois de terminar: não é pedido de permissão
      if (ev.notification_type === 'idle_prompt' || ev.notification_type === 'auth_success') return null;
      return 'waiting';
    case 'Stop': return ev.background > 0 ? 'background' : 'done';
    default: return null;
  }
}

class ClaudeHooks {
  constructor({ dir, onState }) {
    this.dir = dir; this.eventsDir = path.join(dir, 'events');
    this.onState = onState || (() => {});
    this.states = new Map();     // termId -> { state, since, workingSince, transcript, message }
    this.offsets = new Map();    // termId -> byte offset lido
    this.watcher = null; this.timer = null;
  }

  get settingsFile() { return path.join(this.dir, 'settings.json'); }

  setup() {
    fs.mkdirSync(this.eventsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); fs.chmodSync(this.eventsDir, 0o700); } catch {}
    const emit = path.join(this.dir, 'emit.sh');
    fs.writeFileSync(emit, emitScript(this.eventsDir), { mode: 0o700 });
    fs.chmodSync(emit, 0o700);
    const hooks = {};
    for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: `/bin/sh ${q(emit)} ${ev}`, timeout: 5 }] }];
    // v0.4: as ferramentas de cartão só perguntam ao usuário (não leem nem gravam nada): liberadas sem pedir permissão
    const permissions = { allow: ['mcp__bancada__lista', 'mcp__bancada__perguntar', 'mcp__bancada__pendencias'] };
    fs.writeFileSync(this.settingsFile, JSON.stringify({ hooks, permissions }, null, 1), { mode: 0o600 });
    // eventos de sessões antigas não valem: começa limpo
    for (const f of fs.readdirSync(this.eventsDir)) if (f.endsWith('.log')) { try { fs.unlinkSync(path.join(this.eventsDir, f)); } catch {} }
    return this.settingsFile;
  }

  start() {
    try { this.watcher = fs.watch(this.eventsDir, (_t, f) => { if (f) this.readFile(String(f)); }); this.watcher.on('error', () => {}); } catch {}
    // reserva: fs.watch pode perder evento; varre só se há terminal com estado ou arquivo novo
    this.timer = setInterval(() => this.scan(), SCAN_MS);
  }

  stop() { if (this.watcher) this.watcher.close(); clearInterval(this.timer); this.watcher = null; this.timer = null; }

  scan() {
    let files = []; try { files = fs.readdirSync(this.eventsDir); } catch { return; }
    for (const f of files) this.readFile(f);
    const now = Date.now();
    for (const [id, s] of this.states) {
      if (s.state === 'working' && now - s.lastEventAt > STALE_MS) this.set(id, 'unknown', {});
      if (s.state === 'background' && now - s.lastEventAt > BG_STALE_MS) this.set(id, 'unknown', {});
    }
  }

  readFile(name) {
    if (!name.endsWith('.log')) return;
    const id = name.slice(0, -4);
    if (!ID_RE.test(id)) return;
    const file = path.join(this.eventsDir, name);
    let st; try { st = fs.statSync(file); } catch { return; }
    let off = this.offsets.get(id) || 0;
    if (st.size < off) off = 0;                       // arquivo zerado
    // lê em blocos de até 256 KB até alcançar o fim (memória limitada mesmo se o arquivo crescer muito)
    while (off < st.size) {
      const len = Math.min(st.size - off, MAX_LOG);
      let text = '';
      try { const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, off); fs.closeSync(fd); text = buf.toString('utf8'); } catch { return; }
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) break;                           // linha ainda incompleta
      off += Buffer.byteLength(text.slice(0, lastNl + 1));
      for (const line of text.slice(0, lastNl).split('\n')) { const ev = parseLine(line); if (ev) this.apply(id, ev); }
    }
    this.offsets.set(id, off);
    if (off >= MAX_LOG) {
      // zera só se ninguém escreveu nada depois do que lemos (senão perderia a linha nova)
      try { if (fs.statSync(file).size === off) { fs.truncateSync(file, 0); this.offsets.set(id, 0); } } catch {}
    }
  }

  apply(id, ev) {
    const cur = this.states.get(id) || { state: 'idle' };
    if (ev.transcript_path) cur.transcript = ev.transcript_path;
    cur.lastEventAt = ev.now = Date.now();
    if (ev.event === 'Stop') ev.background = pendingBackground(cur.transcript);
    this.states.set(id, cur);
    const next = nextState(cur.state, ev, cur.state === 'waiting' ? cur.since : 0);
    if (!next || next === cur.state) return;
    const message = ev.event === 'Notification' ? ev.message : ASKS.has(ev.tool) ? (ev.tool === 'ExitPlanMode' ? 'plano para aprovar' : ev.tool === 'mcp__bancada__lista' ? 'tem uma lista para você marcar' : 'tem uma pergunta para você') : null;
    this.set(id, next, { message });
  }

  set(id, state, { message = null } = {}) {
    const cur = this.states.get(id) || {};
    const prev = cur.state || 'idle';
    const now = Date.now();
    // o tempo de trabalho atravessa pedidos de permissão e tarefas em segundo plano (o aviso "terminou" conta tudo)
    const workedMs = (prev === 'working' || prev === 'background') && cur.workingSince ? now - cur.workingSince : 0;
    if (state === 'working' && prev !== 'working') cur.workingSince = ((prev === 'waiting' || prev === 'background') && cur.workingSince) ? cur.workingSince : now;
    if (state !== 'working' && state !== 'waiting' && state !== 'background') cur.workingSince = null;
    Object.assign(cur, { state, since: now, message, lastEventAt: cur.lastEventAt || now });
    this.states.set(id, cur);
    this.onState({ id, state, prev, since: now, workedMs, message, transcript: cur.transcript || null });
  }

  // o usuário olhou o terminal: "terminou" vira normal
  seen(id) { const s = this.states.get(id); if (s && (s.state === 'done' || s.state === 'unknown')) this.set(id, 'idle'); }
  // pty encerrou/foi fechado
  reset(id) {
    if (this.states.has(id)) { this.states.delete(id); this.onState({ id, state: 'off', prev: null, since: Date.now(), workedMs: 0 }); }
    this.offsets.delete(id);
    try { fs.unlinkSync(path.join(this.eventsDir, `${id}.log`)); } catch {}
  }
  get(id) { return this.states.get(id) || null; }
  list() { return [...this.states.entries()].map(([id, s]) => ({ id, state: s.state, since: s.since, message: s.message || null })); }
}

module.exports = { ClaudeHooks, parseLine, nextState, emitScript, pendingBackground };
