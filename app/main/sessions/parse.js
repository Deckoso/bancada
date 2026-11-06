// Interpretação de uma linha .jsonl do Claude Code / Codex.
// Retorno: objeto com o que interessa | null (linha válida sem interesse) | undefined (formato desconhecido — contado).
// Formatos conferidos em 2026-11-04 (Claude Code 2.1.318; Codex Desktop 0.163).
'use strict';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Pastas de trabalho citadas num texto: .../Documents/<raiz>/PROJETOS/<cat>/<proj> ou .../Documents/<raiz>/<pasta>
const DIR_RE = /\/(?:Users|home)\/[^/\s"\\]+\/Documents\/[^/"\\\n]+\/(?:PROJETOS\/[^/"\\\s]+\/[^/"\\\s'`;|&)]+|[^/"\\\n]+)/g;

function dirHits(str, into = {}) {
  if (!str || str.length > 4 * 1024 * 1024) return into;
  for (const m of str.matchAll(DIR_RE)) {
    const k = m[0].replace(/[\s.,:]+$/, '');
    into[k] = (into[k] || 0) + 1;
  }
  return into;
}

function ts(x) { const t = Date.parse(x); return Number.isFinite(t) ? t : null; }

function isHumanPrompt(text) {
  if (typeof text !== 'string') return false;
  const t = text.trimStart();
  if (!t) return false;
  // mensagens geradas pelo próprio Claude Code (comandos locais, lembretes do sistema, avisos)
  return !(t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted'));
}

function parseClaudeLine(line) {
  if (!line || line[0] !== '{') return undefined;
  const d = JSON.parse(line);
  const base = { at: ts(d.timestamp), cwd: d.cwd || null };
  switch (d.type) {
    case 'ai-title':
      return d.aiTitle ? { title: String(d.aiTitle) } : null;
    case 'user': {
      if (d.isMeta || d.isSidechain) return null;
      const c = d.message && d.message.content;
      if (typeof c === 'string' && isHumanPrompt(c)) return { ...base, prompt: c.trim() };
      return base.at ? base : null;
    }
    case 'assistant': {
      const blocks = (d.message && Array.isArray(d.message.content)) ? d.message.content : [];
      const r = { ...base, files: [], hits: {} };
      for (const b of blocks) {
        if (b.type === 'text' && !d.isSidechain && b.text && b.text.trim()) r.reply = b.text.trim();
        else if (b.type === 'tool_use' && b.input) {
          dirHits(JSON.stringify(b.input), r.hits);
          if (EDIT_TOOLS.has(b.name) && typeof (b.input.file_path || b.input.notebook_path) === 'string') {
            r.files.push(b.input.file_path || b.input.notebook_path);
          }
        }
      }
      return r;
    }
    case 'system': case 'attachment': case 'summary': case 'mode': case 'permission-mode': case 'last-prompt':
    case 'file-history-snapshot': case 'session-owner': case 'api-request': case 'api-request-blob':
    case 'api-request-shape': case 'tools-used': case 'atis-latch':
      return null;
    default:
      return d.type ? null : undefined;
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('\n').trim();
}

function parseCodexLine(line) {
  if (!line || line[0] !== '{') return undefined;
  const d = JSON.parse(line);
  const p = d.payload || {};
  const at = ts(d.timestamp);
  if (d.type === 'session_meta') return { at: ts(p.timestamp) || at, cwd: p.cwd || null, sessionId: p.id || p.session_id || null };
  if (d.type === 'event_msg') {
    if (p.type === 'item_completed' && p.item) {
      if (p.item.type === 'UserMessage') { const t = textOf(p.item.content); return isHumanPrompt(t) ? { at, prompt: t } : null; }
      if (p.item.type === 'McpToolCall') return { at, hits: dirHits(JSON.stringify(p.item)) };
      return null;
    }
    if (p.type === 'task_complete' && typeof p.last_agent_message === 'string') return { at, reply: p.last_agent_message.trim() };
    return null;
  }
  if (d.type === 'response_item') {
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const args = typeof p.arguments === 'string' ? p.arguments : (typeof p.input === 'string' ? p.input : JSON.stringify(p.arguments || p.input || ''));
      const files = [];
      for (const m of args.matchAll(/\*\*\* (?:Update|Add) File: ([^\n\\]+)/g)) files.push(m[1].trim());
      return { at, hits: dirHits(args), files };
    }
    return null;
  }
  if (['turn_context', 'world_state', 'token_usage_record', 'compacted'].includes(d.type)) return null;
  return d.type ? null : undefined;
}

module.exports = { parseClaudeLine, parseCodexLine, dirHits, isHumanPrompt };
