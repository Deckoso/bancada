// Banco local da Bancada (offline-first). Fonte: BLUEPRINT D5.
// Todo registro tem id (ULID-like), updated_at (ms, monotônico por aparelho) e deleted (soft delete p/ sync).
'use strict';
const Database = require('better-sqlite3');
const crypto = require('crypto');

const TYPES = ['note', 'idea', 'prompt', 'reminder', 'step', 'pending'];   // pending: pendência (v0.4, 'Adiar')
const KINDS = ['software', 'live', 'musica', 'outro'];
const FOCUS_DEFAULT_LIMIT = 3;

let lastTs = 0;
function clock() {
  // relógio monotônico: nunca repete nem volta, mesmo com 2 escritas no mesmo ms
  const now = Date.now();
  lastTs = now > lastTs ? now : lastTs + 1;
  return lastTs;
}

function uid() {
  // ordenável por tempo (48 bits de ms) + 80 bits aleatórios, em base36
  return Date.now().toString(36).padStart(9, '0') + crypto.randomBytes(10).toString('hex');
}

const MIGRATIONS = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'software',
     paths TEXT NOT NULL DEFAULT '[]',          -- JSON: pastas do projeto (1ª = pasta dos terminais)
     aliases TEXT NOT NULL DEFAULT '[]',        -- JSON: palavras que o classificador de sessões aprendeu
     status TEXT NOT NULL DEFAULT 'shelf',      -- focus | shelf | inbox
     system INTEGER NOT NULL DEFAULT 0,
     position INTEGER NOT NULL DEFAULT 0,
     where_stopped TEXT,                        -- "onde parei" (texto)
     where_stopped_src TEXT,                    -- user | heuristic | ai
     where_stopped_at INTEGER,
     next_step TEXT,
     next_step_src TEXT,
     armed INTEGER NOT NULL DEFAULT 0,          -- fila do Stop hook (herdado do PromptPad)
     last_touched_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE items (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     text TEXT NOT NULL,
     type TEXT NOT NULL DEFAULT 'note',
     state TEXT NOT NULL DEFAULT 'active',      -- active | sent | archived | done
     pinned INTEGER NOT NULL DEFAULT 0,
     tags TEXT NOT NULL DEFAULT '[]',
     history TEXT NOT NULL DEFAULT '[]',
     position REAL NOT NULL DEFAULT 0,
     remind_at INTEGER,
     sent_at INTEGER,
     today_date TEXT,                           -- AAAA-MM-DD se está no "Hoje"
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX items_project ON items(project_id, deleted, state);
   CREATE TABLE terminals_layout (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     cwd TEXT,
     startup TEXT,                              -- comando opcional ao abrir (ex: claude --continue)
     position INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE sessions_digest (
     source TEXT NOT NULL,                      -- claude | codex
     session_id TEXT NOT NULL,
     file TEXT NOT NULL,
     project_id TEXT,
     title TEXT,
     cwd TEXT,
     started_at INTEGER,
     last_at INTEGER,
     last_prompt TEXT,
     prompts INTEGER NOT NULL DEFAULT 0,
     files_touched TEXT NOT NULL DEFAULT '[]',
     summary TEXT,                              -- JSON {feito, parou_em, proximo_passo} da IA
     summary_at INTEGER,
     user_override_project INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (source, session_id)
   );
   CREATE INDEX sessions_project ON sessions_digest(project_id, last_at);
   CREATE TABLE scan_cursor (file TEXT PRIMARY KEY, offset INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL);
   CREATE TABLE sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_id TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);`,
  // v2: dados do leitor de sessões para reclassificar sem reler arquivos
  `ALTER TABLE sessions_digest ADD COLUMN hits TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE sessions_digest ADD COLUMN prompts_sample TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE sessions_digest ADD COLUMN last_reply TEXT;`,
  // v3: motores (ex.: athena-os) — o terminal do projeto roda DENTRO do motor, focado no projeto
  `CREATE TABLE engines (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL,
     is_default INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ALTER TABLE projects ADD COLUMN engine_id TEXT;              -- null = motor padrão; 'none' = pasta do projeto
   ALTER TABLE terminals_layout ADD COLUMN session_id TEXT;     -- conversa do Claude presa a este terminal
   CREATE TABLE session_pins (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, terminal_id TEXT, created_at INTEGER NOT NULL);`,
  // v4: Claude "sem permissões" por terminal (--dangerously-skip-permissions), escolha do usuário
  `ALTER TABLE terminals_layout ADD COLUMN skip_perms INTEGER NOT NULL DEFAULT 0;`,
];

function open(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const ver = db.pragma('user_version', { simple: true });
  for (let i = ver; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]);
    db.pragma(`user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  return new Store(db);
}

const PROJECT_FIELDS = ['name', 'kind', 'paths', 'aliases', 'status', 'position', 'where_stopped', 'where_stopped_src',
  'where_stopped_at', 'next_step', 'next_step_src', 'armed', 'last_touched_at', 'deleted', 'engine_id'];
const ITEM_FIELDS = ['project_id', 'text', 'type', 'state', 'pinned', 'tags', 'history', 'position', 'remind_at',
  'sent_at', 'today_date', 'deleted'];
const JSON_FIELDS = new Set(['paths', 'aliases', 'tags', 'history']);

function parseTags(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu)) out.add(m[2].toLowerCase());
  return [...out];
}

function rowOut(r) {
  if (!r) return r;
  const o = { ...r };
  for (const f of JSON_FIELDS) if (f in o && typeof o[f] === 'string') o[f] = JSON.parse(o[f]);
  for (const f of ['system', 'armed', 'pinned', 'deleted']) if (f in o) o[f] = !!o[f];
  return o;
}

function pick(patch, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k)) continue;
    if (JSON_FIELDS.has(k)) out[k] = JSON.stringify(Array.isArray(v) ? v : []);
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

class Store {
  constructor(db) {
    this.db = db;
    this.ensureInbox();
  }

  close() { this.db.close(); }

  outbox(tbl, id, at) {
    this.db.prepare('INSERT INTO sync_outbox (tbl,row_id,at) VALUES (?,?,?)').run(tbl, id, at);
  }

  kvGet(k, def = null) {
    const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(k);
    return r ? JSON.parse(r.v) : def;
  }
  kvSet(k, v) { this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); }

  ensureInbox() {
    const r = this.db.prepare("SELECT id FROM projects WHERE id='inbox'").get();
    if (!r) {
      const t = clock();
      this.db.prepare(`INSERT INTO projects (id,name,kind,status,system,created_at,updated_at) VALUES ('inbox','Inbox','outro','inbox',1,?,?)`).run(t, t);
    }
  }

  // ---------- projetos ----------
  listProjects() {
    return this.db.prepare('SELECT * FROM projects WHERE deleted=0 ORDER BY system DESC, status, position, name').all().map(rowOut);
  }
  getProject(id) { return rowOut(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id)); }

  createProject({ name, kind = 'software', paths = [], status = 'shelf' }) {
    if (!name || !String(name).trim()) throw new Error('nome obrigatório');
    if (!KINDS.includes(kind)) throw new Error('tipo inválido');
    if (status === 'focus' && this.focusCount() >= this.focusLimit()) throw new FocusFullError(this.focusLimit());
    const t = clock(); const id = uid();
    const pos = this.db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM projects').get().p;
    this.db.prepare(`INSERT INTO projects (id,name,kind,paths,status,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, String(name).trim(), kind, JSON.stringify(paths), status, pos, t, t);
    this.outbox('projects', id, t);
    return this.getProject(id);
  }

  updateProject(id, patch) {
    const cur = this.getProject(id);
    if (!cur) throw new Error('projeto não existe');
    if (cur.system && patch && ('status' in patch || 'deleted' in patch)) throw new Error('Inbox não muda de estado');
    if (patch && patch.status === 'focus' && cur.status !== 'focus' && this.focusCount() >= this.focusLimit()) {
      throw new FocusFullError(this.focusLimit());
    }
    if (patch && patch.kind && !KINDS.includes(patch.kind)) throw new Error('tipo inválido');
    const p = pick(patch, PROJECT_FIELDS);
    if (!Object.keys(p).length) return cur;
    const t = clock(); p.updated_at = t;
    const sets = Object.keys(p).map(k => `${k}=@${k}`).join(',');
    this.db.prepare(`UPDATE projects SET ${sets} WHERE id=@id`).run({ ...p, id });
    this.outbox('projects', id, t);
    return this.getProject(id);
  }

  focusLimit() { return this.kvGet('focus_limit', FOCUS_DEFAULT_LIMIT); }
  focusCount() { return this.db.prepare("SELECT COUNT(*) c FROM projects WHERE status='focus' AND deleted=0").get().c; }

  // Estacionar um projeto e pôr outro em foco numa transação só (D11)
  swapFocus(parkId, focusId) {
    return this.db.transaction(() => {
      this.updateProject(parkId, { status: 'shelf' });
      return this.updateProject(focusId, { status: 'focus' });
    })();
  }

  // ---------- itens ----------
  listItems(projectId, { includeArchived = false } = {}) {
    const q = includeArchived
      ? 'SELECT * FROM items WHERE project_id=? AND deleted=0 ORDER BY pinned DESC, position, created_at'
      : "SELECT * FROM items WHERE project_id=? AND deleted=0 AND state IN ('active','sent') ORDER BY pinned DESC, position, created_at";
    return this.db.prepare(q).all(projectId).map(rowOut);
  }
  getItem(id) { return rowOut(this.db.prepare('SELECT * FROM items WHERE id=?').get(id)); }

  createItem({ project_id = 'inbox', text, type = 'note', remind_at = null, created_at, history, tags, state, pinned, sent_at, id }) {
    if (!text || !String(text).trim()) throw new Error('texto vazio');
    if (!TYPES.includes(type)) throw new Error('tipo inválido');
    if (!this.getProject(project_id)) project_id = 'inbox';
    const t = clock();
    const iid = id || uid();
    const c = created_at || t;
    const pos = this.db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM items WHERE project_id=?').get(project_id).p;
    this.db.prepare(`INSERT INTO items (id,project_id,text,type,state,pinned,tags,history,position,remind_at,sent_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      iid, project_id, String(text), type, state || 'active', pinned ? 1 : 0,
      JSON.stringify(tags || parseTags(text)), JSON.stringify(history || [{ at: c, from: '—', to: type }]),
      pos, remind_at, sent_at || null, c, t);
    this.touch(project_id, t);
    this.outbox('items', iid, t);
    return this.getItem(iid);
  }

  updateItem(id, patch) {
    const cur = this.getItem(id);
    if (!cur) throw new Error('item não existe');
    if (patch && patch.type && !TYPES.includes(patch.type)) throw new Error('tipo inválido');
    const p = pick(patch, ITEM_FIELDS);
    if ('text' in p) p.tags = JSON.stringify(parseTags(p.text));
    if (patch && patch.type && patch.type !== cur.type) {
      p.history = JSON.stringify([...cur.history, { at: Date.now(), from: cur.type, to: patch.type }]);
    }
    if (!Object.keys(p).length) return cur;
    const t = clock(); p.updated_at = t;
    const sets = Object.keys(p).map(k => `${k}=@${k}`).join(',');
    this.db.prepare(`UPDATE items SET ${sets} WHERE id=@id`).run({ ...p, id });
    this.touch(p.project_id || cur.project_id, t);
    this.outbox('items', id, t);
    return this.getItem(id);
  }

  deleteItem(id) { return this.updateItem(id, { deleted: true }); }

  touch(projectId, t) {
    this.db.prepare('UPDATE projects SET last_touched_at=? WHERE id=?').run(t, projectId);
  }

  // "Hoje": itens marcados com a data de hoje (D12)
  listToday(date) {
    return this.db.prepare("SELECT i.*, p.name project_name FROM items i JOIN projects p ON p.id=i.project_id WHERE i.today_date=? AND i.deleted=0 ORDER BY i.position")
      .all(date).map(rowOut);
  }

  dueReminders(fromTs, toTs) {
    return this.db.prepare("SELECT * FROM items WHERE type='reminder' AND deleted=0 AND state='active' AND remind_at>=? AND remind_at<?")
      .all(fromTs, toTs).map(rowOut);
  }

  // ---------- terminais ----------
  listTerminals(projectId) {
    return this.db.prepare('SELECT * FROM terminals_layout WHERE project_id=? ORDER BY position').all(projectId);
  }
  saveTerminal({ id, project_id, name, cwd, startup = null, skip_perms = false }) {
    const t = clock();
    const pos = this.db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM terminals_layout WHERE project_id=?').get(project_id).p;
    this.db.prepare(`INSERT INTO terminals_layout (id,project_id,name,cwd,startup,position,updated_at,skip_perms) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, cwd=excluded.cwd, startup=excluded.startup, updated_at=excluded.updated_at, skip_perms=excluded.skip_perms`)
      .run(id, project_id, name, cwd, startup, pos, t, skip_perms ? 1 : 0);
  }
  removeTerminal(id) { this.db.prepare('DELETE FROM terminals_layout WHERE id=?').run(id); }
  getTerminal(id) { return this.db.prepare('SELECT * FROM terminals_layout WHERE id=?').get(id); }
  setTerminalSession(id, sessionId) { this.db.prepare('UPDATE terminals_layout SET session_id=? WHERE id=?').run(sessionId, id); }
  reorderTerminals(projectId, ids) {
    const up = this.db.prepare('UPDATE terminals_layout SET position=? WHERE id=? AND project_id=?');
    this.db.transaction(() => ids.forEach((id, i) => up.run(i + 1, id, projectId)))();
  }

  // ---------- ordem arrastada (D: arrastar para organizar) ----------
  reorderProjects(ids) {
    const up = this.db.prepare('UPDATE projects SET position=?, updated_at=? WHERE id=? AND system=0');
    this.db.transaction(() => ids.forEach((id, i) => { const t = clock(); up.run(i + 1, t, id); this.outbox('projects', id, t); }))();
  }
  reorderItems(ids) {
    const up = this.db.prepare('UPDATE items SET position=?, updated_at=? WHERE id=?');
    this.db.transaction(() => ids.forEach((id, i) => { const t = clock(); up.run(i + 1, t, id); this.outbox('items', id, t); }))();
  }

  // ---------- motores ----------
  listEngines() { return this.db.prepare('SELECT * FROM engines ORDER BY is_default DESC, name').all().map(e => ({ ...e, is_default: !!e.is_default })); }
  getEngine(id) { const e = this.db.prepare('SELECT * FROM engines WHERE id=?').get(id); return e ? { ...e, is_default: !!e.is_default } : null; }
  defaultEngine() { return this.listEngines().find(e => e.is_default) || null; }
  addEngine({ name, path: p }) {
    const t = clock(); const id = uid();
    const first = !this.db.prepare('SELECT 1 FROM engines LIMIT 1').get();
    this.db.prepare('INSERT INTO engines (id,name,path,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, name, p, first ? 1 : 0, t, t);
    return this.getEngine(id);
  }
  updateEngine(id, { name, path: p }) {
    const cur = this.getEngine(id); if (!cur) throw new Error('motor não existe');
    this.db.prepare('UPDATE engines SET name=?, path=?, updated_at=? WHERE id=?').run(name ?? cur.name, p ?? cur.path, clock(), id);
    return this.getEngine(id);
  }
  setDefaultEngine(id) {
    if (!this.getEngine(id)) throw new Error('motor não existe');
    this.db.transaction(() => { this.db.prepare('UPDATE engines SET is_default=0').run(); this.db.prepare('UPDATE engines SET is_default=1 WHERE id=?').run(id); })();
  }
  removeEngine(id) {
    this.db.transaction(() => {
      const wasDefault = (this.getEngine(id) || {}).is_default;
      this.db.prepare('DELETE FROM engines WHERE id=?').run(id);
      this.db.prepare('UPDATE projects SET engine_id=NULL WHERE engine_id=?').run(id);
      if (wasDefault) { const next = this.db.prepare('SELECT id FROM engines ORDER BY created_at LIMIT 1').get(); if (next) this.setDefaultEngine(next.id); }
    })();
  }
  // motor efetivo de um projeto: o escolhido, senão o padrão; 'none' = sem motor (abre na pasta do projeto)
  engineFor(project) {
    if (!project || project.engine_id === 'none') return null;
    return (project.engine_id && this.getEngine(project.engine_id)) || this.defaultEngine();
  }

  pinSession(sessionId, projectId, terminalId) {
    this.db.prepare('INSERT INTO session_pins (session_id,project_id,terminal_id,created_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id')
      .run(sessionId, projectId, terminalId || null, Date.now());
  }
  pinnedProject(sessionId) { const r = this.db.prepare('SELECT project_id FROM session_pins WHERE session_id=?').get(sessionId); return r ? r.project_id : null; }
}

class FocusFullError extends Error {
  constructor(limit) { super(`Já há ${limit} projetos em foco. Estacione um para trazer este.`); this.code = 'FOCUS_FULL'; this.limit = limit; }
}

module.exports = { open, uid, clock, parseTags, TYPES, KINDS, FocusFullError };
