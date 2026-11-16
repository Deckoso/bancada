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
// motor de voz: arquivos do whisper.cpp oficial, zip com SHA-256 fixo (scripts/fetch-whisper-win.js, build/whisper/README.md)
run(process.execPath, ['scripts/fetch-whisper-win.js']);
fs.rmSync(path.join(root, 'dist-win'), { recursive: true, force: true });
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// sem assinatura de código (não temos certificado): CSC_IDENTITY_AUTO_DISCOVERY=false evita procurar um no Mac
run(npx, ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never', '-c.directories.output=dist-win'], { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
if (!fs.existsSync(path.join(root, 'dist-win', 'win-unpacked', 'resources', 'whisper', 'whisper-cli.exe'))) { console.error('o motor de voz não entrou no pacote (resources/whisper)'); process.exit(1); }
// o que sobe para a Release: .exe + .blockmap + latest.yml (o electron-updater lê o latest.yml e confere o SHA-512).
// Arquivos de depuração do builder (builder-debug.yml, builder-effective-config.yaml) têm caminhos locais: fora.
const D = path.join(root, 'dist-win');
for (const f of fs.readdirSync(D)) if (f === 'builder-debug.yml' || /\.yaml$/.test(f)) fs.rmSync(path.join(D, f), { force: true });
const exe = `Bancada-Setup-${require('../package.json').version}-windows-x64.exe`;
for (const f of [exe, `${exe}.blockmap`, 'latest.yml']) if (!fs.existsSync(path.join(D, f))) { console.error(`faltou dist-win/${f}`); process.exit(1); }
const yml = fs.readFileSync(path.join(D, 'latest.yml'), 'utf8');
const sha512 = require('crypto').createHash('sha512').update(fs.readFileSync(path.join(D, exe))).digest('base64');
if (!yml.includes(`sha512: ${sha512}`)) { console.error('latest.yml não confere com o .exe'); process.exit(1); }
const sha256 = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(D, f))).digest('hex');
fs.writeFileSync(path.join(D, 'SHA256SUMS.txt'), [exe, `${exe}.blockmap`, 'latest.yml'].map(f => `${sha256(f)}  ${f}`).join('\n') + '\n');
console.log(`Pronto: dist-win/${exe} (${Math.round(fs.statSync(path.join(D, exe)).size / 1048576)} MB) + .blockmap + latest.yml (SHA-512 conferido) + SHA256SUMS.txt`);
