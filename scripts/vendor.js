// Copia os arquivos do xterm e os tokens Aurora para app/renderer/vendor (a página só carrega arquivos da própria pasta).
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'app', 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = {
  'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
  'addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
  'addon-unicode11.js': 'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js',
};
for (const [dst, src] of Object.entries(files)) fs.copyFileSync(path.join(root, src), path.join(out, dst));
// v0.6: Three.js (módulo ES) para o Escritório 3D. O OrbitControls importa de 'three'; reescrito para caminho relativo
// (sem import map: a CSP script-src 'self' continua igual).
fs.mkdirSync(path.join(out, 'three'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/three/build/three.module.js'), path.join(out, 'three', 'three.module.js'));
fs.copyFileSync(path.join(root, 'node_modules/three/build/three.core.js'), path.join(out, 'three', 'three.core.js'));
const oc = fs.readFileSync(path.join(root, 'node_modules/three/examples/jsm/controls/OrbitControls.js'), 'utf8');
if (!/from 'three';/.test(oc)) throw new Error('OrbitControls mudou de formato: conferir o import');
fs.writeFileSync(path.join(out, 'three', 'OrbitControls.js'), oc.replace(/from 'three';/g, "from './three.module.js';"));
fs.copyFileSync(path.join(root, 'node_modules/three/LICENSE'), path.join(out, 'three', 'LICENSE'));
// BANCADA_AURORA_CSS: caminho do aurora-tokens.css quando o design system não está na pasta vizinha (ex.: build do Windows)
const aurora = process.env.BANCADA_AURORA_CSS || path.join(root, '..', 'mcpp-design-system', 'aurora-tokens.css');
if (fs.existsSync(aurora)) fs.copyFileSync(aurora, path.join(out, 'aurora-tokens.css'));
console.log('vendor ok:', fs.readdirSync(out).join(', '));
