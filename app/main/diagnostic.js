// "Relatar problema" (v0.8): monta um texto curto para o usuário colar numa mensagem para quem passou a Bancada.
// Entra: versão do app e do sistema, versões das IAs e o estado da Checagem (instalada/conectada/plano, sem conta),
// as respostas dos cartões de retorno e as últimas linhas do registro (logs/bancada.log).
// NUNCA entra: saída de terminal, conversa, prompt, conta/e-mail. Caminhos: o home vira ~ e os de fora dele (C:\…, D:\…,
// /Volumes/…) viram só o nome do arquivo. Tudo passa pela redação (log.js) no fim.
'use strict';
const { redact } = require('./log');

const LOG_LINES = 150;
const MAX_TEXT = 60 * 1024;
const mark = (ok) => (ok === true ? 'ok' : ok === false ? 'falta' : '?');

function aiLine(st) {
  if (!st || typeof st !== 'object') return null;
  const name = String(st.name || st.id || '?');
  if (!st.installed) return `- ${name}: não instalado`;
  const steps = (st.checkup && Array.isArray(st.checkup.steps)) ? st.checkup.steps.map(s => `${s.key}=${mark(s.ok)}`).join(' ') : '';
  const conn = st.connected === true ? 'conectado' : st.connected === false ? 'não conectado' : 'conexão não conferida';
  const plan = st.accountPlan ? ` · plano ${String(st.accountPlan).slice(0, 20)}` : '';
  const ready = st.checkup ? (st.checkup.ready ? ' · Checagem: pronto' : ' · Checagem: falta algo') : '';
  return `- ${name}: ${st.version ? 'versão ' + String(st.version).slice(0, 30) : 'versão ?'} · ${conn}${plan}${ready}${steps ? ` (${steps})` : ''}`;
}

// a nota pode vir do celular (feedback:answer é liberado no acesso remoto): redigida aqui e de novo no texto inteiro
function fbLine(f, home) {
  const d = new Date(f.at); const p = (n) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `- ${when} ${f.kind === 'week' ? 'semana' : 'travou?'}: ${f.answer}${f.note ? ` — "${redact(String(f.note).slice(0, 300), { home })}"` : ''}`;
}

// info: { version, packaged, platform, release, arch, electron, locale, ais: [status], logLines: [], feedback: [], crashes, uptimeMin }
function buildReport(info, { home } = {}) {
  const i = info || {};
  const out = [
    'Relatório da Bancada (gerado pelo app; sem conteúdo de terminal, conversas ou senhas)',
    `Data: ${new Date(i.now || Date.now()).toISOString()}`,
    `App: Bancada ${i.version || '?'}${i.packaged === false ? ' (modo dev)' : ''} · Electron ${i.electron || '?'}`,
    `Sistema: ${i.platform || '?'} ${i.release || ''} ${i.arch || ''}${i.locale ? ' · ' + i.locale : ''}`.trim(),
  ];
  if (i.uptimeMin != null) out.push(`Aberta há: ${i.uptimeMin} min`);
  if (i.crashes != null) out.push(`Relatórios de travamento guardados: ${i.crashes}`);
  out.push('', 'IAs:');
  const ais = Array.isArray(i.ais) ? i.ais.map(aiLine).filter(Boolean) : [];
  out.push(...(ais.length ? ais : ['- (não deu para conferir agora)']));
  if (Array.isArray(i.feedback) && i.feedback.length) out.push('', 'Respostas dos cartões:', ...i.feedback.slice(0, 20).map(f => fbLine(f, home)));
  const lines = Array.isArray(i.logLines) ? i.logLines.slice(-LOG_LINES) : [];
  out.push('', `Registro (últimas ${lines.length} linhas):`, ...(lines.length ? lines : ['(vazio)']));
  let text = redact(out.join('\n'), { home });
  if (text.length > MAX_TEXT) text = text.slice(0, 2000) + '\n…\n' + text.slice(-(MAX_TEXT - 2100));
  return text;
}

module.exports = { buildReport, aiLine, LOG_LINES };
