// Gera o instalador da Bancada para Windows (x64) a partir do Mac ou do próprio Windows.
// Uso: npm run dist:win  →  dist-win/Bancada-Setup-<versão>-windows-x64.exe
// Os módulos nativos (terminal e banco) já vêm compilados para Windows dentro dos pacotes (node-pty e better-sqlite3
// trazem "prebuilds"), então não precisa de compilador nem de Windows para montar.
// Sem certificado de código: o Windows mostra "O Windows protegeu o computador" no 1º uso → "Mais informações" →
// "Executar assim mesmo" (passo a passo em docs/WINDOWS.md). Nada pessoal vai junto: dados ficam em %APPDATA%\Bancada.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

for (const f of ['node_modules/node-pty/prebuilds/win32-x64/pty.node', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'node_modules/better-sqlite3/prebuilds/win32-x64.node']) {
  if (!fs.existsSync(path.join(root, f))) { console.error(`falta ${f} (rode npm install)`); process.exit(1); }
}
run(process.execPath, ['scripts/vendor.js']);
if (!fs.existsSync(path.join(root, 'app/renderer/vendor/aurora-tokens.css'))) { console.error('falta app/renderer/vendor/aurora-tokens.css (defina BANCADA_AURORA_CSS)'); process.exit(1); }
fs.rmSync(path.join(root, 'dist-win'), { recursive: true, force: true });
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// sem assinatura de código (não temos certificado): CSC_IDENTITY_AUTO_DISCOVERY=false evita procurar um no Mac
run(npx, ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never', '-c.directories.output=dist-win'], { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
const out = fs.readdirSync(path.join(root, 'dist-win')).filter(f => f.endsWith('.exe'));
console.log('Pronto:', out.map(f => `dist-win/${f} (${Math.round(fs.statSync(path.join(root, 'dist-win', f)).size / 1048576)} MB)`).join(', '));
