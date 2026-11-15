'use strict';
// O Escritório 3D roda no navegador (módulo ES); aqui conferimos as regras que não dependem de WebGL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const R = path.join(__dirname, '..', '..', 'app', 'renderer');
const src = fs.readFileSync(path.join(R, 'office3d.js'), 'utf8');

test('T6.4: o Escritório não chama IA nem rede — só importa o three.js local', () => {
  const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./vendor/three/three.module.js', './vendor/three/OrbitControls.js']);
  for (const bad of [/fetch\(/, /XMLHttpRequest/, /WebSocket/, /anthropic|openai|claude-|summariz/i, /eval\(/, /new Function/, /innerHTML/])
    assert.doesNotMatch(src, bad, String(bad));
  const ui = fs.readFileSync(path.join(R, 'activity-ui.js'), 'utf8');
  assert.doesNotMatch(ui, /fetch\(|anthropic|openai|summariz/i);
});

test('CSP igual (script-src self) e o 3D entra como módulo da própria pasta', () => {
  const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
  assert.match(html, /script-src 'self';/);
  assert.match(html, /<script type="module" src="office3d.js"><\/script>/);
  assert.doesNotMatch(html, /importmap/);
});

test('laço sob demanda com teto: 30 quadros/s, pausa escondido, libera tudo no unmount', () => {
  assert.match(src, /const FPS_MS = 1000 \/ 30;/);
  assert.match(src, /document\.hidden \|\| !S\.stage\.offsetParent/);
  assert.match(src, /renderer\.dispose\(\)/);
  assert.match(src, /for \(const o of s\.owned\) \{ try \{ o\.dispose\(\); \} catch \{\} \}/);
  assert.match(src, /const MAX_ACTORS = 40;/);
});

test('vendor: OrbitControls aponta para o three local (sem import "three" solto)', () => {
  const oc = path.join(R, 'vendor', 'three', 'OrbitControls.js');
  if (!fs.existsSync(oc)) return;   // vendor é gerado (npm start/dist)
  assert.doesNotMatch(fs.readFileSync(oc, 'utf8'), /from 'three'/);
});
