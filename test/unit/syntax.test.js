'use strict';
// Todo script da tela precisa compilar: um erro de sintaxe num arquivo do renderer deixa a janela inteira morta
// (0.7.0 no Windows abriu "travada" por duas aspas trocadas no app.js — nenhum teste carregava os scripts da tela).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const dir = path.join(__dirname, '../../app/renderer');

test('scripts da tela compilam (os comuns como script, o office3d como módulo)', () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 10, 'achou os scripts');
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/^\s*import\s|^\s*export\s/m.test(src)) {
      if (typeof vm.SourceTextModule === 'function') new vm.SourceTextModule(src, { identifier: f });
      else assert.doesNotThrow(() => new Function(src.replace(/^\s*(import|export)\b.*$/gm, '')), f);
    } else assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
  }
});
