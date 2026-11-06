// Cartões de pergunta (BP-2026-11-06-002 E1): recebe os pedidos do servidor MCP da Bancada (mcp-server.js), mostra na
// tela e devolve a resposta. Ponte por arquivos numa pasta 0700 (asks/ → answers/), igual aos hooks: sem porta.
// "Adiar" numa lista vira pendência do projeto (item type 'pending'), sem aviso — decisão de projeto (06/11).
// Memória: no máximo MAX_OPEN cartões abertos; arquivo de pedido > 64 KB é recusado.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_OPEN = 20;
const MAX_FILE = 64 * 1024;
const SCAN_MS = 1500;
const NAME_RE = /^([A-Za-z0-9_-]{1,80})\.(\d{1,10})-(\d{1,6})\.json$/;
const DEFAULT_OPTS = ['Já fiz', 'Adiar', 'Fazer agora'];
const ADIAR_RE = /^adiar\b/i;

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+$/g, '').slice(0, n);
const line = (s, n) => clip(String(s == null ? '' : s).replace(/[\r\n]+/g, ' '), n);

function normLista(a) {
  const itens = (Array.isArray(a.itens) ? a.itens : []).slice(0, 30)
    .map(i => typeof i === 'string' ? { texto: line(i, 400), detalhe: '' } : { texto: line(i && i.texto, 400), detalhe: line(i && i.detalhe, 600) })
    .filter(i => i.texto);
  if (!itens.length) throw new Error('lista sem itens');
  let opcoes = Array.isArray(a.opcoes) ? a.opcoes.map(o => line(o, 30)).filter(Boolean).slice(0, 4) : [];
  if (opcoes.length < 2) opcoes = DEFAULT_OPTS.slice();
  return { titulo: line(a.titulo, 200) || 'Marque cada item', itens, opcoes };
}

function normPerguntar(a) {
  const pergunta = clip(a.pergunta, 600).trim();
  if (!pergunta) throw new Error('pergunta vazia');
  const opcoes = (Array.isArray(a.opcoes) ? a.opcoes : []).slice(0, 6)
    .map(o => typeof o === 'string' ? { rotulo: line(o, 80), descricao: '' } : { rotulo: line(o && o.rotulo, 80), descricao: line(o && o.descricao, 240) })
    .filter(o => o.rotulo);
  return { pergunta, opcoes, multipla: !!a.multipla && opcoes.length > 1, texto_livre: a.texto_livre !== false || !opcoes.length,
    etapa: line(a.etapa, 40), resumo: clip(a.resumo, 1500) };
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class AskBroker {
  // store: db da Bancada · paste(termId, text): cola no terminal (conversa morreu) · execPath: binário que roda o servidor
  constructor({ dir, store, onChange, paste, onItems, execPath = process.execPath, serverSrc = path.join(__dirname, 'mcp-server.js') }) {
    this.dir = dir; this.store = store; this.onChange = onChange || (() => {}); this.paste = paste || (() => {}); this.onItems = onItems || (() => {});
    this.execPath = execPath; this.serverSrc = serverSrc;
    this.asksDir = path.join(dir, 'asks'); this.answersDir = path.join(dir, 'answers'); this.cfgDir = path.join(dir, 'cfg');
    this.serverFile = path.join(dir, 'bancada-mcp.js');
    this.open = new Map();      // nome do arquivo -> { id, term, project, kind, args, at, pid, orphan }
    this.seen = new Set();      // já tratados (recusados, respondidos): não reler até o servidor apagar o arquivo
    this.watcher = null; this.timer = null;
  }

  setup() {
    for (const d of [this.dir, this.asksDir, this.answersDir, this.cfgDir]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} }
    // o servidor sai de dentro do app (asar) para uma pasta comum: o modo node do Electron roda arquivo comum sem surpresa
    fs.writeFileSync(this.serverFile, fs.readFileSync(this.serverSrc), { mode: 0o600 });
    // pedidos de uma abertura anterior não valem mais (as conversas que esperavam por eles já recebem erro)
    for (const d of [this.asksDir, this.answersDir]) for (const f of fs.readdirSync(d)) { try { fs.unlinkSync(path.join(d, f)); } catch {} }
    return this;
  }

  // config MCP de UM terminal (o id do terminal vai no env do servidor; o Claude não precisa repassar o dele)
  configFor(termId, projectId) {
    const file = path.join(this.cfgDir, `${termId}.json`);
    const cfg = { mcpServers: { bancada: { type: 'stdio', command: this.execPath, args: [this.serverFile],
      env: { ELECTRON_RUN_AS_NODE: '1', BANCADA_ASK_DIR: this.dir, BANCADA_TERM_ID: String(termId), BANCADA_PROJECT: String(projectId || '') } } } };
    writeAtomic(file, JSON.stringify(cfg, null, 1));
    return file;
  }

  start() {
    try { this.watcher = fs.watch(this.asksDir, () => this.scan()); this.watcher.on('error', () => {}); } catch {}
    this.timer = setInterval(() => this.scan(), SCAN_MS);   // reserva (fs.watch pode perder evento) + checa conversa viva
    this.scan();
  }
  stop() { if (this.watcher) this.watcher.close(); clearInterval(this.timer); this.watcher = null; this.timer = null; }

  scan() {
    let files; try { files = fs.readdirSync(this.asksDir); } catch { return; }
    let changed = false;
    const present = new Set(files);
    for (const name of this.open.keys()) if (!present.has(name)) { this.open.delete(name); changed = true; }   // cancelado (Esc)
    for (const name of files) {
      if (this.open.has(name) || this.seen.has(name) || !NAME_RE.test(name)) continue;
      const r = this.load(name);
      if (r && r !== 'quick') { this.open.set(name, r); changed = true; } else this.seen.add(name);
    }
    for (const a of this.open.values()) {
      const orphan = !pidAlive(a.pid);
      if (orphan !== a.orphan) { a.orphan = orphan; changed = true; }
    }
    for (const name of this.seen) if (!present.has(name)) this.seen.delete(name);   // servidor apagou: esquece
    if (changed) this.onChange(this.list());
  }

  load(name) {
    const file = path.join(this.asksDir, name);
    let raw;
    try { const st = fs.statSync(file); if (!st.isFile() || st.size > MAX_FILE) return null; raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const m = NAME_RE.exec(name);
    if (!raw || raw.term !== m[1] || Number(raw.pid) !== Number(m[2])) return null;
    const row = this.store.getTerminal(raw.term);
    const project = row ? row.project_id : (this.store.getProject(String(raw.project || '')) ? String(raw.project) : null);
    const base = { id: name, term: raw.term, project, pid: Number(raw.pid), at: Date.now(), orphan: false };
    try {
      if (raw.kind === 'pendencias') { this.write(name, this.pendencias(project, raw.args || {})); return 'quick'; }
      if (this.open.size >= MAX_OPEN) { this.write(name, { ok: false, text: 'Há cartões demais abertos na Bancada. Espere o usuário responder os outros.' }); return 'quick'; }
      if (raw.kind === 'lista') return { ...base, kind: 'lista', args: normLista(raw.args || {}) };
      if (raw.kind === 'perguntar') return { ...base, kind: 'perguntar', args: normPerguntar(raw.args || {}) };
    } catch (e) { this.write(name, { ok: false, text: `Pedido inválido: ${e.message}` }); return 'quick'; }
    return null;
  }

  write(name, ans) { writeAtomic(path.join(this.answersDir, name), JSON.stringify(ans)); }

  list() { return [...this.open.values()].map(({ pid, ...a }) => a); }

  // resposta vinda da tela (Mac ou celular). Retorna o texto que o Claude recebe.
  answer(id, payload) {
    const a = this.open.get(String(id));
    if (!a) { const e = new Error('esse cartão já foi respondido ou fechado'); e.code = 'GONE'; throw e; }
    const text = a.kind === 'lista' ? this.answerLista(a, payload || {}) : answerPerguntar(a, payload || {});
    this.finish(a, text);
    return { text };
  }

  dismiss(id) {
    const a = this.open.get(String(id)); if (!a) return false;
    this.finish(a, 'O usuário fechou o cartão sem responder. Não insista; siga ou pergunte por texto se for indispensável.');
    return true;
  }

  finish(a, text) {
    this.open.delete(a.id); this.seen.add(a.id);
    if (a.orphan || !pidAlive(a.pid)) {
      // a conversa que perguntou já acabou: a resposta vai como mensagem no terminal
      try { fs.unlinkSync(path.join(this.asksDir, a.id)); } catch {}
      const sent = this.paste(a.term, text.replace(/\n/g, ' · '));
      this.onChange(this.list());
      if (!sent) { const e = new Error('A conversa que perguntou acabou e o terminal não está mais no Claude: a resposta não foi enviada (por segurança, nada é colado num shell).'); e.code = 'NO_CLAUDE'; throw e; }
      return;
    }
    this.write(a.id, { ok: true, text });
    this.onChange(this.list());
  }

  answerLista(a, p) {
    const { titulo, itens, opcoes } = a.args;
    const esc = Array.isArray(p.escolhas) ? p.escolhas : [];
    const lines = [`Respostas do usuário — ${titulo}:`];
    const adiados = [];
    itens.forEach((it, i) => {
      const e = esc[i] || {};
      const k = Number.isInteger(e.opcao) && e.opcao >= 0 && e.opcao < opcoes.length ? e.opcao : null;
      const nota = line(e.nota, 400);
      lines.push(`${i + 1}. [${k == null ? 'sem resposta' : opcoes[k]}] ${it.texto}${nota ? ` (nota: ${nota})` : ''}`);
      if (k != null && ADIAR_RE.test(opcoes[k])) adiados.push(it.texto + (it.detalhe ? ` — ${it.detalhe}` : '') + (nota ? ` (nota: ${nota})` : ''));
    });
    const geral = line(p.nota, 600);
    if (geral) lines.push(`Comentário geral: ${geral}`);
    if (adiados.length) {
      const n = a.project ? this.addPending(a.project, adiados) : 0;
      lines.push(n ? `→ ${n} item(ns) adiado(s) guardado(s) nas pendências do projeto.` : '→ Itens adiados já estavam nas pendências.');
    }
    return lines.join('\n');
  }

  activePending(project) {
    return this.store.listItems(project).filter(i => i.type === 'pending' && i.state === 'active');
  }

  addPending(project, texts) {
    const have = new Set(this.activePending(project).map(i => i.text.trim().toLowerCase()));
    let n = 0;
    for (const t of texts) {
      const k = t.trim().toLowerCase(); if (!k || have.has(k)) continue;
      this.store.createItem({ project_id: project, text: t.trim(), type: 'pending' }); have.add(k); n++;
    }
    if (n) this.onItems(project);
    return n;
  }

  pendencias(project, args) {
    if (!project) return { ok: false, text: 'Este terminal não pertence a um projeto da Bancada.' };
    const acao = String(args.acao || 'listar');
    const itens = (Array.isArray(args.itens) ? args.itens : []).slice(0, 30).map(x => line(x, 600)).filter(Boolean);
    const cur = this.activePending(project);
    const fmt = (list) => list.length ? list.map((i, k) => `#${k + 1} ${i.text}`).join('\n') : '(nenhuma pendência)';
    if (acao === 'listar') return { ok: true, text: `Pendências do projeto (${cur.length}):\n${fmt(cur)}` };
    if (acao === 'adicionar') { const n = this.addPending(project, itens); return { ok: true, text: `${n} pendência(s) adicionada(s).` }; }
    if (acao === 'concluir' || acao === 'remover') {
      const hit = new Set();
      for (const x of itens) {
        const m = /^#?(\d{1,3})$/.exec(x.trim());
        const it = m ? cur[Number(m[1]) - 1] : cur.find(i => i.text.trim().toLowerCase() === x.trim().toLowerCase());
        if (it) hit.add(it);
      }
      for (const it of hit) this.store.updateItem(it.id, acao === 'concluir' ? { state: 'done' } : { deleted: true });
      if (hit.size) this.onItems(project);
      return { ok: true, text: `${hit.size} pendência(s) ${acao === 'concluir' ? 'concluída(s)' : 'removida(s)'}.${hit.size < itens.length ? ' Algumas não foram achadas: use o número (#) de "listar".' : ''}` };
    }
    return { ok: false, text: `ação desconhecida: ${acao}` };
  }
}

function answerPerguntar(a, p) {
  const { opcoes, multipla } = a.args;
  const texto = clip(p.texto, 4000).trim();
  if (p.acao === 'pular') return `PULOU${texto ? ` — comentou: ${texto}` : ''}`;
  if (p.acao === 'chega') return `CHEGA — o usuário quer parar as perguntas e ver o resumo final para confirmar.${texto ? ` Comentou: ${texto}` : ''}`;
  let idx = (Array.isArray(p.escolhas) ? p.escolhas : []).filter(k => Number.isInteger(k) && k >= 0 && k < opcoes.length);
  idx = [...new Set(idx)]; if (!multipla) idx = idx.slice(0, 1);
  const parts = [];
  if (idx.length) parts.push(`Resposta: ${idx.map(k => opcoes[k].rotulo).join('; ')}`);
  if (texto) parts.push(`${idx.length ? 'E escreveu' : 'Resposta (texto)'}: ${texto}`);
  return parts.length ? parts.join('\n') : 'O usuário confirmou sem escolher nada nem escrever.';
}

module.exports = { AskBroker, normLista, normPerguntar, answerPerguntar, DEFAULT_OPTS };
