'use strict';
// Prova do atualizador do MAC com o build DE VERDADE (dist-mac/, assinado com a identidade estável) e as ferramentas de
// verdade (ditto, codesign, plutil, o script de troca em sh) — sem publicar nada e sem rede: a "Release" é a pasta
// dist-mac servida por um transporte injetado, com os redirecionamentos do GitHub.
// Uso (depois do npm run dist:mac):  ELECTRON_RUN_AS_NODE=1 <Electron> test/e2e/updater-mac-e2e.js   (ou node)
// Cenários: instalada "0.7.9" com a mesma identidade → baixa, confere, prepara, troca (script real, PID já encerrado)
// e o app no lugar passa no codesign · instalada com assinatura local (ad-hoc) → "baixe pelo site" sem baixar.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const U = require('../../app/main/updater');

const root = path.join(__dirname, '..', '..');
const VER = require('../../package.json').version;
const D = path.join(root, 'dist-mac');
const zipName = `Bancada-${VER}-universal-mac.zip`;
if (!fs.existsSync(path.join(D, zipName))) { console.error(`falta dist-mac/${zipName} (npm run dist:mac)`); process.exit(1); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'atualiza-mac-'));
// manifesto assinado com uma chave de TESTE gerada aqui (a de verdade só assina no release:pack)
const crypto = require('crypto');
const KEY = crypto.generateKeyPairSync('ed25519');
const PUB = KEY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const SIG = path.join(W, 'latest-mac.yml.sig');
fs.writeFileSync(SIG, crypto.sign(null, U.manifestMessage('latest-mac.yml', fs.readFileSync(path.join(D, 'latest-mac.yml'))), KEY.privateKey).toString('base64'));
const seen = [];
const transport = async (url) => {
  seen.push(url);
  const routes = {
    [`${U.BASE}/latest/download/latest-mac.yml`]: { redirect: `${U.BASE}/download/v${VER}/latest-mac.yml` },
    [`${U.BASE}/download/v${VER}/latest-mac.yml`]: { redirect: 'https://release-assets.githubusercontent.com/x/latest-mac.yml' },
    'https://release-assets.githubusercontent.com/x/latest-mac.yml': { file: path.join(D, 'latest-mac.yml') },
    [`${U.BASE}/download/v${VER}/latest-mac.yml.sig`]: { file: SIG },
    [`${U.BASE}/download/v${VER}/${zipName}`]: { redirect: 'https://release-assets.githubusercontent.com/x/zip' },
    'https://release-assets.githubusercontent.com/x/zip': { file: path.join(D, zipName) },
  };
  const r = routes[url];
  if (!r) return { status: 404, headers: {}, body: Readable.from([]) };
  if (r.redirect) return { status: 302, headers: { location: r.redirect }, body: Readable.from([]) };
  return { status: 200, headers: {}, body: fs.createReadStream(r.file) };
};
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const dr = (app) => execFileSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).match(/designated => (.+)/)[1];

(async () => {
  const out = [];
  try {
    // instalada: o próprio build extraído, fingindo ser 0.7.9 (o atualizador lê a versão instalada pelo app.getVersion)
    const apps = path.join(W, 'Aplicativos'); fs.mkdirSync(apps);
    sh('/usr/bin/ditto', ['-x', '-k', path.join(D, zipName), apps]);
    const installed = path.join(apps, 'Bancada.app');
    const before = fs.statSync(path.join(installed, 'Contents', 'Info.plist')).ino;
    const mu = new U.MacUpdater({ dir: path.join(W, 'dados', 'atualizacao'), app: installed, currentVersion: '0.7.9', transport, spawnSwap: () => {}, publicKey: PUB });
    const t0 = Date.now();
    const r = await mu.check();
    out.push(`nova válida: ${r.state} ${r.version} em ${Math.round((Date.now() - t0) / 1000)} s · DR ${mu.ready.dr.slice(0, 60)}…`);
    if (r.state !== 'ready') throw new Error('não ficou pronta');
    // troca real: script gerado, PID que já não existe, sem reabrir
    mu.spawnSwap = (script) => sh('/bin/sh', [script]);
    const fakePid = 999999;
    mu.scheduleSwap(fakePid, { reopen: false });
    const log = fs.readFileSync(path.join(W, 'dados', 'atualizacao', 'troca.log'), 'utf8');
    sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    const after = fs.statSync(path.join(installed, 'Contents', 'Info.plist')).ino;
    const backup = fs.existsSync(path.join(W, 'dados', 'atualizacao', 'anterior', 'Bancada.app'));
    out.push(`troca: ${/trocada/.test(log) ? 'trocada' : 'FALHOU'} · app novo no lugar (${before !== after}) · antigo guardado (${backup}) · codesign ok · staging vazio (${!fs.existsSync(path.join(W, 'dados', 'atualizacao', 'nova', 'Bancada.app'))})`);
    if (!/trocada/.test(log) || before === after || !backup) throw new Error('troca não aconteceu: ' + log);

    // instalada com assinatura local (ad-hoc): não serve de referência → recusa sem baixar o zip
    const adhoc = path.join(W, 'adhoc'); fs.mkdirSync(adhoc);
    sh('/usr/bin/ditto', [installed, path.join(adhoc, 'Bancada.app')]);
    sh('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.join(adhoc, 'Bancada.app')]);
    seen.length = 0;
    const mu2 = new U.MacUpdater({ dir: path.join(W, 'dados2'), app: path.join(adhoc, 'Bancada.app'), currentVersion: '0.7.9', transport, publicKey: PUB });
    try { await mu2.check(); throw new Error('aceitou instalada ad-hoc'); } catch (e) { if (e.code !== 'MANUAL') throw e; out.push(`instalada ad-hoc (${dr(path.join(adhoc, 'Bancada.app')).slice(0, 18)}…): recusada — "${e.message}" · zip pedido: ${seen.some(u => /\.zip|\/zip$/.test(u))}`); }
    console.log(out.map(l => `OK  ${l}`).join('\n'));
    process.exitCode = 0;
  } catch (e) {
    console.log(out.map(l => `OK  ${l}`).join('\n')); console.error(`FALHOU: ${e.message}`); process.exitCode = 1;
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
})();
