// Motores (ex.: athena-os): a pasta-cérebro onde o Claude roda, com CLAUDE.md, comandos e skills.
// O usuário atualiza o motor por fora; a Bancada RE-VERIFICA a pasta a cada abertura e quando ela muda,
// e como cada terminal abre o `claude` DENTRO da pasta, a versão nova vale na próxima sessão automaticamente.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_READ = 8 * 1024;
const MAX_FILES = 400;

function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(MAX_READ);
    const n = fs.readSync(fd, buf, 0, MAX_READ, 0); fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; }
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const out = {};
  if (m) for (const line of m[1].split('\n')) { const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line); if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim(); }
  return out;
}

function describe(text) {
  const fm = frontmatter(text);
  if (fm.description) return fm.description;
  const body = text.replace(/^---[\s\S]*?---\n/, '');
  const quote = /^>\s*(.+)$/m.exec(body); if (quote) return quote[1].trim();
  const para = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('---'));
  return para ? para.slice(0, 200) : '';
}

function walk(dir, ext, out = [], depth = 0) {
  if (depth > 5 || out.length >= MAX_FILES) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function latestMtime(files) { let m = 0; for (const f of files) { try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch {} } return m; }

// Lê o motor: existe? tem CLAUDE.md? versão? comandos (/ATHENA:tasks:forge-blueprint) e skills.
function inspect(enginePath) {
  const res = { ok: false, path: enginePath, checked_at: Date.now(), version: null, has_claude_md: false, commands: [], skills: [], warnings: [], updated_at: null };
  let st; try { st = fs.statSync(enginePath); } catch { res.error = 'pasta não encontrada'; return res; }
  if (!st.isDirectory()) { res.error = 'não é uma pasta'; return res; }
  const claudeDir = path.join(enginePath, '.claude');
  res.has_claude_md = fs.existsSync(path.join(enginePath, 'CLAUDE.md')) || fs.existsSync(path.join(claudeDir, 'CLAUDE.md'));
  if (!res.has_claude_md && !fs.existsSync(claudeDir)) res.warnings.push('sem CLAUDE.md nem .claude/: o Claude vai abrir aqui sem instruções de motor');
  const v = readHead(path.join(enginePath, 'VERSION')).trim().split('\n')[0];
  if (v && v.length < 40) res.version = v;

  const cmdDir = path.join(claudeDir, 'commands');
  const cmdFiles = walk(cmdDir, '.md');
  for (const f of cmdFiles) {
    const rel = path.relative(cmdDir, f).replace(/\.md$/, '');
    const text = readHead(f);
    res.commands.push({ name: '/' + rel.split(path.sep).join(':'), description: describe(text), file: f });
  }
  const skillFiles = [];
  for (const [scope, base] of [['motor', path.join(claudeDir, 'skills')], ['usuário', path.join(os.homedir(), '.claude', 'skills')]]) {
    let ents = []; try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch {}
    for (const e of ents) {
      const f = path.join(base, e.name, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      skillFiles.push(f);
      const text = readHead(f); const fm = frontmatter(text);
      res.skills.push({ name: fm.name || e.name, description: (fm.description || describe(text)).slice(0, 300), scope });
    }
  }
  res.commands.sort((a, b) => a.name.localeCompare(b.name));
  res.updated_at = latestMtime([...cmdFiles, ...skillFiles, path.join(enginePath, 'CLAUDE.md'), path.join(claudeDir, 'CLAUDE.md'), path.join(enginePath, 'VERSION')]) || null;
  res.ok = true;
  return res;
}

class EngineWatch {
  constructor({ store, onChange }) { this.store = store; this.onChange = onChange; this.cache = new Map(); this.watchers = new Map(); this.timers = new Map(); }

  // verificação completa (na abertura do app e quando o usuário pede)
  checkAll() {
    const out = [];
    for (const e of this.store.listEngines()) { const r = inspect(e.path); this.cache.set(e.id, r); out.push({ ...e, status: summary(r) }); this.watch(e); }
    for (const id of [...this.watchers.keys()]) if (!this.store.getEngine(id)) { this.watchers.get(id).close(); this.watchers.delete(id); this.cache.delete(id); }
    return out;
  }

  list() { return this.store.listEngines().map(e => ({ ...e, status: summary(this.cache.get(e.id) || this.refresh(e.id)) })); }
  refresh(id) { const e = this.store.getEngine(id); if (!e) return null; const r = inspect(e.path); this.cache.set(id, r); return r; }
  details(id) { return this.cache.get(id) || this.refresh(id); }

  watch(e) {
    if (this.watchers.has(e.id)) return;
    const dir = fs.existsSync(path.join(e.path, '.claude')) ? path.join(e.path, '.claude') : e.path;
    try {
      const w = fs.watch(dir, { recursive: true }, () => {
        // debounce de 2 s: atualizar o motor (git pull, cópia) mexe em muitos arquivos de uma vez
        clearTimeout(this.timers.get(e.id));
        this.timers.set(e.id, setTimeout(() => { this.refresh(e.id); this.onChange(e.id); }, 2000));
      });
      w.on('error', () => {});
      this.watchers.set(e.id, w);
    } catch {}
  }

  stop() { for (const w of this.watchers.values()) w.close(); for (const t of this.timers.values()) clearTimeout(t); this.watchers.clear(); }
}

function summary(r) {
  if (!r) return null;
  return { ok: r.ok, error: r.error || null, version: r.version, has_claude_md: r.has_claude_md, commands: r.commands.length, skills: r.skills.length,
    warnings: r.warnings, checked_at: r.checked_at, updated_at: r.updated_at };
}

// ---------- como o terminal abre o Claude no motor, focado no projeto ----------
function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function sessionFileExists(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs = []; try { dirs = fs.readdirSync(root); } catch { return false; }
  return dirs.some(d => fs.existsSync(path.join(root, d, `${sessionId}.jsonl`)));
}

// ferramentas da Bancada (v0.4): o usuário responde por toques num cartão, no Mac ou no celular
const BRIDGE_LINES = [
  'Para pedir decisões ao usuário, use as ferramentas da Bancada em vez de escrever listas e esperar resposta por texto (tocar é mais fácil que escrever, e quem precisa escrever esquece itens):',
  '- mcp__bancada__lista: várias coisas para ele marcar item a item (pendências, próximos passos). Botões padrão: Já fiz / Adiar / Fazer agora. "Adiar" vai sozinho para as pendências do projeto.',
  '- mcp__bancada__perguntar: uma pergunta por vez, com opções clicáveis e texto livre. Prefira-a ao AskUserQuestion.',
  '- mcp__bancada__pendencias: a lista de pendências deste projeto (listar/adicionar/concluir/remover).',
  'Quando ele perguntar "o que resta", "onde estamos" ou parecido: pendencias(listar) + o que você sabe do projeto → mostre tudo com lista e trabalhe a partir das respostas (Fazer agora primeiro).',
  'Para projeto ou setor novo, ofereça a entrevista guiada (/bancada:entrevista).',
];

function focusPrompt(project, engine, { bridge = false } = {}) {
  const lines = [
    'Esta sessão foi aberta pela Bancada (o app de trabalho do usuário).',
    `Projeto em foco: ${project.name} (${project.kind})${(project.paths || [])[0] ? ` — pasta: ${project.paths[0]}` : ' — sem pasta (projeto de live/música/outro)'}.`,
    engine ? `Você está rodando dentro do motor "${engine.name}": use as instruções, skills e protocolos dele como cérebro, e trabalhe no projeto em foco.`
      : 'Você está rodando na pasta do projeto. Quem usa pode não ser programador: explique em linguagem simples o que vai fazer antes de mexer nos arquivos.',
  ];
  if (project.where_stopped) lines.push(`Onde parou: ${String(project.where_stopped).slice(0, 600)}`);
  if (project.next_step) lines.push(`Próximo passo combinado: ${String(project.next_step).slice(0, 300)}`);
  if (bridge) lines.push(...BRIDGE_LINES);
  lines.push('Não comece a trabalhar sozinho: espere o pedido.');
  return lines.join('\n');
}

const NOT_INSTALLED = (name) => `${name} não está instalado neste Mac. Abra Ajustes → Assistentes de IA e clique em Instalar.`;

// Retorna { cwd, exec|command, sessionId } para um terminal. Tokens:
//   bancada:claude  → Claude no motor (ou, sem motor, na pasta do projeto); retoma a conversa presa a este terminal
//   bancada:engine  → só o shell, na pasta do motor
//   bancada:codex   → Codex na pasta do projeto
//   bancada:agy     → Google (Antigravity CLI) na pasta do projeto
//   (outro texto)   → comando literal, na pasta do terminal
// bins: caminhos absolutos achados pelo ai-tools ({claude, codex, google}); chamar pelo caminho absoluto é o que
// faz a Bancada funcionar mesmo com o .zshrc sem o PATH (o "erro de path"). Sem bins → nome simples (testes/legado).
// bridge (v0.4): { mcpConfig(termId, projectId) → arquivo, pluginDir } — ferramentas de pergunta e o comando /bancada:entrevista
// initialPrompt: primeira mensagem (ex.: "/bancada:entrevista setor novo"), só na abertura em que foi pedida
function launchSpec({ store, terminal, project, promptDir, hooksSettings = null, extraDirs = [], bins = null, bridge = null, initialPrompt = null }) {
  const engineCfg = store.engineFor(project);
  const projDir = (project.paths || [])[0] || null;
  const token = terminal.startup || null;
  const binOf = (k, name) => (bins ? bins[k] : name);
  if (token === 'bancada:codex' || token === 'bancada:agy') {
    const k = token === 'bancada:codex' ? 'codex' : 'google';
    const b = binOf(k, token === 'bancada:codex' ? 'codex' : 'agy');
    if (!b) return { cwd: projDir || terminal.cwd, command: null, warning: NOT_INSTALLED(k === 'codex' ? 'O Codex' : 'O Google (agy)') };
    return { cwd: projDir || terminal.cwd, exec: q(b), command: null };
  }
  if (token === 'bancada:claude' || token === 'bancada:engine') {
    const engineOk = !!(engineCfg && inspect(engineCfg.path).ok);
    const engine = engineOk ? engineCfg : null;
    const warning = engineCfg && !engineOk ? `Motor "${engineCfg.name}" não encontrado em ${engineCfg.path}. Abrindo na pasta do projeto.` : null;
    if (token === 'bancada:engine') return engine ? { cwd: engine.path, command: null } : { cwd: projDir || terminal.cwd, command: null, warning: warning || 'Nenhum motor configurado. Abrindo na pasta do projeto.' };
    const claude = binOf('claude', 'claude');
    if (!claude) return { cwd: projDir || terminal.cwd, command: null, warning: NOT_INSTALLED('O Claude') };
    let sid = terminal.session_id;
    const resume = !!(sid && sessionFileExists(sid));
    if (!sid) sid = crypto.randomUUID();
    const parts = [];
    // a ferramenta de pergunta espera o usuário responder (pode levar horas): sem limite curto de tempo
    if (bridge) parts.push('MCP_TOOL_TIMEOUT=86400000');
    parts.push(bins ? q(claude) : 'claude', resume ? `--resume ${q(sid)}` : `--session-id ${q(sid)}`, `-n ${q(`${project.name} · ${terminal.name}`)}`);
    if (terminal.skip_perms) parts.push('--dangerously-skip-permissions');   // escolha do usuário, por terminal
    // no motor, a pasta do projeto entra por --add-dir; sem motor, o Claude já roda dentro dela
    if (projDir && engine) parts.push(`--add-dir ${q(projDir)}`);
    for (const d of extraDirs) parts.push(`--add-dir ${q(d)}`);          // ex.: anexos/ (imagens coladas no terminal)
    // hooks da Bancada (estado trabalhando/esperando/terminou) SOMAM aos do motor; os settings da athena não são tocados
    if (hooksSettings) parts.push(`--settings ${q(hooksSettings)}`);
    if (bridge) {
      parts.push(`--mcp-config ${q(bridge.mcpConfig(terminal.id, project.id))}`);
      if (bridge.pluginDir) parts.push(`--plugin-dir ${q(bridge.pluginDir)}`);
    }
    // o texto de foco vai por arquivo (várias linhas e aspas não passam bem por linha de comando)
    const text = focusPrompt(project, engine, { bridge: !!bridge });
    if (promptDir) {
      fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
      const file = path.join(promptDir, `${terminal.id}.txt`);
      fs.writeFileSync(file, text, { mode: 0o600 });
      parts.push(`--append-system-prompt-file ${q(file)}`);
    } else parts.push(`--append-system-prompt ${q(text)}`);
    if (initialPrompt) parts.push('--', q(String(initialPrompt).slice(0, 4000)));
    // exec: o pty roda o claude direto (nada digitado no shell); ao sair do claude, fica um shell na mesma pasta
    const cwd = engine ? engine.path : (projDir || terminal.cwd || os.homedir());
    return { cwd, exec: parts.join(' '), command: null, sessionId: sid, engine, warning };
  }
  return { cwd: terminal.cwd || projDir, command: token };
}

module.exports = { inspect, EngineWatch, launchSpec, focusPrompt, q, sessionFileExists };
