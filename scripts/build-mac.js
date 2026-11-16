// Gera a Bancada para Mac UNIVERSAL (Apple e Intel) para passar a outras pessoas e para o atualizador.
// Uso: npm run dist:mac  →  dist-mac/Bancada-<versão>-universal-mac.zip + .dmg + latest-mac.yml + SHA256SUMS.txt
// O que o build universal precisa (provado no spike de 16/11):
//  1. x64ArchFiles: os módulos nativos (.node e spawn-helper) não são fundidos — vão os dois, um por arquitetura
//  2. spawn-helper com +x (scripts/after-pack.js)
//  3. node-pty/build/** FORA do pacote (é o compilado local, só da arquitetura deste Mac; o node-pty o procura antes dos
//     prebuilds e quebraria no Intel)
// Assinatura: o electron-builder sai sem selo; aqui assina uma cópia limpa. Se existir a identidade estável deste Mac
// (~/.config/bancada-assinatura/with-kc.sh + bancada.p12, ver LEIA.txt lá), assina com ela ("Bancada Local": as
// permissões de microfone/tela não somem a cada versão); senão, assinatura local (ad-hoc). Nada dessa pasta vem para o
// repositório nem para o pacote: o certificado entra num chaveiro temporário que é apagado no fim.
// O npm run dist (só Apple, usado pelo install-app/update-app) continua igual.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'dist-mac');
const SIGN_DIR = path.join(os.homedir(), '.config', 'bancada-assinatura');
const IDENTITY = 'Bancada Local';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts, env: { ...process.env, ...(opts.env || {}) } });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const die = (m) => { console.error(m); process.exit(1); };

if (process.platform !== 'darwin') die('o build do Mac só roda num Mac (codesign, lipo, hdiutil)');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const VER = pkg.version;

// ---------- 1. pré-requisitos ----------
for (const f of ['node-pty/prebuilds/darwin-arm64/pty.node', 'node-pty/prebuilds/darwin-x64/pty.node', 'node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node-pty/prebuilds/darwin-x64/spawn-helper', 'better-sqlite3/prebuilds/darwin-arm64.node', 'better-sqlite3/prebuilds/darwin-x64.node']) {
  if (!fs.existsSync(path.join(root, 'node_modules', f))) die(`falta node_modules/${f} (rode npm install)`);
}
run(process.execPath, ['scripts/vendor.js'], { stdio: 'ignore' });
// trava do visual: sem os tokens Aurora a Bancada abre "pelada" na casa de quem recebe
if (!fs.existsSync(path.join(root, 'app/renderer/vendor/aurora-tokens.css'))) die('falta app/renderer/vendor/aurora-tokens.css (defina BANCADA_AURORA_CSS)');
for (const a of ['darwin-arm64', 'darwin-x64']) fs.chmodSync(path.join(root, 'node_modules/node-pty/prebuilds', a, 'spawn-helper'), 0o755);
// motor de voz embutido: compilado aqui da fonte oficial (tag fixa, SHA-256 conferido) — scripts/build-whisper-mac.js
run(process.execPath, ['scripts/build-whisper-mac.js']);
const WHISPER = path.join(root, 'build/whisper/mac/whisper-cli');
if (!fs.existsSync(WHISPER)) die('falta build/whisper/mac/whisper-cli (npm run whisper:mac; ver build/whisper/README.md)');
fs.chmodSync(WHISPER, 0o755);

// ---------- 2. electron-builder (universal, só a pasta .app; zip e dmg saem depois de assinar) ----------
const cfg = JSON.parse(JSON.stringify(pkg.build));
cfg.mac = { ...cfg.mac, target: ['dir'],
  files: [...cfg.files, '!node_modules/node-pty/build/**', '!node_modules/node-pty/prebuilds/win32-*/**', '!node_modules/node-pty/third_party/**',
    '!node_modules/better-sqlite3/prebuilds/{win32,linux,linuxmusl}-*', '!node_modules/better-sqlite3/lib/{win32,linux,linuxmusl}-*.js'] };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-mac-'));
const cfgFile = path.join(tmp, 'builder.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg));
fs.rmSync(OUT, { recursive: true, force: true });
const t0 = Date.now();
run('npx', ['electron-builder', '--mac', 'dir', '--universal', '--publish', 'never', '--config', cfgFile, '-c.directories.output=dist-mac'], { env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
const built = path.join(OUT, 'mac-universal', 'Bancada.app');
if (!fs.existsSync(built)) die('o electron-builder não gerou dist-mac/mac-universal/Bancada.app');

// ---------- 3. conferência das arquiteturas ----------
const R = 'Contents/Resources/app.asar.unpacked/node_modules';
const expect = {
  'Contents/MacOS/Bancada': 'x86_64 arm64', 'Contents/Frameworks/Electron Framework.framework/Electron Framework': 'x86_64 arm64',
  [`${R}/better-sqlite3/prebuilds/darwin-arm64.node`]: 'arm64', [`${R}/better-sqlite3/prebuilds/darwin-x64.node`]: 'x86_64',
  [`${R}/node-pty/prebuilds/darwin-arm64/pty.node`]: 'arm64', [`${R}/node-pty/prebuilds/darwin-x64/pty.node`]: 'x86_64',
  [`${R}/node-pty/prebuilds/darwin-arm64/spawn-helper`]: 'arm64', [`${R}/node-pty/prebuilds/darwin-x64/spawn-helper`]: 'x86_64',
  // motor de voz (build/whisper/README.md): um binário universal só
  'Contents/Resources/whisper/whisper-cli': 'x86_64 arm64',
};
for (const [f, archs] of Object.entries(expect)) {
  const got = out('lipo', ['-archs', path.join(built, f)]).split(/\s+/).sort().join(' ');
  if (got !== archs.split(' ').sort().join(' ')) die(`${f}: esperado ${archs}, veio ${got}`);
}
for (const a of ['darwin-arm64', 'darwin-x64']) if (!(fs.statSync(path.join(built, R, 'node-pty/prebuilds', a, 'spawn-helper')).mode & 0o111)) die(`spawn-helper ${a} sem +x`);
if (fs.existsSync(path.join(built, R, 'node-pty/build'))) die('node-pty/build entrou no pacote (quebraria no Intel)');
console.log('  • arquiteturas conferidas (lipo -archs): app e framework universais; módulos nativos um por arquitetura');

// ---------- 4. assinatura numa cópia limpa (fora de Documentos/iCloud) ----------
const stage = path.join(tmp, 'stage'); fs.mkdirSync(stage);
const app = path.join(stage, 'Bancada.app');
run('ditto', ['--norsrc', '--noextattr', '--noqtn', built, app]);
run('xattr', ['-cr', app]);
const withKc = path.join(SIGN_DIR, 'with-kc.sh'); const p12 = path.join(SIGN_DIR, 'bancada.p12'); const p12pass = path.join(SIGN_DIR, 'p12-senha.txt');
let signedWith = 'ad-hoc';
if (fs.existsSync(withKc) && fs.existsSync(p12) && fs.existsSync(p12pass)) {
  const kc = path.join(tmp, 'assinatura.keychain-db');
  const kcPass = crypto.randomBytes(24).toString('hex');
  const pass = fs.readFileSync(p12pass, 'utf8').trim();
  const quiet = { stdio: ['ignore', 'ignore', 'inherit'] };
  try {
    run('security', ['create-keychain', '-p', kcPass, kc], quiet);
    run('security', ['set-keychain-settings', '-lut', '600', kc], quiet);
    run('security', ['unlock-keychain', '-p', kcPass, kc], quiet);
    run('security', ['import', p12, '-k', kc, '-P', pass, '-T', '/usr/bin/codesign'], quiet);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kcPass, kc], quiet);
    // de dentro para fora: o motor de voz (Mach-O solto em Resources) primeiro, depois o app
    run('/bin/bash', [withKc, kc, 'codesign', '--force', '--keychain', kc, '--sign', IDENTITY, path.join(app, 'Contents/Resources/whisper/whisper-cli')]);
    run('/bin/bash', [withKc, kc, 'codesign', '--force', '--deep', '--keychain', kc, '--sign', IDENTITY, app]);
    signedWith = IDENTITY;
  } finally {
    try { execFileSync('security', ['delete-keychain', kc], { stdio: 'ignore' }); } catch {}
  }
} else {
  run('codesign', ['--force', '--sign', '-', path.join(app, 'Contents/Resources/whisper/whisper-cli')]);
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
}
run('codesign', ['--verify', '--deep', '--strict', app]);
run('codesign', ['--verify', '--strict', path.join(app, 'Contents/Resources/whisper/whisper-cli')]);
console.log(`  • assinado: ${signedWith}`);

// ---------- 5. zip, dmg, latest-mac.yml e SHA-256 (todos depois de assinar) ----------
fs.rmSync(path.join(OUT, 'mac-universal'), { recursive: true, force: true });
for (const f of fs.readdirSync(OUT)) if (/\.(blockmap|yml|yaml)$/.test(f) || f === 'builder-debug.yml') fs.rmSync(path.join(OUT, f), { force: true });
const zipName = `Bancada-${VER}-universal-mac.zip`; const dmgName = `Bancada-${VER}-universal-mac.dmg`;
run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', app, path.join(OUT, zipName)]);
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
run('hdiutil', ['create', '-volname', `Bancada ${VER}`, '-srcfolder', stage, '-ov', '-format', 'UDZO', '-quiet', path.join(OUT, dmgName)]);
const hash = (f, alg, enc) => crypto.createHash(alg).update(fs.readFileSync(path.join(OUT, f))).digest(enc);
const files = [zipName, dmgName].map(f => ({ url: f, sha512: hash(f, 'sha512', 'base64'), size: fs.statSync(path.join(OUT, f)).size }));
fs.writeFileSync(path.join(OUT, 'latest-mac.yml'), [`version: ${VER}`, 'files:',
  ...files.flatMap(f => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
  `path: ${zipName}`, `sha512: ${files[0].sha512}`, `releaseDate: '${new Date().toISOString()}'`, ''].join('\n'));
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), [zipName, dmgName].map(f => `${hash(f, 'sha256', 'hex')}  ${f}`).join('\n') + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
const mb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1048576);
console.log(`Pronto em ${Math.round((Date.now() - t0) / 1000)} s: dist-mac/${zipName} (${mb(zipName)} MB), dist-mac/${dmgName} (${mb(dmgName)} MB), latest-mac.yml, SHA256SUMS.txt`);
