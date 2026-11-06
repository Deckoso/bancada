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
const aurora = path.join(root, '..', 'mcpp-design-system', 'aurora-tokens.css');
if (fs.existsSync(aurora)) fs.copyFileSync(aurora, path.join(out, 'aurora-tokens.css'));
console.log('vendor ok:', fs.readdirSync(out).join(', '));
