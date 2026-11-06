// Leitor de sessões do Claude Code e do Codex (D9). Só leitura, incremental, por streaming.
// Memória: lê em pedaços de 256 KB a partir do cursor salvo; linha acima de MAX_LINE é descartada e contada.
// Nunca guarda transcrição: só título, últimos pedidos (cortados), última resposta (cortada), arquivos e contagem por pasta.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseClaudeLine, parseCodexLine } = require('./parse');
const { classify } = require('./classify');

const CHUNK = 256 * 1024;
const MAX_LINE = 16 * 1024 * 1024;
const DEBOUNCE_MS = 30 * 1000;
const MAX_FILES_TOUCHED = 40;
const MAX_PROMPTS_SAMPLE = 12;

class SessionReader {
  constructor({ store, onChange = () => {}, roots, ignoreCwds = [] }) {
    this.store = store;
    this.onChange = onChange;
    this.roots = roots || {
      claude: path.join(os.homedir(), '.claude', 'projects'),
      codex: path.join(os.homedir(), '.codex', 'sessions'),
    };
    this.ignoreCwds = ignoreCwds;
    this.watchers = [];
    this.timer = null;
    this.scanning = null;
    this.stats = { files: 0, linesRead: 0, linesIgnored: 0, bytesRead: 0, oversized: 0 };
  }

  start() {
    this.scan().catch(e => console.error('[bancada] leitura de sessões:', e.message));
    for (const root of Object.values(this.roots)) {
      try {
        const w = fs.watch(root, { recursive: true }, (_ev, f) => { if (f && String(f).endsWith('.jsonl')) this.kick(); });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch { /* pasta ainda não existe */ }
    }
  }

  stop() { clearTimeout(this.timer); for (const w of this.watchers) w.close(); this.watchers = []; }

  kick() {
    if (this.timer) return;                      // já agendado: um só scan por janela de 30 s
    this.timer = setTimeout(() => { this.timer = null; this.scan().catch(() => {}); }, DEBOUNCE_MS);
  }

  listFiles() {
    const out = [];
    const claude = this.roots.claude;
    if (claude && fs.existsSync(claude)) {
      for (const d of fs.readdirSync(claude)) {
        const dir = path.join(claude, d);
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ source: 'claude', file: path.join(dir, e.name) });
      }
    }
    const codex = this.roots.codex;
    if (codex && fs.existsSync(codex)) {
      const walk = (dir, depth) => {
        if (depth > 4) return;
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ source: 'codex', file: p });
        }
      };
      walk(codex, 0);
    }
    return out;
  }

  // Um scan por vez; chamadas durante um scan esperam o mesmo.
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this._scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _scan() {
    const changed = new Set();
    const getCur = this.store.db.prepare('SELECT * FROM scan_cursor WHERE file=?');
    for (const { source, file } of this.listFiles()) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      const cur = getCur.get(file);
      let offset = cur ? cur.offset : 0;
      if (cur && st.size < cur.offset) offset = 0;            // arquivo reescrito: recomeça
      if (cur && st.size === cur.offset && st.mtimeMs === cur.mtime) continue;
      const state = this.loadState(source, file);
      const newOffset = await this.readFrom(file, offset, source, state);
      this.stats.files++;
      if (state.dirty) {
        const pid = this.saveState(state);
        if (pid) changed.add(pid);
        if (state.prevProject && state.prevProject !== pid) changed.add(state.prevProject);
      }
      this.store.db.prepare('INSERT INTO scan_cursor(file,offset,size,mtime) VALUES(?,?,?,?) ON CONFLICT(file) DO UPDATE SET offset=excluded.offset,size=excluded.size,mtime=excluded.mtime')
        .run(file, newOffset, st.size, Math.round(st.mtimeMs));
    }
    if (changed.size) this.onChange([...changed]);
    return { changed: [...changed], stats: { ...this.stats } };
  }

  readFrom(file, offset, source, state) {
    return new Promise((resolve) => {
      const stream = fs.createReadStream(file, { start: offset, highWaterMark: CHUNK });
      let carry = [];             // pedaços de uma linha incompleta
      let carryLen = 0;
      let seen = offset;          // bytes já recebidos (absoluto)
      let lastNl = offset;        // posição logo após o último \n (onde o cursor fica)
      let skipping = false;      // descartando uma linha gigante até o próximo \n
      const parse = source === 'claude' ? parseClaudeLine : parseCodexLine;

      stream.on('data', (buf) => {
        let start = 0;
        for (;;) {
          const nl = buf.indexOf(10, start);
          if (nl === -1) {
            if (!skipping) {
              carry.push(buf.subarray(start)); carryLen += buf.length - start;
              if (carryLen > MAX_LINE) { skipping = true; carry = []; carryLen = 0; this.stats.oversized++; }
            }
            break;
          }
          const piece = buf.subarray(start, nl);
          if (skipping) { skipping = false; this.stats.linesIgnored++; }
          else {
            const line = carryLen ? Buffer.concat([...carry, piece]).toString('utf8') : piece.toString('utf8');
            carry = []; carryLen = 0;
            this.stats.linesRead++;
            let rec = null;
            try { rec = parse(line); } catch { rec = null; }
            if (rec === undefined) this.stats.linesIgnored++;
            else if (rec) this.apply(state, rec);
          }
          start = nl + 1;
        }
        // o cursor avança só até o último \n: a sobra (linha incompleta, sessão ainda escrevendo) é relida no próximo scan
        const i = buf.lastIndexOf(10);
        if (i !== -1) lastNl = seen + i + 1;
        seen += buf.length;
        this.stats.bytesRead += buf.length;
      });
      stream.on('end', () => resolve(lastNl));
      stream.on('error', () => resolve(offset));
    });
  }

  loadState(source, file) {
    const sid = path.basename(file, '.jsonl');
    const row = this.store.db.prepare('SELECT * FROM sessions_digest WHERE source=? AND file=?').get(source, file);
    if (row) {
      return { ...row, files_touched: JSON.parse(row.files_touched), hits: JSON.parse(row.hits),
        prompts_sample: JSON.parse(row.prompts_sample), dirty: false, prevProject: row.project_id };
    }
    return { source, session_id: sid, file, project_id: null, title: null, cwd: null, started_at: null, last_at: null,
      last_prompt: null, prompts: 0, files_touched: [], hits: {}, prompts_sample: [], last_reply: null,
      summary: null, summary_at: null, user_override_project: 0, dirty: false, prevProject: null };
  }

  apply(s, r) {
    s.dirty = true;
    if (r.sessionId && s.session_id !== r.sessionId && s.source === 'codex') s.session_id = r.sessionId;
    if (r.at) { if (!s.started_at || r.at < s.started_at) s.started_at = r.at; if (!s.last_at || r.at > s.last_at) s.last_at = r.at; }
    if (r.cwd && !s.cwd) s.cwd = r.cwd;
    if (r.title) s.title = r.title.slice(0, 200);
    if (r.prompt) {
      s.prompts++;
      s.last_prompt = r.prompt.slice(0, 400);
      s.prompts_sample.push(r.prompt.slice(0, 200));
      if (s.prompts_sample.length > MAX_PROMPTS_SAMPLE) s.prompts_sample.splice(1, 1);   // guarda o 1º + os últimos
    }
    if (r.reply) s.last_reply = r.reply.slice(0, 800);
    for (const f of r.files || []) {
      const i = s.files_touched.indexOf(f);
      if (i !== -1) s.files_touched.splice(i, 1);
      s.files_touched.push(f);
      if (s.files_touched.length > MAX_FILES_TOUCHED) s.files_touched.shift();
    }
    for (const [k, n] of Object.entries(r.hits || {})) s.hits[k] = (s.hits[k] || 0) + n;
  }

  saveState(s) {
    if (s.cwd && this.ignoreCwds.some(c => s.cwd.startsWith(c))) return null;   // chamadas do próprio resumidor
    // sessão aberta pela Bancada (--session-id) já sabe o projeto: sem adivinhar
    const pinned = s.source === 'claude' && this.store.pinnedProject ? this.store.pinnedProject(s.session_id) : null;
    if (pinned && !s.user_override_project) s.project_id = pinned;
    else if (!s.user_override_project) s.project_id = classify(s, this.store.listProjects());
    this.store.db.prepare(`INSERT INTO sessions_digest (source,session_id,file,project_id,title,cwd,started_at,last_at,last_prompt,prompts,files_touched,summary,summary_at,user_override_project,hits,prompts_sample,last_reply)
      VALUES (@source,@session_id,@file,@project_id,@title,@cwd,@started_at,@last_at,@last_prompt,@prompts,@files_touched,@summary,@summary_at,@user_override_project,@hits,@prompts_sample,@last_reply)
      ON CONFLICT(source,session_id) DO UPDATE SET file=excluded.file, project_id=excluded.project_id, title=excluded.title, cwd=excluded.cwd,
        started_at=excluded.started_at, last_at=excluded.last_at, last_prompt=excluded.last_prompt, prompts=excluded.prompts,
        files_touched=excluded.files_touched, hits=excluded.hits, prompts_sample=excluded.prompts_sample, last_reply=excluded.last_reply`)
      .run({ ...s, files_touched: JSON.stringify(s.files_touched), hits: JSON.stringify(s.hits), prompts_sample: JSON.stringify(s.prompts_sample) });
    if (s.project_id && s.last_at) {
      const p = this.store.getProject(s.project_id);
      if (p && (!p.last_touched_at || s.last_at > p.last_touched_at)) this.store.db.prepare('UPDATE projects SET last_touched_at=? WHERE id=?').run(s.last_at, p.id);
    }
    return s.project_id;
  }

  // Projetos mudaram (pasta nova, nome novo): reclassifica tudo a partir do que já foi lido, sem reler arquivos.
  reclassifyAll() {
    const projects = this.store.listProjects();
    const rows = this.store.db.prepare('SELECT source,session_id,cwd,hits,prompts_sample,title FROM sessions_digest WHERE user_override_project=0').all();
    const upd = this.store.db.prepare('UPDATE sessions_digest SET project_id=? WHERE source=? AND session_id=?');
    this.store.db.transaction(() => {
      for (const r of rows) {
        const pid = classify({ ...r, hits: JSON.parse(r.hits), prompts_sample: JSON.parse(r.prompts_sample) }, projects);
        upd.run(pid, r.source, r.session_id);
      }
    })();
  }

  forProject(projectId, limit = 10) {
    return this.store.db.prepare('SELECT source,session_id,title,cwd,started_at,last_at,last_prompt,last_reply,prompts,files_touched,summary,summary_at FROM sessions_digest WHERE project_id=? ORDER BY last_at DESC LIMIT ?')
      .all(projectId, limit).map(r => ({ ...r, files_touched: JSON.parse(r.files_touched), summary: r.summary ? JSON.parse(r.summary) : null }));
  }

  unassigned(limit = 20) {
    return this.store.db.prepare('SELECT source,session_id,title,cwd,last_at,last_prompt,prompts FROM sessions_digest WHERE project_id IS NULL AND prompts>0 ORDER BY last_at DESC LIMIT ?').all(limit);
  }

  assign(source, sessionId, projectId) {
    this.store.db.prepare('UPDATE sessions_digest SET project_id=?, user_override_project=? WHERE source=? AND session_id=?')
      .run(projectId, projectId ? 1 : 0, source, sessionId);
    if (!projectId) this.reclassifyAll();
    return true;
  }
}

module.exports = { SessionReader };
