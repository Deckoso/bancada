// Checagem das IAs: para cada uma, três degraus em português simples — instalada → conectada à conta → plano.
// Só lê o que o status já trouxe (`claude auth status` / `codex login status` não abrem navegador); não roda nada.
// Cada degrau que falha diz o que fazer e qual botão resolve (fix: 'install' | 'login'); os botões são os que já existem.
'use strict';

// assinaturas do Claude que incluem o Claude Code no terminal
const CLAUDE_PAID = new Set(['pro', 'max', 'team', 'enterprise']);
const PLAN_NAME = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
const SUGGEST_CODEX = 'Use o Codex: vem no ChatGPT, inclusive no plano gratuito.';

function planStep(st) {
  if (st.id === 'claude') {
    const sub = String(st.accountPlan || '').toLowerCase();
    if (CLAUDE_PAID.has(sub)) return { ok: true, text: `Plano ${PLAN_NAME[sub]}` };
    if (st.authMethod && !/claude\.ai/i.test(st.authMethod) && st.authMethod !== 'none') return { ok: true, text: 'Conta de API (paga pelo uso)' };
    return { ok: false, text: 'Sua conta do Claude não tem um plano que inclua o terminal (precisa do Pro ou Max).', hint: SUGGEST_CODEX, suggest: 'codex' };
  }
  if (st.id === 'codex') return { ok: null, text: 'O plano é conferido pelo ChatGPT quando você usa (o gratuito também serve).' };
  return { ok: null, text: 'O plano é conferido pelo Google quando você usa.' };
}

function checkup(st) {
  const steps = [];
  if (!st.installed) {
    steps.push({ key: 'installed', ok: false, text: `${st.name} não está instalado neste computador.`, hint: 'Clique em Instalar.', fix: 'install' });
    return { ready: false, steps, fix: 'install' };
  }
  steps.push({ key: 'installed', ok: true, text: `Instalado${st.version ? ` (versão ${st.version})` : ''}` });
  if (st.connected === false) {
    steps.push({ key: 'connected', ok: false, text: 'Ainda não está conectado à sua conta.', hint: 'Clique em Entrar na minha conta.', fix: 'login' });
    return { ready: false, steps, fix: 'login' };
  }
  if (st.connected !== true) {
    steps.push({ key: 'connected', ok: null, text: 'Não deu para conferir a conta agora (sem internet?).', hint: 'Clique em Testar para conferir de novo.' });
    return { ready: false, steps, fix: null };
  }
  steps.push({ key: 'connected', ok: true, text: `Conectado à sua conta${st.account ? ` (${st.account})` : ''}` });
  const plan = { key: 'plan', ...planStep(st) };
  steps.push(plan);
  return { ready: plan.ok !== false, steps, fix: null, suggest: plan.suggest || null };
}

// Checagem da voz (v0.8): motor presente → (Windows) runtime do Visual C++ → modelo baixado e conferido → microfone.
// st = voice.status() + perm { mic } do sistema. fix: 'download' | 'vc' | 'mic' (a tela põe o botão e a ajuda do sistema).
const MB = (b) => Math.round(b / 1048576 / 10) * 10;   // "≈ 550 MB"
function voiceCheckup(st, { win = false } = {}) {
  const steps = [];
  if (!st || !st.binary) {
    steps.push({ key: 'binary', ok: false, text: 'O motor de voz não veio nesta instalação.', hint: 'Reinstale a Bancada.' });
    return { ready: false, steps };
  }
  steps.push({ key: 'binary', ok: true, text: 'Motor de voz instalado (whisper.cpp, roda neste computador, sem internet)' });
  let ready = true;
  if (win) {
    const vc = st.vc || { ok: false, missing: [] };
    if (vc.ok) steps.push({ key: 'vc', ok: true, text: 'Runtime do Visual C++ presente' });
    else { ready = false; steps.push({ key: 'vc', ok: false, text: `Falta o runtime do Visual C++ da Microsoft${vc.missing.length ? ` (${vc.missing.join(', ')})` : ''}.`, hint: 'Clique em Instalar runtime (instalador oficial da Microsoft) e depois em Testar.', fix: 'vc' }); }
  }
  const m = st.model || {};
  if (st.downloading) { ready = false; steps.push({ key: 'model', ok: null, text: `Baixando o modelo de voz… ${Math.round(st.downloading.got / st.downloading.total * 100)}%` }); }
  else if (!m.present) { ready = false; steps.push({ key: 'model', ok: false, text: 'Modelo de voz ainda não baixado.', hint: `Clique em Baixar voz (≈ ${MB(m.size || 0)} MB). Uma vez só; depois funciona sem internet.`, fix: 'download' }); }
  else steps.push({ key: 'model', ok: true, text: `Modelo baixado: ${m.label}${m.verified ? ' · conferido (SHA-256)' : ''}` });
  const mic = st.perm && st.perm.mic;
  if (mic === 'granted') steps.push({ key: 'mic', ok: true, text: 'Microfone liberado para a Bancada' });
  else if (mic === 'denied' || mic === 'restricted') { ready = false; steps.push({ key: 'mic', ok: false, text: 'O microfone está bloqueado para a Bancada.', fix: 'mic' }); }
  else if (mic === 'not-determined') steps.push({ key: 'mic', ok: null, text: 'O sistema pergunta pelo microfone na 1ª vez que você usar o 🎤.' });
  // Windows sem placa de vídeo: se a última frase passou de ~6 s, o modelo rápido ajuda
  if (win && st.lastMs > 6000 && m.id !== 'small') steps.push({ key: 'speed', ok: null, text: `A última frase levou ${Math.round(st.lastMs / 1000)} s neste computador.`, hint: 'Se achar lento, troque o modelo para "Rápido" (erra mais nomes técnicos).' });
  return { ready, steps };
}

// Checagem do recorte de tela (v0.8): no Mac, a permissão de Gravação de Tela da Bancada (só lida, nunca pedida
// daqui: o sistema pergunta no 1º recorte). Sem ela o recorte sai só com o papel de parede. Windows: nada a liberar.
// O sistema só responde "liberada" ou "negada" (nunca "não perguntado"): negada = "ainda não tem", sem acusar o usuário.
function shotCheckup(perm, { win = false } = {}) {
  if (win) return { ready: true, steps: [{ key: 'tool', ok: true, text: 'O recorte usa a Ferramenta de Captura do Windows: nada a liberar.' }] };
  if (perm === 'granted') return { ready: true, steps: [{ key: 'screen', ok: true, text: 'Gravação de Tela liberada para a Bancada' }] };
  if (perm === 'denied' || perm === 'restricted') return { ready: false, steps: [{ key: 'screen', ok: false, text: 'A Bancada ainda não tem a permissão de Gravação de Tela. O sistema pergunta no 1º recorte (📷); se já foi negada, o recorte sai só com o papel de parede, sem as janelas.', fix: 'screen' }] };
  return { ready: true, steps: [{ key: 'screen', ok: null, text: 'O sistema pede a permissão de Gravação de Tela no 1º recorte (📷). Depois de liberar, feche e abra a Bancada.' }] };
}

module.exports = { checkup, voiceCheckup, shotCheckup, CLAUDE_PAID, SUGGEST_CODEX };
