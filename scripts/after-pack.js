// Gancho afterPack do electron-builder (Mac): o spawn-helper do node-pty precisa de permissão de execução, senão o
// terminal não abre ("posix_spawnp failed"). O npm não marca +x nos prebuilds; aqui marca dentro do app empacotado
// (as duas arquiteturas) e confere. No Windows não faz nada.
'use strict';
const fs = require('fs');
const path = require('path');

function fixSpawnHelpers(appDir) {
  const base = path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
  const found = [];
  for (const sub of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
    const f = path.join(base, sub, 'spawn-helper');
    if (!fs.existsSync(f)) continue;
    fs.chmodSync(f, 0o755);
    if (!(fs.statSync(f).mode & 0o111)) throw new Error(`spawn-helper sem permissão de execução: ${f}`);
    found.push(sub);
  }
  return found;
}

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const found = fixSpawnHelpers(app);
  if (!found.length) throw new Error('spawn-helper do node-pty não encontrado no app empacotado');
  console.log(`  • spawn-helper +x (${found.join(', ')})`);
};
exports.fixSpawnHelpers = fixSpawnHelpers;
