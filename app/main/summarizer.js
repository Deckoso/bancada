// "Onde parei" + "próximo passo" por projeto (D10).
// Camada 1 (grátis, sempre): heurística com título, último pedido, última resposta e git.
// Camada 2 (liga/desliga): `claude -p --model haiku` da assinatura, 15 min depois que a sessão para,
// recebendo só um digest pequeno. Fila de 1 chamada por vez, teto diário, nunca em cascata.
// Regra: o que o usuário escreveu vence, a menos que exista sessão MAIS NOVA que a edição dele.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const git = require('./git');
const { localDate } = require('./morning');

const IDLE_MS = 15 * 60 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;
const DAILY_CAP = 40;
const TIMEOUT_MS = 90 * 1000;
const MAX_DIGEST = 6 * 1024;

const CLAUDE_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
];

function findClaude() { return CLAUDE_CANDIDATES.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null; }

function ago(ts, now = Date.now()) {
  const m = Math.round((now - ts) / 60000);
  if (m < 60) return `há ${Math.max(1, m)} min`;
  const h = Math.round(m / 60); if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24); return d === 1 ? 'ontem' : `há ${d} dias`;
}
function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
// tira tabela/negrito/código de markdown para o cartão ficar legível
function plain(s) { return String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s*\|.*\|\s*$/gm, ' ').replace(/[*_`#>|]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function heuristic(project, sessions, g, now = Date.now()) {
  const s = sessions[0];
  const parts = [];
  if (s) {
    parts.push(`Última sessão (${s.source === 'codex' ? 'Codex' : 'Claude'}, ${ago(s.last_at, now)}): ${clip(s.title || s.last_prompt, 90)}.`);
    if (s.last_prompt && s.title) parts.push(`Último pedido: “${clip(plain(s.last_prompt), 140)}”.`);
    const tail = plain(s.last_reply).split(/(?<=[.!?])\s+/).filter(x => x.length > 12).slice(-2).join(' ');
    if (tail) parts.push(`Terminou com: “${clip(tail, 160)}”.`);
  }
  if (g) {
    if (g.changed) parts.push(`git: ${g.changed} arquivo(s) alterado(s) sem commit${g.branch ? ` na branch ${g.branch}` : ''}.`);
    if (g.last) parts.push(`Último commit ${ago(g.last.at, now)}: “${clip(g.last.subject, 90)}”.`);
  }
  return parts.length ? parts.join(' ') : null;
}

function buildDigest(project, s, g) {
  const lines = [
    `Projeto: ${project.name}`,
    `Sessão: ${s.title || '(sem título)'}`,
    'Pedidos recentes do usuário (do mais antigo ao mais novo):',
    ...(s.prompts_sample || []).slice(-6).map(p => `- ${clip(p, 300)}`),
    `Última resposta do agente: ${clip(s.last_reply, 900)}`,
    `Arquivos editados: ${(s.files_touched || []).slice(-15).map(f => path.basename(f)).join(', ') || 'nenhum'}`,
  ];
  if (g) lines.push(`git: branch ${g.branch || '?'}, ${g.changed} alterado(s) sem commit; último commit: ${g.last ? g.last.subject : 'nenhum'}`);
  return lines.join('\n').slice(0, MAX_DIGEST);
}

const PROMPT = `Você resume sessões de trabalho de um desenvolvedor para ele retomar sem se perder.
Devolva SOMENTE um objeto JSON: {"feito": "...", "parou_em": "...", "proximo_passo": "..."}
Regras: português do Brasil; cada campo com no máximo 160 caracteres; concreto (nomes de telas, arquivos, funções);
"proximo_passo" é UMA ação, começando por verbo no imperativo; se a sessão terminou esperando uma decisão dele, o próximo passo é essa decisão.
Não invente nada que não esteja nos dados.

DADOS:
`;

function extractJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const f = k => typeof o[k] === 'string' ? clip(o[k], 200) : null;
    const r = { feito: f('feito'), parou_em: f('parou_em'), proximo_passo: f('proximo_passo') };
    return r.parou_em || r.proximo_passo ? r : null;
  } catch { return null; }
}

class Summarizer {
  constructor({ store, reader, onChange = () => {}, runner, workDir }) {
    this.store = store; this.reader = reader; this.onChange = onChange;
    this.runner = runner || ((prompt) => this.runClaude(prompt));
    this.workDir = workDir || path.join(os.tmpdir(), 'bancada-resumo');
    this.queue = []; this.busy = false; this.lastError = null;
    this.interval = setInterval(() => this.checkIdle(), CHECK_EVERY_MS);
    if (this.interval.unref) this.interval.unref();
  }

  stop() { clearInterval(this.interval); }

  status() {
    const today = localDate();
    return { enabled: this.store.kvGet('ai_summary', true), calls_today: this.store.kvGet(`ai_calls:${today}`, 0), cap: DAILY_CAP,
      queued: this.queue.length, busy: this.busy, last_error: this.lastError, claude: !!findClaude() };
  }

  sessionsFull(pid, n = 3) {
    return this.store.db.prepare('SELECT * FROM sessions_digest WHERE project_id=? ORDER BY last_at DESC LIMIT ?').all(pid, n)
      .map(r => ({ ...r, files_touched: JSON.parse(r.files_touched), prompts_sample: JSON.parse(r.prompts_sample), summary: r.summary ? JSON.parse(r.summary) : null }));
  }

  onSessionsChanged(pids) { for (const pid of pids) this.refreshProject(pid).catch(() => {}); }

  // Pode o app sobrescrever o que está no cartão? Só se não foi o usuário, ou se a sessão é mais nova que a edição dele.
  canWrite(project, sessionAt, field = 'where') {
    const src = field === 'where' ? project.where_stopped_src : project.next_step_src;
    if (src !== 'user') return true;
    return !!(sessionAt && project.where_stopped_at && sessionAt > project.where_stopped_at);
  }

  async refreshProject(pid, { force = false } = {}) {
    const p = this.store.getProject(pid);
    if (!p || p.system) return null;
    const sessions = this.sessionsFull(pid);
    const s = sessions[0];
    const g = p.paths && p.paths[0] ? await git.status(p.paths[0]) : null;
    const latestAt = Math.max(s ? s.last_at || 0 : 0, g && g.last ? g.last.at : 0);

    if (s && s.summary && s.summary_at >= s.last_at) {
      this.applyAi(p, s, s.summary);
    } else if (this.canWrite(p, latestAt)) {
      const text = heuristic(p, sessions, g);
      if (text && text !== p.where_stopped) {
        this.store.db.prepare("UPDATE projects SET where_stopped=?, where_stopped_src='heuristic', where_stopped_at=? WHERE id=?").run(text, Date.now(), pid);
        this.onChange(pid);
      }
    }
    if (s && this.store.kvGet('ai_summary', true)) {
      const idle = Date.now() - (s.last_at || 0) > IDLE_MS;
      const stale = !s.summary_at || s.summary_at < s.last_at;
      if ((force || idle) && stale) this.enqueue({ pid, session: s, git: g });
    }
    return this.store.getProject(pid);
  }

  applyAi(p, s, sum) {
    const cur = this.store.getProject(p.id);
    let changed = false;
    if (sum.parou_em && this.canWrite(cur, s.last_at, 'where')) {
      const text = sum.feito ? `${sum.parou_em} (feito: ${sum.feito})` : sum.parou_em;
      if (text !== cur.where_stopped) { this.store.db.prepare("UPDATE projects SET where_stopped=?, where_stopped_src='ai', where_stopped_at=? WHERE id=?").run(text, Date.now(), p.id); changed = true; }
    }
    if (sum.proximo_passo && this.canWrite(cur, s.last_at, 'next') && sum.proximo_passo !== cur.next_step) {
      this.store.db.prepare("UPDATE projects SET next_step=?, next_step_src='ai' WHERE id=?").run(sum.proximo_passo, p.id); changed = true;
    }
    if (changed) this.onChange(p.id);
  }

  checkIdle() {
    if (!this.store.kvGet('ai_summary', true)) return;
    for (const p of this.store.listProjects().filter(x => x.status === 'focus')) this.refreshProject(p.id).catch(() => {});
  }

  enqueue(job) {
    if (this.queue.some(j => j.session.session_id === job.session.session_id)) return;
    if (this.queue.length >= 10) return;                       // fila curta: nada acumula sem limite
    this.queue.push(job);
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    const today = localDate();
    const calls = this.store.kvGet(`ai_calls:${today}`, 0);
    if (calls >= DAILY_CAP) { this.queue.length = 0; this.lastError = 'teto diário de resumos atingido'; return; }
    this.busy = true;
    try {
      this.store.kvSet(`ai_calls:${today}`, calls + 1);
      const p = this.store.getProject(job.pid);
      const out = await this.runner(PROMPT + buildDigest(p, job.session, job.git));
      const sum = extractJson(out);
      if (!sum) throw new Error('resposta da IA sem JSON válido');
      this.store.db.prepare('UPDATE sessions_digest SET summary=?, summary_at=? WHERE source=? AND session_id=?')
        .run(JSON.stringify(sum), Date.now(), job.session.source, job.session.session_id);
      this.applyAi(p, job.session, sum);
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      // marca como tentado para não repetir a mesma sessão em loop
      this.store.db.prepare('UPDATE sessions_digest SET summary_at=? WHERE source=? AND session_id=?').run(Date.now(), job.session.source, job.session.session_id);
    } finally {
      this.busy = false;
      if (this.queue.length) setTimeout(() => this.pump(), 2000);
    }
  }

  runClaude(prompt) {
    const bin = findClaude();
    if (!bin) return Promise.reject(new Error('claude não encontrado'));
    fs.mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'json', '--tools', ''],
        { cwd: this.workDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('resumo passou de 90 s')); }, TIMEOUT_MS);
      child.stdout.on('data', d => { if (out.length < 256 * 1024) out += d; });
      child.stderr.on('data', d => { if (err.length < 16 * 1024) err += d; });
      child.on('error', e => { clearTimeout(t); reject(e); });
      child.on('close', code => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error(`claude saiu com ${code}: ${err.slice(0, 200)}`));
        try { const j = JSON.parse(out); resolve(j.result || ''); } catch { resolve(out); }
      });
      child.stdin.end(prompt);
    });
  }
}

module.exports = { Summarizer, heuristic, buildDigest, extractJson };
