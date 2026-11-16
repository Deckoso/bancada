'use strict';
// Primeira abertura numa casa limpa: a tela não sugere a pasta-motor de ninguém (athena-os) nem nomes pessoais,
// o motor começa em "Nenhum" e o resumo por IA começa desligado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, '../../app/renderer');

// só código: tira comentários (de linha, de bloco e de HTML)
function code(file) {
  return fs.readFileSync(path.join(dir, file), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}
const files = fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f));

test('nenhum texto da tela cita "athena" nem pasta/servidor pessoal', () => {
  for (const f of files) {
    const c = code(f);
    assert.doesNotMatch(c, /athena/i, `${f}: "athena" na tela`);
    assert.doesNotMatch(c, /PROJETOS\b/, `${f}: nome de pasta interna na tela`);
  }
});

test('boas-vindas: motor "Nenhum" marcado, nenhum motor pré-escolhido pelo nome, resumo por IA desmarcado', () => {
  const app = code('app.js');
  assert.match(app, /h\('option', \{ value: '', text: 'Nenhum[^']*', selected: true \}\)/);
  assert.doesNotMatch(app, /sugg\.findIndex/, 'motor pré-marcado pelo nome');
  assert.match(app, /const sumOn = h\('input', \{ type: 'checkbox' \}\)/, 'resumo por IA começa desmarcado');
  assert.match(app, /ai_summary: sumOn\.checked/);
  // PromptPad só quando existe
  assert.match(app, /const ppOn = !!\(S\.settings && S\.settings\.promptpad_available\)/);
});
