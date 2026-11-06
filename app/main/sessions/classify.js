// Classificador de sessão → projeto (D9). Honesto: empate ou pouca evidência = "sem projeto" (null).
// Pesos: cada arquivo/pasta do projeto tocado por ferramenta = 3; sessão aberta na pasta do projeto = 4;
// nome do projeto citado no título ou num pedido = 2.
'use strict';

const W_HIT = 3, W_HUB_HIT = 1, W_CWD = 4, W_NAME = 2, MIN_SCORE = 3;

function norm(s) {
  return ' ' + String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

function phrases(p) {
  const out = new Set();
  for (const n of [p.name, ...(p.aliases || [])]) {
    const sp = norm(n).trim();
    if (sp.length >= 3) { out.add(` ${sp} `); out.add(` ${sp.replace(/ /g, '')} `); }
  }
  return [...out];
}

function under(child, parent) { return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/'); }

function score(s, p) {
  let sc = 0;
  const paths = p.paths || [];
  // "pasta-hub": o projeto onde a sessão está parada (ex.: athena-os) é de onde o usuário trabalha, não
  // necessariamente no que ele trabalha. Arquivos dele valem 1 em vez de 3; os outros projetos tocados ganham.
  const isHub = !!(s.cwd && paths.some(pp => under(s.cwd, pp)));
  const w = isHub ? W_HUB_HIT : W_HIT;
  for (const [k, n] of Object.entries(s.hits || {})) {
    if (paths.some(pp => under(k, pp) || under(pp, k) && k.split('/').length >= pp.split('/').length - 1)) sc += w * n;
  }
  if (isHub) sc += W_CWD;
  const ph = phrases(p);
  if (ph.length) {
    for (const t of [s.title, ...(s.prompts_sample || [])]) {
      if (!t) continue;
      const nt = norm(t);
      if (ph.some(x => nt.includes(x))) sc += W_NAME;
    }
  }
  return sc;
}

// Evidência "de ninguém": pastas de PROJETOS/ tocadas que não pertencem a nenhum projeto cadastrado.
// Se ela pesa mais que o vencedor, a sessão é de um projeto que não está na Bancada → sem projeto (não chuta o vizinho).
function unclaimed(s, projects) {
  const all = projects.filter(p => !p.system && !p.deleted).flatMap(p => p.paths || []);
  let n = 0;
  for (const [k, c] of Object.entries(s.hits || {})) {
    if (!k.includes('/PROJETOS/')) continue;
    if (!all.some(pp => under(k, pp) || under(pp, k))) n += c;
  }
  return n * W_HIT;
}

function classify(s, projects) {
  let best = null, bestScore = 0, tie = false;
  for (const p of projects) {
    if (p.system || p.deleted) continue;
    const sc = score(s, p);
    if (sc > bestScore) { best = p.id; bestScore = sc; tie = false; }
    else if (sc === bestScore && sc > 0) tie = true;
  }
  if (bestScore < MIN_SCORE || tie) return null;
  return unclaimed(s, projects) > bestScore ? null : best;
}

module.exports = { classify, score, unclaimed };
