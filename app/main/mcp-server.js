// Servidor MCP da Bancada (BP-2026-11-06-002 E1). O Claude o lança por --mcp-config; roda no próprio executável da
// Bancada com ELECTRON_RUN_AS_NODE=1 (o leigo não precisa ter Node). Sem dependências: JSON-RPC, uma mensagem por linha.
// Ponte com a Bancada: grava o pedido em <ASK_DIR>/asks/<term>.<n>.json e espera <ASK_DIR>/answers/<mesmo nome>.
// Sem porta, sem socket: pastas 0700 do usuário. Memória: no máximo alguns pedidos abertos, cada um ≤ 64 KB.
'use strict';
const fs = require('fs');
const path = require('path');

const ASK_DIR = process.env.BANCADA_ASK_DIR;
const TERM = String(process.env.BANCADA_TERM_ID || '');
const PROJECT = String(process.env.BANCADA_PROJECT || '');
const POLL_MS = 300;
const QUICK_MS = 10000;            // pendencias: a Bancada responde na hora; sem resposta em 10 s = Bancada fechada
const MAX_ARGS = 64 * 1024;

const TOOLS = [
  {
    name: 'lista',
    description: 'Mostra ao usuário uma LISTA de itens num cartão da Bancada, para ele marcar cada item com um toque ' +
      '(padrão: "Já fiz" / "Adiar" / "Fazer agora") e, se quiser, deixar uma nota. Use SEMPRE que for apresentar ' +
      'pendências, próximos passos ou várias decisões do mesmo tipo, em vez de escrever a lista e esperar resposta por ' +
      'texto (tocar é mais fácil que escrever, e quem precisa escrever esquece itens). Até 30 itens, frases curtas. Os marcados "Adiar" ' +
      'vão sozinhos para as pendências do projeto. Espera a resposta e devolve a escolha de cada item.',
    inputSchema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título curto do cartão, ex.: "O que resta na Bancada"' },
        itens: {
          type: 'array', minItems: 1, maxItems: 30,
          items: { type: 'object', properties: { texto: { type: 'string', description: 'O item, curto' }, detalhe: { type: 'string', description: 'Uma linha de contexto (opcional)' } }, required: ['texto'] },
        },
        opcoes: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' }, description: 'Opcional. Botões de cada item; o padrão é ["Já fiz","Adiar","Fazer agora"]' },
      },
      required: ['titulo', 'itens'],
    },
  },
  {
    name: 'perguntar',
    description: 'Faz UMA pergunta ao usuário num cartão da Bancada, com opções clicáveis e espaço para texto livre. Use ' +
      'em entrevistas (uma pergunta por vez, cada uma nascida da resposta anterior) e em qualquer decisão em que opções ' +
      'ajudam. Dê 2 a 5 opções concretas quando der (a mais provável primeiro). Mande em "resumo" o que você já entendeu ' +
      'até aqui, em 2 a 5 linhas: ele vê e corrige. Espera a resposta. A resposta pode vir como PULOU (não quis ' +
      'responder esta) ou CHEGA (quer parar as perguntas e ver o resumo final).',
    inputSchema: {
      type: 'object',
      properties: {
        pergunta: { type: 'string' },
        opcoes: { type: 'array', maxItems: 6, items: { type: 'object', properties: { rotulo: { type: 'string' }, descricao: { type: 'string' } }, required: ['rotulo'] } },
        multipla: { type: 'boolean', description: 'true = pode marcar várias opções' },
        texto_livre: { type: 'boolean', description: 'false = só as opções (padrão: true)' },
        etapa: { type: 'string', description: 'Ex.: "Pergunta 3" ou "Usuários"' },
        resumo: { type: 'string', description: 'O que você já entendeu até agora' },
      },
      required: ['pergunta'],
    },
  },
  {
    name: 'pendencias',
    description: 'Lê ou muda a lista de PENDÊNCIAS do projeto deste terminal, guardada na Bancada (inclui o que o usuário ' +
      'marcou "Adiar"). Quando ele perguntar "o que resta" ou "onde estamos", comece por acao="listar", junte com o que ' +
      'você sabe e mostre tudo com a ferramenta "lista". Responde na hora (sem cartão).',
    inputSchema: {
      type: 'object',
      properties: {
        acao: { type: 'string', enum: ['listar', 'adicionar', 'concluir', 'remover'] },
        itens: { type: 'array', maxItems: 30, items: { type: 'string' }, description: 'adicionar: textos novos; concluir/remover: o número (#) ou o texto de cada pendência' },
      },
      required: ['acao'],
    },
  },
];

let seq = 0;
const open = new Map();   // rpc id -> { file, timer }

function out(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { out({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { out({ jsonrpc: '2.0', id, error: { code, message } }); }
function text(id, t, isError = false) { reply(id, { content: [{ type: 'text', text: t }], isError }); }

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function ask(rpcId, kind, args) {
  if (!ASK_DIR || !/^[A-Za-z0-9_-]{1,80}$/.test(TERM)) return text(rpcId, 'A ponte da Bancada não está configurada neste terminal.', true);
  const body = JSON.stringify({ kind, args: args || {}, term: TERM, project: PROJECT, pid: process.pid, at: Date.now() });
  if (Buffer.byteLength(body) > MAX_ARGS) return text(rpcId, 'Pedido grande demais para o cartão (máx. 64 KB). Encurte os textos.', true);
  const name = `${TERM}.${process.pid}-${++seq}.json`;
  const askFile = path.join(ASK_DIR, 'asks', name);
  const ansFile = path.join(ASK_DIR, 'answers', name);
  try { writeAtomic(askFile, body); } catch (e) { return text(rpcId, `Não consegui falar com a Bancada: ${e.message}`, true); }
  const started = Date.now();
  const entry = { file: askFile, timer: null };
  open.set(rpcId, entry);
  const tick = () => {
    if (!open.has(rpcId)) return;
    let a = null;
    try { a = JSON.parse(fs.readFileSync(ansFile, 'utf8')); } catch {}
    if (a) {
      open.delete(rpcId);
      try { fs.unlinkSync(ansFile); } catch {}
      try { fs.unlinkSync(askFile); } catch {}
      return text(rpcId, String(a.text || ''), !a.ok);
    }
    if (kind === 'pendencias' && Date.now() - started > QUICK_MS) {
      open.delete(rpcId); try { fs.unlinkSync(askFile); } catch {}
      return text(rpcId, 'A Bancada não respondeu (está aberta?).', true);
    }
    entry.timer = setTimeout(tick, POLL_MS);
  };
  entry.timer = setTimeout(tick, kind === 'pendencias' ? 60 : POLL_MS);
}

function cancel(rpcId) {
  const e = open.get(rpcId); if (!e) return;
  open.delete(rpcId); clearTimeout(e.timer);
  try { fs.unlinkSync(e.file); } catch {}        // o cartão some da Bancada
}

function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bancada', version: '0.4.0' } });
  }
  if (method === 'notifications/cancelled') return cancel(params && params.requestId);
  if (method && method.startsWith('notifications/')) return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some(t => t.name === name)) return fail(id, -32602, `ferramenta desconhecida: ${name}`);
    return ask(id, name, params.arguments);
  }
  if (id != null) fail(id, -32601, `método não suportado: ${method}`);
}

function main() {
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  if (buf.length > 4 * MAX_ARGS) { buf = ''; return; }      // linha absurda: descarta (memória limitada)
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    try { handle(msg); } catch (e) { if (msg && msg.id != null) fail(msg.id, -32603, e.message); }
  }
});
// o Claude fechou: tira os cartões abertos e sai
process.stdin.on('end', () => { for (const k of [...open.keys()]) cancel(k); process.exit(0); });
}

if (require.main === module) main();
module.exports = { TOOLS };
