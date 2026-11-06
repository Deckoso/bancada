// Medidor de contexto (BP-2026-11-05-001 E5): quanto da janela de contexto a conversa já usa.
// Fonte: o `usage` da última resposta do assistente na transcrição (~/.claude/projects/*/<sessão>.jsonl).
// Lê só o fim do arquivo (512 KB). Mesma conta da barra de status do Claude (entrada + cache, sem a saída).
// Janela: 1 M para a família 5 (Opus/Fable/Sonnet 5.x: a barra do Claude mostra 67k/1m no Opus 5.5), para [1m] ou se já
// passou de 200 k; senão 200 k.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TAIL = 512 * 1024;
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function configuredModel(home = os.homedir()) {
  try { return String(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).model || ''); } catch { return ''; }
}

function usageTokens(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

function measure(transcript, { root = PROJECTS, model = configuredModel() } = {}) {
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return null;
  let real; try { real = fs.realpathSync(transcript); } catch { return null; }
  let realRoot; try { realRoot = fs.realpathSync(root); } catch { return null; }
  if (!real.startsWith(realRoot + path.sep)) return null;            // só transcrições do Claude
  let text;
  try {
    const st = fs.statSync(real); const len = Math.min(st.size, TAIL);
    const buf = Buffer.alloc(len); const fd = fs.openSync(real, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'assistant' || d.isSidechain || !d.message || !d.message.usage) continue;
    const tokens = usageTokens(d.message.usage);
    if (!tokens) continue;
    const id = d.message.model || '';
    const big = /\[1m\]/i.test(model) || /\[1m\]/i.test(id) || /^claude-(opus|fable|sonnet)-5/.test(id) || tokens > 200000;
    const window = big ? 1000000 : 200000;
    return { tokens, window, pct: Math.min(100, Math.round((tokens / window) * 100)), model: d.message.model || null };
  }
  return null;
}

module.exports = { measure, usageTokens };
