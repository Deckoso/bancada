// Estado de cada Claude aberto pela Bancada (BP-2026-11-05-001 E1): trabalhando / esperando você / terminou.
// Como: o claude é lançado com `--settings <USER_DIR/hooks/settings.json>` (soma aos hooks da athena — provado no T1.1).
// Cada hook roda `emit.sh <Evento>`, que grava UMA linha em events/<BANCADA_TERM_ID>.log. Sem porta, sem socket.
// Memória: cada arquivo é lido a partir do último byte lido; passou de 256 KB, é zerado. Nada cresce sem limite.
'use strict';
const fs = require('fs');
const path = require('path');
const plat = require('./platform');
const { pendingLaunches } = require('./activity');

const MAX_LOG = 256 * 1024;
const STALE_MS = 10 * 60 * 1000;      // trabalhando sem evento por 10 min → "?" (ex.: Esc no meio, que não dispara Stop)
const BG_STALE_MS = 3 * 60 * 60 * 1000; // "esperando tarefa" sem notícia por 3 h → "?" (tarefa morta sem aviso)
const TAIL = 1024 * 1024;
const SCAN_MS = 2000;
// v0.6: + subagentes, pedido de permissão e falha de ferramenta (conferidos no Claude Code 2.1.323 em 13/11: SubagentStart/Stop
// trazem agent_id e agent_type). Cada evento também "cutuca" o Escritório, que reage na hora em vez de esperar a varredura.
// v0.8: + PreCompact (compactação da conversa: o boneco "Compactando", não "Pensando" parado)
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
// eventos que um SUBAGENTE também dispara (vêm com agent_id): vão para o boneco dele, nunca mudam o estado do principal
const SUB_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']);
const MAX_SUBAGENTS = 40;
const MAX_ENDED = 2000;            // ids de subagentes terminados lembrados por terminal (só strings curtas)
const LATE_AFTER_STOP = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']);
const MAX_BG = 40;                     // tarefas em segundo plano lidas de um evento
// Corte do payload gravado: até 8000 bytes inteiro; maior que isso, começo (2000) + fim (6000). O background_tasks do
// Stop costuma vir no FIM do JSON, depois do last_assistant_message (que pode ser enorme): o corte antigo (só o começo,
// 1500) o perdia. clipPayload é o espelho em JS do que o emit.sh grava (o teste confere os dois iguais).
const CLIP_MAX = 8000, CLIP_HEAD = 2000, CLIP_TAIL = 6000, CLIP_SEP = ' ... ';
const ENDED = /^(completed|failed|killed|stopped|error|cancelled|canceled|done)$/i;
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode', 'mcp__bancada__lista', 'mcp__bancada__perguntar']);   // v0.4: cartões da Bancada

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function emitScript(eventsDir) {
  // não escreve nada no stdout (no UserPromptSubmit, stdout viraria contexto do Claude); sempre sai 0
  return `#!/bin/sh
# Bancada: registra o evento do Claude deste terminal. Gerado automaticamente; pode apagar (é recriado).
umask 077
[ -n "$BANCADA_TERM_ID" ] || { cat >/dev/null; exit 0; }
case "$BANCADA_TERM_ID" in *[!A-Za-z0-9_-]*) cat >/dev/null; exit 0;; esac
p=$(cat | tr -d '\\n\\r')
if [ "$(printf '%s' "$p" | wc -c)" -gt ${CLIP_MAX} ]; then p="$(printf '%s' "$p" | head -c ${CLIP_HEAD})${CLIP_SEP}$(printf '%s' "$p" | tail -c ${CLIP_TAIL})"; fi
printf '%s %s %s\\n' "$1" "$(date +%s)" "$p" >> ${q(eventsDir)}/"$BANCADA_TERM_ID.log" 2>/dev/null
exit 0
`;
}

// Windows (v0.7): o mesmo registro em PowerShell. Lê a entrada como UTF-8 (o console do PowerShell 5.1 não é), grava com
// carimbo em MILISSEGUNDOS (os hooks do Windows rodam em segundo plano e podem chegar fora de ordem: o carimbo fino deixa
// a Bancada descartar um "ferramenta terminou" que chega depois do "parou") e tenta de novo se outro hook segura o arquivo.
function emitScriptPs(eventsDir) {
  const dir = String(eventsDir).replace(plat.PS_SQ, '$&$&');   // aspas simples e tipográficas dobradas (literal no PowerShell)
  return `# Bancada: registra o evento do Claude deste terminal. Gerado automaticamente; pode apagar (é recriado).
param([string]$Ev)
$ErrorActionPreference = 'SilentlyContinue'
$ms = New-Object System.IO.MemoryStream
try { [Console]::OpenStandardInput().CopyTo($ms) } catch {}
$id = $env:BANCADA_TERM_ID
if (-not $id -or $id -notmatch '^[A-Za-z0-9_-]{1,80}$' -or $Ev -notmatch '^[A-Za-z]{1,40}$') { exit 0 }
$p = [Text.Encoding]::UTF8.GetString($ms.ToArray()) -replace "[\\r\\n]", ''
if ($p.Length -gt ${CLIP_MAX}) { $p = $p.Substring(0, ${CLIP_HEAD}) + '${CLIP_SEP}' + $p.Substring($p.Length - ${CLIP_TAIL}) }
$t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$f = Join-Path '${dir}' "$id.log"
$enc = New-Object System.Text.UTF8Encoding($false)
for ($i = 0; $i -lt 8; $i++) { try { [IO.File]::AppendAllText($f, "$Ev $t $p\`n", $enc); break } catch { Start-Sleep -Milliseconds 25 } }
exit 0
`;
}

// ---------- Windows leve (v0.8): cmd.exe + hook.cmd + hook.js com o executável da Bancada em modo Node ----------
// Medido no T0.5 (proxy no Mac): PowerShell com script ~280 ms e ~114 MB por evento; Electron-como-Node ~60 ms e ~13 MB.
// O hook do Claude não tem campo "env": quem liga o ELECTRON_RUN_AS_NODE é um .cmd gerado (só ASCII: o cmd lê o .cmd na
// página de código do console). O caminho do executável entra pelo prefixo de uma variável do Windows (%LOCALAPPDATA%…)
// — o nome do usuário com acento fica fora do arquivo; se ainda sobrar acento, usa %BANCADA_EXE%, que a Bancada põe no
// ambiente de cada terminal. O hook.js fica ao lado do .cmd (%~dp0): o asar do app não é legível por outro processo.
// Reserva (BANCADA_HOOKS_PS=1, ou pasta de dados OU executável com & ^ % ( ) ! " < > | no caminho, que o cmd.exe não
// aceita entre aspas numa linha de comando): volta para o emit.ps1 em PowerShell de antes. O .cmd desliga a expansão
// tardia (DisableDelayedExpansion): mesmo se o registro do usuário a ligar, um ! no caminho não é interpretado.
const WIN_ENV_PREFIXES = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot'];
const CMD_UNSAFE = /[&^%()!"<>|]/;
function cmdExePath(exe, env = process.env) {
  let best = null;
  for (const k of WIN_ENV_PREFIXES) {
    const v = env[k] ? String(env[k]).replace(/[\\/]+$/, '') : '';
    if (!v || v.length < 3) continue;
    if (String(exe).toLowerCase().startsWith(v.toLowerCase() + '\\') && (!best || v.length > best.v.length)) best = { k, v };
  }
  const out = best ? `%${best.k}%` + String(exe).slice(best.v.length).replace(/%/g, '%%') : String(exe).replace(/%/g, '%%');
  return /^[\x20-\x7e]+$/.test(out) ? out : null;     // null → só pelo %BANCADA_EXE% do ambiente
}
// .cmd que roda <script ao lado> com o executável da Bancada em modo Node, repassando os argumentos
function cmdLauncher(script, exe, env = process.env, { args = '%*' } = {}) {
  const enc = cmdExePath(exe, env);
  return ['@echo off',
    'rem Bancada: gerado automaticamente; pode apagar (e recriado).',
    'setlocal DisableDelayedExpansion',
    'set "ELECTRON_RUN_AS_NODE=1"',
    enc ? `set "BANCADA_RUN=${enc}"` : 'set "BANCADA_RUN=%BANCADA_EXE%"',
    `"%BANCADA_RUN%" "%~dp0${script}" ${args}`.trimEnd(),
    ''].join('\r\n');
}
function hookCmd(exe, env = process.env) { return cmdLauncher('hook.js', exe, env, { args: '%1' }); }

function clipPayload(p) {
  const b = Buffer.from(String(p).replace(/[\r\n]/g, ''), 'utf8');
  if (b.length <= CLIP_MAX) return b.toString('utf8');
  return b.subarray(0, CLIP_HEAD).toString('utf8') + CLIP_SEP + b.subarray(b.length - CLIP_TAIL).toString('utf8');
}

const cl = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : null);
// "background_tasks":[{id,type,status,description,agent_type?}] — lista oficial do que segue rodando depois do turno.
// Lê o array inteiro (casando colchetes fora de aspas); se veio cortado, aproveita só os objetos completos.
// null = o campo não veio (versão antiga do Claude Code); [] = veio vazio (nada rodando).
function bgTasks(rest) { return bgSpan(rest).list; }
function bgSpan(rest) {
  const none = { list: null, from: -1, to: -1 };
  const i = rest.indexOf('"background_tasks":');
  if (i < 0) return none;
  const j = rest.indexOf('[', i);
  if (j < 0 || j > i + 25) return none;
  let depth = 0, str = false, esc = false, end = -1;
  for (let k = j; k < rest.length; k++) {
    const c = rest[k];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) { end = k; break; }
  }
  let arr = null;
  if (end > 0) { try { arr = JSON.parse(rest.slice(j, end + 1)); } catch { arr = null; } }
  if (!Array.isArray(arr)) {
    arr = [];
    for (const m of rest.slice(j + 1).matchAll(/\{(?:[^{}"]|"(?:[^"\\]|\\.)*")*\}/g)) { try { arr.push(JSON.parse(m[0])); } catch {} if (arr.length >= MAX_BG) break; }
  }
  const list = arr.filter(o => o && typeof o === 'object' && typeof o.id === 'string' && ID_RE.test(o.id)).slice(0, MAX_BG)
    .map(o => ({ id: o.id, type: cl(o.type, 30) || 'task', status: cl(o.status, 20) || 'running', description: cl(o.description, 160) || '', agent_type: cl(o.agent_type, 60) }));
  return { list, from: i, to: end > 0 ? end + 1 : rest.length };
}
const runningOf = (list) => list.filter(t => !ENDED.test(t.status));

// Interpreta uma linha "Evento epoch {json cortado}". Tolerante: o JSON pode vir cortado; os campos simples saem por
// regex e a lista de tarefas em segundo plano por um leitor que casa colchetes.
function parseLine(line) {
  const m = /^([A-Za-z]+) (\d{9,13}) ?(.*)$/.exec(line);
  if (!m || !EVENTS.includes(m[1])) return null;
  const raw = m[3] || '';
  // os campos de cima (agent_id, agent_type…) nunca são lidos de dentro da lista de tarefas (que também tem agent_type)
  const bg = bgSpan(raw);
  const rest = bg.from >= 0 ? raw.slice(0, bg.from) + raw.slice(bg.to) : raw;
  const pick = (k) => { const r = new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.){0,600})"`).exec(rest); return r ? r[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null; };
  // Mac grava segundos (10 dígitos); Windows grava milissegundos (13)
  return { event: m[1], at: m[2].length > 11 ? Number(m[2]) : Number(m[2]) * 1000, session_id: pick('session_id'), transcript_path: pick('transcript_path'), notification_type: pick('notification_type'), message: pick('message'), tool: pick('tool_name'), agent_id: pick('agent_id'), agent_type: pick('agent_type'),
    agent_transcript_path: pick('agent_transcript_path'), trigger: pick('trigger'), bg_tasks: bg.list };
}

// Tarefas em segundo plano ainda rodando nesta conversa, pela transcrição (reserva para quando o Stop não traz o
// background_tasks). Usa o MESMO detector de lançamentos da faixa e do Escritório (activity.js: launchId).
function pendingBackground(transcript) { return pendingLaunches(transcript).length; }

// Máquina de estados (D2). Retorna o novo estado ou null se não muda.
// waitingSince: ferramentas em paralelo podem soltar PreToolUse logo depois do pedido de permissão; até 1,5 s isso não
// tira o "esperando você". Depois disso, PreToolUse/PostToolUse = o Claude seguiu (aprovado ou negado) → trabalhando.
function nextState(cur, ev, waitingSince = 0) {
  switch (ev.event) {
    case 'UserPromptSubmit': case 'PreCompact': return 'working';
    // pergunta ao usuário (AskUserQuestion) ou plano para aprovar (ExitPlanMode): o Claude parou esperando você.
    // No "auto mode" quase não há pedido de permissão; este é o "esperando você" mais comum.
    case 'PreToolUse':
      if (ASKS.has(ev.tool)) return 'waiting';
      return cur === 'waiting' && (ev.now || ev.at) - waitingSince < 1500 ? null : 'working';
    case 'PostToolUse': case 'PostToolUseFailure': return 'working';
    case 'PermissionRequest': return 'waiting';
    case 'Notification':
      // idle_prompt = "esperando seu próximo pedido" depois de terminar: não é pedido de permissão
      if (ev.notification_type === 'idle_prompt' || ev.notification_type === 'auth_success') return null;
      return 'waiting';
    case 'Stop': return ev.background > 0 ? 'background' : 'done';
    default: return null;
  }
}

class ClaudeHooks {
  constructor({ dir, onState, onEvent, win = plat.IS_WIN, now = Date.now, busy = null, exe = process.execPath, env = process.env, extra = null }) {
    this.dir = dir; this.win = win; this.eventsDir = path.join(dir, 'events');
    this.exe = exe; this.env = env;            // Windows: executável da Bancada (modo Node) e variáveis para o hook.cmd
    this.extra = extra;                         // () → campos a mais no settings.json (ex.: statusLine do medidor de limite)
    this.now = now;                         // relógio (injetado nos testes)
    this.busy = busy || (() => false);      // (id) → a atividade vê ferramenta/tarefa em andamento? (não vira "?" por silêncio)
    this.onState = onState || (() => {});
    this.onEvent = onEvent || (() => {});   // v0.6: todo evento (mesmo sem mudar de estado) — o Escritório reage na hora
    this.states = new Map();     // termId -> { state, since, workingSince, transcript, message }
    this.offsets = new Map();    // termId -> byte offset lido
    this.watcher = null; this.timer = null;
  }

  get settingsFile() { return path.join(this.dir, 'settings.json'); }

  setup() {
    fs.mkdirSync(this.eventsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); fs.chmodSync(this.eventsDir, 0o700); } catch {}
    const hooks = {};
    const psFallback = this.win && (!!this.env.BANCADA_HOOKS_PS || CMD_UNSAFE.test(this.dir) || CMD_UNSAFE.test(String(this.exe)));
    if (this.win && !psFallback) {
      // Windows leve: cmd.exe (forma exec) → hook.cmd → Bancada em modo Node → hook.js. Em segundo plano, menos o Stop.
      const js = path.join(this.dir, 'hook.js');
      fs.writeFileSync(js, fs.readFileSync(path.join(__dirname, 'hook.js')), { mode: 0o600 });
      const cmd = path.join(this.dir, 'hook.cmd');
      fs.writeFileSync(cmd, hookCmd(this.exe, this.env), { mode: 0o600 });
      for (const ev of EVENTS) {
        const h = { type: 'command', command: plat.sys32('cmd.exe'), args: ['/d', '/c', cmd, ev], timeout: 10 };
        if (ev !== 'Stop') h.async = true;
        hooks[ev] = [{ hooks: [h] }];
      }
    } else if (this.win) {
      // Windows (reserva): PowerShell chamado direto (forma "exec", sem shell — funciona com ou sem o Git Bash). Em segundo plano
      // (async) para o Claude não esperar o PowerShell abrir a cada ferramenta; só o Stop espera, para o "terminou"
      // chegar por último.
      const emit = path.join(this.dir, 'emit.ps1');
      fs.writeFileSync(emit, '\ufeff' + emitScriptPs(this.eventsDir), { mode: 0o600 });
      for (const ev of EVENTS) {
        const h = { type: 'command', command: plat.powershellExe(), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', emit, ev], timeout: 10 };
        if (ev !== 'Stop') h.async = true;
        hooks[ev] = [{ hooks: [h] }];
      }
    } else {
      const emit = path.join(this.dir, 'emit.sh');
      fs.writeFileSync(emit, emitScript(this.eventsDir), { mode: 0o700 });
      fs.chmodSync(emit, 0o700);
      for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: `/bin/sh ${q(emit)} ${ev}`, timeout: 5 }] }];
    }
    // v0.4: as ferramentas de cartão só perguntam ao usuário (não leem nem gravam nada): liberadas sem pedir permissão
    const permissions = { allow: ['mcp__bancada__lista', 'mcp__bancada__perguntar', 'mcp__bancada__pendencias'] };
    let more = {}; try { more = (this.extra && this.extra()) || {}; } catch {}
    fs.writeFileSync(this.settingsFile, JSON.stringify({ hooks, permissions, ...more }, null, 1), { mode: 0o600 });
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
    const now = this.now();
    for (const [id, s] of this.states) {
      if (s.state === 'working' && now - s.lastEventAt > STALE_MS && !this.busy(id)) this.set(id, 'unknown', {});
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
    // subagente (Pre/PostToolUse com agent_id, SubagentStart/Stop): o principal pode já ter parado (agente em segundo
    // plano trabalhando depois do Stop) — antes isso reabria "trabalhando" no principal e o boneco ficava "Pensando"
    if (ev.agent_id && SUB_EVENTS.has(ev.event)) {
      cur.lastEventAt = ev.now = this.now();
      if (ev.event === 'SubagentStop' && ev.bg_tasks) cur.bg = { at: ev.at, list: ev.bg_tasks };
      this.subagent(cur, ev);
      this.states.set(id, cur);
      try { this.onEvent(id, ev); } catch {}
      return;
    }
    // hook em segundo plano (Windows) que chega depois do Stop, mas aconteceu antes dele: não reabre o "trabalhando"
    if (LATE_AFTER_STOP.has(ev.event) && cur.stopAt && ev.at < cur.stopAt) return;
    if (ev.event === 'Stop') cur.stopAt = ev.at;
    else if (ev.event === 'UserPromptSubmit') cur.stopAt = 0;
    cur.compacting = ev.event === 'PreCompact' ? ev.at : (ev.event === 'Notification' ? cur.compacting : 0);
    if (ev.transcript_path) cur.transcript = ev.transcript_path;
    cur.lastEventAt = ev.now = this.now();
    // lista oficial do que segue rodando (Stop e SubagentStop); sem ela, a transcrição decide
    if (ev.bg_tasks && (ev.event === 'Stop' || ev.event === 'SubagentStop')) cur.bg = { at: ev.at, list: ev.bg_tasks };
    // as duas fontes somadas (sem repetir id): a lista oficial pode não trazer um Bash; a transcrição pode não mostrar um Workflow
    if (ev.event === 'Stop') ev.background = new Set([...(ev.bg_tasks ? runningOf(ev.bg_tasks).map(t => t.id) : []), ...pendingLaunches(cur.transcript)]).size;
    this.states.set(id, cur);
    try { this.onEvent(id, ev); } catch {}
    const next = nextState(cur.state, ev, cur.state === 'waiting' ? cur.since : 0);
    if (!next || next === cur.state) return;
    const message = ev.event === 'Notification' ? ev.message : ev.event === 'PermissionRequest' ? `quer permissão para usar ${ev.tool || 'uma ferramenta'}` : ASKS.has(ev.tool) ? (ev.tool === 'ExitPlanMode' ? 'plano para aprovar' : ev.tool === 'mcp__bancada__lista' ? 'tem uma lista para você marcar' : 'tem uma pergunta para você') : null;
    this.set(id, next, { message });
  }

  // subagentes vistos pelos hooks: entrar (SubagentStart), ferramenta atual, sair (SubagentStop). Com teto.
  subagent(cur, ev) {
    if (!ID_RE.test(ev.agent_id)) return;
    const m = cur.agents || (cur.agents = new Map());
    // ids que já saíram (SubagentStop): lista à parte, maior que o teto do registro. Sem ela, um agente terminado que sai
    // do registro de 40 voltava como "rodando" pela transcrição (soak de 1 h, depois do 40º subagente da sessão)
    const ended = cur.ended || (cur.ended = new Set());
    if (ev.event === 'SubagentStart') ended.delete(ev.agent_id);
    else if (ev.event === 'SubagentStop') { ended.delete(ev.agent_id); ended.add(ev.agent_id); if (ended.size > MAX_ENDED) ended.delete(ended.values().next().value); }
    else if (ended.has(ev.agent_id) && !m.has(ev.agent_id)) return;   // evento atrasado de agente que já saiu: não ressuscita
    let a = m.get(ev.agent_id);
    if (!a) {
      a = { id: ev.agent_id, type: ev.agent_type || null, startedAt: ev.at, lastAt: ev.at, tool: null, toolAt: 0, running: false, done: false, doneAt: 0 };
      m.set(ev.agent_id, a);
      if (m.size > MAX_SUBAGENTS) { const old = [...m.values()].sort((x, y) => (y.done - x.done) || (x.lastAt - y.lastAt))[0]; m.delete(old.id); }
    }
    if (ev.agent_type) a.type = ev.agent_type;
    a.lastAt = Math.max(a.lastAt, ev.at);
    if (ev.event === 'SubagentStart') { a.startedAt = Math.min(a.startedAt, ev.at); a.done = false; }
    else if (ev.event === 'SubagentStop') { a.done = true; a.doneAt = ev.at; a.running = false; }
    else if (ev.event === 'PreToolUse') { a.tool = ev.tool; a.toolAt = ev.at; a.running = true; }
    else { a.running = false; }
  }

  set(id, state, { message = null } = {}) {
    const cur = this.states.get(id) || {};
    const prev = cur.state || 'idle';
    const now = this.now();
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
  // lista oficial de tarefas em segundo plano ainda rodando (do último Stop/SubagentStop), ou null se não veio
  background(id) { const s = this.states.get(id); return s && s.bg ? { at: s.bg.at, list: runningOf(s.bg.list) } : null; }
}

module.exports = { ClaudeHooks, parseLine, nextState, emitScript, emitScriptPs, pendingBackground, clipPayload, bgTasks, cmdExePath, cmdLauncher, hookCmd, CMD_UNSAFE };
