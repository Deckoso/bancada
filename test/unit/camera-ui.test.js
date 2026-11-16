'use strict';
// Câmera (E7): no celular o 📷 abre câmera/galeria só JPG/PNG, reduz no aparelho (≤ 2560, JPEG 0,85) e manda pelo
// attach:image existente uma vez por toque, sem URL de objeto; no computador o 📷 é o recorte de tela.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../app/renderer/camera-ui.js'), 'utf8');

test('celular: entrada de foto restrita, câmera traseira, redução no aparelho, sem objectURL nem laço', () => {
  assert.match(src, /accept: 'image\/jpeg,image\/png', capture: 'environment'/);
  assert.match(src, /const MAX_SIDE = 2560;/); assert.match(src, /toDataURL\('image\/jpeg', 0\.85\)/);
  assert.match(src, /B\.attach\.image\(id, \{ name: 'foto\.jpg', b64:/, 'usa o canal que já existe');
  assert.doesNotMatch(src, /createObjectURL/, 'nenhuma URL de objeto (nada a revogar)');
  assert.match(src, /if \(sending\) return;/, 'um envio por vez');
  assert.match(src, /c\.width = c\.height = 0;/, 'canvas liberado');
  assert.match(src, /Foto enviada para o terminal/);
});

test('computador: recorte pelo canal shot:* (caminho nunca vem da página) e atalho pelo helper', () => {
  assert.match(src, /B\.shot\.screen\(term\)/); assert.match(src, /B\.shot\.send\(r\.token\)/);
  assert.match(src, /T\.shotKey/);
  const remote = fs.readFileSync(path.join(__dirname, '../../app/main/remote.js'), 'utf8');
  assert.match(remote, /'\/camera-ui\.js': 'camera-ui\.js'/);
});

test('prévia antes de colar: Enviar/Cancelar; fechar sem enviar cancela (recorte apagado); um envio só', () => {
  assert.match(src, /title: 'Mandar este recorte\?'/); assert.match(src, /title: 'Mandar esta foto\?'/);
  assert.match(src, /onClose: \(\) => \{ if \(!sent && onCancel\) onCancel\(\); \}/);
  assert.match(src, /B\.shot\.cancel\(r\.token\)/);
  assert.match(src, /if \(sent\) return; sent = true; go\.disabled = true;/);
  assert.match(src, /T\.screenHelp/);
});
