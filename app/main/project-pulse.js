// Pulso de cada projeto (Escritório): tudo o que está acontecendo nele além do Claude — terminais comuns (o programa em
// primeiro plano: npm run dev, testes, build), servidor local que subiu, git (arquivos alterados, último commit), o último
// resultado de teste visto num terminal, e Codex / Google, que não têm hooks: "ativo pelo terminal" pela saída recente.
// Só leitura. Memória: um registro por terminal vivo (some quando o terminal fecha), teto de projetos e de terminais,
// última linha lida só dos últimos 4 KB da saída que o pty-manager já guarda. git no máximo a cada 20 s por projeto.
'use strict';
const plat = require('./platform');

const MAX_PROJECTS = 16;
const MAX_TERMS = 12;                    // por projeto (o pty-manager já limita a 12 no total)
const TAIL = 4096;
const AI_ACTIVE_MS = 6000;               // Codex/Google: saída nos últimos 6 s = trabalhando (o spinner escreve sem parar)
const SHELL_ACTIVE_MS = 10000;           // Windows (sem programa em primeiro plano): saída nos últimos 10 s = ativo
const GIT_MS = 20000;
const SHELLS = /^-?(zsh|bash|sh|fish|dash|tcsh|csh|ksh|nu|pwsh|powershell|cmd)(\.exe)?$/i;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function lastLineOf(tail) {
  if (!tail) return '';
  const lines = stripAnsi(String(tail).slice(-TAIL)).split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l && !/^[$%#>›❯]\s*$/.test(l));
  return clip(lines[lines.length - 1] || '', 160);
}

// Resumo de teste no fim da saída (node --test, jest, vitest, mocha, pytest…): { pass, fail } ou null
function testsOf(tail) {
  if (!tail) return null;
  const t = stripAnsi(String(tail).slice(-TAIL));
  let pass = null, fail = null;
  const last = (re) => { let m, v = null; re.lastIndex = 0; while ((m = re.exec(t))) v = Number(m[1]); return v; };
  pass = last(/ℹ pass (\d+)/g); fail = last(/ℹ fail (\d+)/g);
  if (pass == null) { pass = last(/\b(\d+) (?:passed|passing)\b/g); fail = last(/\b(\d+) (?:failed|failing)\b/g); }
  if (pass == null && fail == null) return null;
  return { pass: pass || 0, fail: fail || 0 };
}

class ProjectPulse {
  // ptys: { list(), foreground(id), replay(id), lastOutput(id) } · kindOf(termId) → 'claude'|'codex'|'agy'|'shell'
  // projectOf(termId) → projectId · dirOf(projectId) → pasta · git(dir) → Promise<{ branch, changed, files, last }>
  constructor({ ptys, kindOf, projectOf = null, dirOf = null, git = null, now = Date.now, onChange = null, interval = 3000, win = plat.IS_WIN }) {
    Object.assign(this, { ptys, kindOf: kindOf || (() => 'shell'), projectOf, dirOf, git, now, onChange: onChange || (() => {}), interval, win });
    this.seen = new Map();      // termId -> { active, activeSince }
    this.gits = new Map();      // projectId -> { at, data, pending }
    this.tests = new Map();     // projectId -> { pass, fail, at, termId }
    this.out = {};              // projectId -> pulso
    this.sigs = new Map();
    this.timer = null;
  }
  start() { this.timer = setInterval(() => this.tick(), this.interval); this.tick(); return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  list() { return this.out; }

  tick() {
    const now = this.now();
    let live = []; try { live = this.ptys.list() || []; } catch { return; }
    const byProject = new Map();
    const alive = new Set();
    for (const t of live) {
      if (/^ai-login-/.test(String(t.id))) continue;                   // terminal de login das IAs: nunca
      const pid = (this.projectOf && this.projectOf(t.id)) || t.projectId;
      if (!pid) continue;
      if (!byProject.has(pid)) { if (byProject.size >= MAX_PROJECTS) continue; byProject.set(pid, []); }
      const list = byProject.get(pid); if (list.length >= MAX_TERMS) continue;
      alive.add(t.id);
      let kind = 'shell'; try { kind = this.kindOf(t.id) || 'shell'; } catch {}
      let fg = ''; try { fg = String(this.ptys.foreground(t.id) || ''); } catch {}
      let tail = ''; try { tail = this.ptys.replay(t.id) || ''; } catch {}
      let lastOutAt = 0; try { lastOutAt = Number(this.ptys.lastOutput(t.id)) || 0; } catch {}
      const quiet = now - lastOutAt;
      let active = false;
      if (kind === 'codex' || kind === 'agy') active = lastOutAt > 0 && quiet < AI_ACTIVE_MS;
      else if (kind === 'shell') active = fg ? !SHELLS.test(fg) : (this.win && lastOutAt > 0 && quiet < SHELL_ACTIVE_MS);
      if (/^\d+\.\d+\.\d+$/.test(fg)) fg = 'claude';                     // o binário do Claude tem o nome da versão
      const prev = this.seen.get(t.id);
      const activeSince = active ? (prev && prev.active ? prev.activeSince : now) : null;
      this.seen.set(t.id, { active, activeSince });
      const tr = testsOf(tail);
      if (tr && lastOutAt) { const cur = this.tests.get(pid); if (!cur || cur.at < lastOutAt) this.tests.set(pid, { ...tr, at: lastOutAt, termId: t.id }); }
      list.push({ id: t.id, name: clip(t.name || '', 40), kind, fg: clip(fg, 40), active, activeSince, lastOutAt: lastOutAt || null, line: lastLineOf(tail),
        urls: (t.urls || []).slice(0, 5).map(u => u.url).filter(Boolean), cwd: t.cwd || null });
    }
    for (const id of this.seen.keys()) if (!alive.has(id)) this.seen.delete(id);
    const out = {};
    for (const [pid, terms] of byProject) {
      this.gitFor(pid, terms, now);
      const g = this.gits.get(pid);
      const servers = [...new Set(terms.flatMap(x => x.urls))].slice(0, 5);
      out[pid] = { projectId: pid, terms, servers, git: g ? g.data : null, tests: this.tests.get(pid) || null };
    }
    for (const pid of [...this.gits.keys()]) if (!byProject.has(pid)) this.gits.delete(pid);
    for (const pid of [...this.tests.keys()]) if (!byProject.has(pid)) this.tests.delete(pid);
    this.out = out;
    this.emit();
  }

  gitFor(pid, terms, now) {
    if (!this.git) return;
    const g = this.gits.get(pid) || { at: 0, data: null, pending: false };
    this.gits.set(pid, g);
    if (g.pending || now - g.at < GIT_MS) return;
    const dir = (this.dirOf && this.dirOf(pid)) || (terms[0] && terms[0].cwd);
    if (!dir) return;
    g.pending = true; g.at = now;
    Promise.resolve().then(() => this.git(dir)).then((d) => {
      g.pending = false;
      if (this.gits.get(pid) !== g) return;
      g.data = !d ? null : d.paused ? { paused: true, reason: String(d.reason || '') }
        : { branch: d.branch || null, changed: d.changed || 0, files: (d.files || []).slice(0, 5), last: d.last || null };
      if (this.out[pid]) { this.out[pid].git = g.data; this.emit(); }
    }).catch(() => { g.pending = false; });
  }

  // avisa só o que mudou (sem a hora da última saída, que muda a cada byte)
  emit() {
    for (const [pid, p] of Object.entries(this.out)) {
      const sig = JSON.stringify({ ...p, terms: p.terms.map(x => ({ ...x, lastOutAt: 0 })) });
      if (this.sigs.get(pid) === sig) continue;
      this.sigs.set(pid, sig);
      try { this.onChange({ projectId: pid, pulse: p }); } catch {}
    }
    for (const pid of [...this.sigs.keys()]) if (!this.out[pid]) { this.sigs.delete(pid); try { this.onChange({ projectId: pid, pulse: null }); } catch {} }
  }
}

module.exports = { ProjectPulse, lastLineOf, testsOf };
