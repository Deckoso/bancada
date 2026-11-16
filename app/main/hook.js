// Registro de evento do Claude para o Windows (v0.8, hooks leves). Roda FORA do app: a Bancada copia este arquivo para
// <pasta de dados>/hooks/hook.js e o hook.cmd ao lado o executa com o próprio executável da Bancada em modo Node
// (ELECTRON_RUN_AS_NODE=1; o fuse runAsNode está ligado). Sem dependências: só fs e path.
// Faz o mesmo que o emit.ps1 fazia: lê a entrada (JSON do evento), confere o id do terminal e o nome do evento, corta o
// payload (até 8000 bytes inteiro; maior, começo 2000 + " ... " + fim 6000) e grava UMA linha "Evento <ms> <payload>"
// em events/<BANCADA_TERM_ID>.log. Nunca escreve no stdout (no UserPromptSubmit viraria contexto do Claude); sai sempre 0.
'use strict';
const fs = require('fs');
const path = require('path');

const CLIP_MAX = 8000, CLIP_HEAD = 2000, CLIP_TAIL = 6000, CLIP_SEP = ' ... ';
const MAX_IN = 4 * 1024 * 1024;     // entrada maior que isso é descartada além do teto (memória limitada)

function clip(raw) {
  const b = Buffer.from(String(raw).replace(/[\r\n]/g, ''), 'utf8');
  if (b.length <= CLIP_MAX) return b.toString('utf8');
  return b.subarray(0, CLIP_HEAD).toString('utf8') + CLIP_SEP + b.subarray(b.length - CLIP_TAIL).toString('utf8');
}

function line(ev, payload, now = Date.now()) { return `${ev} ${now} ${clip(payload)}\n`; }

function valid(id, ev) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) && typeof ev === 'string' && /^[A-Za-z]{1,40}$/.test(ev); }

// grava com algumas tentativas (no Windows outro hook pode estar segurando o arquivo por um instante)
function append(file, text) {
  for (let i = 0; i < 8; i++) {
    try { fs.appendFileSync(file, text, { mode: 0o600 }); return true; } catch {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch {}
    }
  }
  return false;
}

function main() {
  const ev = process.argv[2];
  const id = process.env.BANCADA_TERM_ID;
  const chunks = []; let size = 0;
  // segurança: se a entrada nunca fechar, sai mesmo assim (não deixa processo pendurado)
  const guard = setTimeout(() => process.exit(0), 8000); guard.unref();
  process.stdin.on('data', (c) => { if (size < MAX_IN) { chunks.push(c); size += c.length; } });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    if (valid(id, ev)) append(path.join(__dirname, 'events', `${id}.log`), line(ev, Buffer.concat(chunks).toString('utf8')));
    process.exit(0);
  });
}

if (require.main === module) main();
module.exports = { clip, line, valid };
