// Validação de tudo que chega do renderer pelo IPC. Recusa por padrão: só passam campos conhecidos e tipos certos.
'use strict';
const fs = require('fs');

function bad(msg) { const e = new Error(msg); e.code = 'INVALID'; return e; }

function id(x) {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(x)) throw bad('id inválido');
  return x;
}
function idList(x, max = 20) { if (!Array.isArray(x) || x.length > max) throw bad('lista inválida'); return x.map(id); }
function text(x, max = 20000) {
  if (typeof x !== 'string') throw bad('texto inválido');
  if (x.length > max) throw bad('texto grande demais');
  return x;
}
function optText(x, max) { return x == null ? null : text(x, max); }
function date(x) { if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) throw bad('data inválida'); return x; }
function dir(x) {
  text(x, 1024);
  if (!x.startsWith('/')) throw bad('caminho precisa ser absoluto');
  try { if (!fs.statSync(x).isDirectory()) throw 0; } catch { throw bad('pasta não existe'); }
  return x;
}
function paths(x) { if (!Array.isArray(x) || x.length > 10) throw bad('pastas inválidas'); return x.map(dir); }
function strList(x, max = 30, len = 80) {
  if (!Array.isArray(x) || x.length > max) throw bad('lista inválida');
  return x.map(s => text(s, len));
}
// árvore de painéis (E3): só a forma conhecida, ids válidos, até 4 folhas, JSON pequeno
function paneTree(x) {
  if (x == null) return null;
  if (JSON.stringify(x).length > 4096) throw bad('layout grande demais');
  let leaves = 0;
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 6) throw bad('layout inválido');
    if ('t' in n) { if (++leaves > 4) throw bad('máximo 4 painéis'); return { t: id(n.t) }; }
    if (n.d !== 'row' && n.d !== 'col') throw bad('layout inválido');
    const r = typeof n.r === 'number' && n.r >= 0.1 && n.r <= 0.9 ? n.r : 0.5;
    return { d: n.d, r, a: walk(n.a, depth + 1), b: walk(n.b, depth + 1) };
  };
  return walk(x, 0);
}
function int(x, lo, hi) { if (!Number.isInteger(x) || x < lo || x > hi) throw bad('número inválido'); return x; }
function ts(x) { return x == null ? null : int(x, 0, 32503680000000); }

const PROJECT_KINDS = ['software', 'live', 'musica', 'outro'];
const STATUSES = ['focus', 'shelf'];
const ITEM_TYPES = ['note', 'idea', 'prompt', 'reminder', 'step', 'pending'];
const ITEM_STATES = ['active', 'sent', 'archived', 'done'];

function projectCreate(p) {
  if (!p || typeof p !== 'object') throw bad('projeto inválido');
  return {
    name: text(p.name, 80),
    kind: PROJECT_KINDS.includes(p.kind) ? p.kind : 'software',
    paths: p.paths ? paths(p.paths) : [],
    status: STATUSES.includes(p.status) ? p.status : 'shelf',
  };
}

function projectPatch(p) {
  if (!p || typeof p !== 'object') throw bad('patch inválido');
  const o = {};
  if ('name' in p) o.name = text(p.name, 80);
  if ('kind' in p) { if (!PROJECT_KINDS.includes(p.kind)) throw bad('tipo inválido'); o.kind = p.kind; }
  if ('status' in p) { if (!STATUSES.includes(p.status)) throw bad('estado inválido'); o.status = p.status; }
  if ('paths' in p) o.paths = paths(p.paths);
  if ('aliases' in p) o.aliases = strList(p.aliases);
  if ('position' in p) o.position = int(p.position, 0, 1e6);
  if ('where_stopped' in p) { o.where_stopped = optText(p.where_stopped, 4000); o.where_stopped_src = 'user'; o.where_stopped_at = Date.now(); }
  if ('next_step' in p) { o.next_step = optText(p.next_step, 500); o.next_step_src = 'user'; }
  if ('armed' in p) o.armed = !!p.armed;
  if ('deleted' in p) o.deleted = !!p.deleted;
  if ('engine_id' in p) o.engine_id = p.engine_id == null ? null : (p.engine_id === 'none' ? 'none' : id(p.engine_id));
  return o;
}

function itemCreate(it) {
  if (!it || typeof it !== 'object') throw bad('item inválido');
  return {
    project_id: it.project_id ? id(it.project_id) : 'inbox',
    text: text(it.text),
    type: ITEM_TYPES.includes(it.type) ? it.type : 'note',
    remind_at: ts(it.remind_at),
  };
}

function itemPatch(p) {
  if (!p || typeof p !== 'object') throw bad('patch inválido');
  const o = {};
  if ('text' in p) o.text = text(p.text);
  if ('type' in p) { if (!ITEM_TYPES.includes(p.type)) throw bad('tipo inválido'); o.type = p.type; }
  if ('state' in p) { if (!ITEM_STATES.includes(p.state)) throw bad('estado inválido'); o.state = p.state; if (p.state === 'sent') o.sent_at = Date.now(); }
  if ('project_id' in p) o.project_id = id(p.project_id);
  if ('pinned' in p) o.pinned = !!p.pinned;
  if ('position' in p) { if (typeof p.position !== 'number' || !isFinite(p.position)) throw bad('posição inválida'); o.position = p.position; }
  if ('remind_at' in p) o.remind_at = ts(p.remind_at);
  if ('today_date' in p) o.today_date = p.today_date == null ? null : date(p.today_date);
  return o;
}

function terminal(t) {
  if (!t || typeof t !== 'object') throw bad('terminal inválido');
  return {
    id: id(t.id), project_id: id(t.project_id), name: text(t.name, 60),
    cwd: t.cwd ? dir(t.cwd) : null, startup: optText(t.startup, 300), skip_perms: !!t.skip_perms,
  };
}

function ptyCreate(o) {
  if (!o || typeof o !== 'object') throw bad('terminal inválido');
  return {
    id: id(o.id), projectId: id(o.projectId), name: text(o.name, 60),
    cwd: o.cwd ? text(o.cwd, 1024) : null,
    cols: int(o.cols | 0 || 100, 2, 1000), rows: int(o.rows | 0 || 30, 1, 500),
    startup: optText(o.startup, 300),
  };
}

function settings(p) {
  if (!p || typeof p !== 'object') throw bad('ajustes inválidos');
  const o = {};
  if ('hotkey' in p) { if (!/^(Cmd|Ctrl|Alt|Shift|CommandOrControl|Option|Super)(\+[A-Za-z0-9]+|\+Space|\+(Cmd|Ctrl|Alt|Shift|Option))*$/.test(p.hotkey)) throw bad('atalho inválido'); o.hotkey = p.hotkey; }
  if ('focus_limit' in p) o.focus_limit = int(p.focus_limit, 1, 5);
  if ('morning_time' in p) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.morning_time)) throw bad('horário inválido'); o.morning_time = p.morning_time; }
  if ('ai_summary' in p) o.ai_summary = !!p.ai_summary;
  if ('theme' in p) { if (!['system', 'light', 'dark'].includes(p.theme)) throw bad('tema inválido'); o.theme = p.theme; }
  if ('onboarded' in p) o.onboarded = !!p.onboarded;
  if ('claude_skip_default' in p) o.claude_skip_default = !!p.claude_skip_default;
  return o;
}

module.exports = { paneTree, int, strList, id, idList, text, date, dir, projectCreate, projectPatch, itemCreate, itemPatch, terminal, ptyCreate, settings };
