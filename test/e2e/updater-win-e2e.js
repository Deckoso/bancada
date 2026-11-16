'use strict';
// Prova do atualizador do WINDOWS com o electron-updater DE VERDADE (NsisUpdater + provedor GitHub), sem publicar nada
// e sem rede: a "internet" é um protocol.handle('https') na sessão do próprio atualizador, que serve uma Release de
// mentira (releases.atom, releases/latest, latest.yml, .exe). Nenhuma porta aberta; nada sai do Mac.
// Roda no Mac (só baixa e confere — a instalação do NSIS nunca é chamada):
//   "<Electron>" test/e2e/updater-win-e2e.js   → imprime e grava o resultado de cada cenário; código de saída 0 = tudo ok
// Cenários: nova válida (manifesto assinado) → baixada e conferida · .exe adulterado → recusado (SHA-512) · versão
// menor → nada · redirecionamento para host fora da lista → recusado pelo filtro · sem .sig / .sig de outra chave →
// recusado antes de o electron-updater ser chamado. O manifesto é assinado com uma chave de TESTE gerada aqui.
const { app, session, protocol } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const U = require('../../app/main/updater');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atualiza-win-'));
app.setPath('userData', path.join(ROOT, 'electron'));
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('base64');
const EXE = Buffer.from(`MZ Bancada-Setup-0.8.1 de mentira ${'x'.repeat(200000)}`);
const G = 'https://github.com/Deckoso/bancada/releases';
const KEY = crypto.generateKeyPairSync('ed25519'); const OTHER = crypto.generateKeyPairSync('ed25519');
const PUB = KEY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const { Readable } = require('stream');

function releaseRoutes({ ver, exe, ymlSha = sha512(exe), exeRedirect = null, sig = 'ok' }) {
  const name = `Bancada-Setup-${ver}-windows-x64.exe`;
  const yml = `version: ${ver}\nfiles:\n  - url: ${name}\n    sha512: ${ymlSha}\n    size: ${exe.length}\npath: ${name}\nsha512: ${ymlSha}\nreleaseDate: '2026-11-16T12:00:00.000Z'\n`;
  const atom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Repository/1/v${ver}</id><link rel="alternate" type="text/html" href="https://github.com/Deckoso/bancada/releases/tag/v${ver}"/><title>${ver}</title></entry></feed>`;
  const r = new Map([
    [`${G}.atom`, { body: atom, type: 'application/atom+xml' }],
    [`${G}/latest`, { body: JSON.stringify({ tag_name: `v${ver}` }), type: 'application/json' }],
    [`${G}/download/v${ver}/latest.yml`, { redirect: 'https://release-assets.githubusercontent.com/a/latest.yml' }],
    ['https://release-assets.githubusercontent.com/a/latest.yml', { body: yml, type: 'text/yaml' }],
    // rodando no Mac, o electron-updater pede o canal do Mac (latest-mac.yml): mesmo conteúdo do latest.yml do Windows
    [`${G}/download/v${ver}/latest-mac.yml`, { redirect: 'https://release-assets.githubusercontent.com/a/latest.yml' }],
    [`${G}/latest/download/latest.yml`, { redirect: `${G}/download/v${ver}/latest.yml` }],
    [`${G}/download/v${ver}/${name}`, { redirect: exeRedirect || 'https://objects.githubusercontent.com/a/setup.exe' }],
    ['https://objects.githubusercontent.com/a/setup.exe', { body: exe, type: 'application/octet-stream' }],
  ]);
  if (sig !== 'none') r.set(`${G}/download/v${ver}/latest.yml.sig`, { body: crypto.sign(null, U.manifestMessage('latest.yml', Buffer.from(yml)), (sig === 'other' ? OTHER : KEY).privateKey).toString('base64') + '\n', type: 'text/plain' });
  return r;
}
// o nosso fetch do manifesto (Node https em produção) lê a mesma "internet" de mentira
async function transport(url) {
  seen.push(url);
  const r = routes.get(url);
  if (!r) return { status: 404, headers: {}, body: Readable.from([]) };
  if (r.redirect) return { status: 302, headers: { location: r.redirect }, body: Readable.from([]) };
  return { status: 200, headers: {}, body: Readable.from([Buffer.from(r.body)]) };
}

function adapter(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'app-update.yml');
  fs.writeFileSync(cfg, 'provider: github\nowner: Deckoso\nrepo: bancada\nupdaterCacheDirName: bancada-updater\n');
  return { version: '0.8.0', name: 'Bancada', isPackaged: true, appUpdateConfigPath: cfg, userDataPath: path.join(dir, 'dados'), baseCachePath: path.join(dir, 'cache'),
    whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {} };
}

let routes = new Map(); const seen = [];
async function scenario(name, routeMap, until) {
  routes = routeMap; seen.length = 0;
  const dir = path.join(ROOT, name);
  const au = new NsisUpdater(undefined, adapter(dir));
  // com adaptador próprio (versão 0.8.0) o electron-updater não cria o executor HTTP: o mesmo de produção
  au.httpExecutor = new ElectronHttpExecutor((authInfo, cb) => au.emit('login', authInfo, cb));
  const states = []; const lines = [];
  const log = { info: (o, m) => lines.push(`info ${m}`), warn: (o, m) => lines.push(`warn ${m}`), error: (o, m) => lines.push(`error ${m}`) };
  au.quitAndInstall = () => { throw new Error('quitAndInstall chamado'); };
  au.checksCalled = 0; const realCheck = au.checkForUpdates.bind(au); au.checkForUpdates = (...a) => { au.checksCalled++; return realCheck(...a); };
  // pela fachada de produção (configureWin + check), como o index.js faz no Windows
  const kv = new Map();
  const up = new U.Updater({ platform: 'win32', kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d), set: (k, v) => kv.set(k, v) }, currentVersion: '0.8.0', packaged: true,
    log, makeWin: () => au, onChange: (s) => states.push(s), transport, publicKey: PUB });
  const done = new Promise((resolve) => {
    const t = setTimeout(() => resolve('tempo'), 20000);
    for (const ev of ['update-downloaded', 'update-not-available', 'error']) au.once(ev, (x) => { clearTimeout(t); setTimeout(() => resolve(ev), 300); });
    // recusado antes do electron-updater (assinatura, versão menor): a própria checagem termina
    up.check({ manual: true }).then((st) => { if (au.checksCalled === 0 && ['none', 'error'].includes(st.state)) { clearTimeout(t); resolve(`fachada:${st.state}`); } });
  });
  const ev = await done;
  await new Promise(r => setTimeout(r, 300));   // a conferência do arquivo baixado é assíncrona
  const cached = path.join(dir, 'cache', 'bancada-updater', 'pending');
  let file = null; try { file = fs.readdirSync(cached).find(f => f.endsWith('.exe')) || null; } catch {}
  const body = file ? fs.readFileSync(path.join(cached, file)) : null;
  const final = up.status(); up.stop();
  return { name, ev, final: final.state + (final.version ? ` ${final.version}` : ''), states: states.map(s => s.state + (s.version ? ` ${s.version}` : '') + (s.refused ? ` (${s.refused})` : '')), seen: [...seen], pendingExe: file,
    pendingIsGood: body ? body.equals(EXE) : null, errors: lines.filter(l => /^(error|warn)/.test(l)).map(l => l.slice(0, 200)), ok: until({ ev, file, body, seen, states, errs: lines, fin: final.state }) };
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('electron-updater', { cache: false });
  // a "internet" de mentira: só esta sessão; qualquer outra URL dá 404
  ses.protocol.handle('https', async (req) => {
    seen.push(req.url);
    const r = routes.get(req.url);
    if (!r) return new Response('não existe', { status: 404 });
    if (r.redirect) return new Response(null, { status: 302, headers: { location: r.redirect } });
    return new Response(r.body, { status: 200, headers: { 'content-type': r.type, 'content-length': String(Buffer.byteLength(r.body)) } });
  });
  const bad = Buffer.from(EXE); bad[100] ^= 1;
  const results = [];
  results.push(await scenario('nova-valida', releaseRoutes({ ver: '0.8.1', exe: EXE }), ({ ev, body, fin }) => ev === 'update-downloaded' && !!body && body.equals(EXE) && fin === 'ready'));
  results.push(await scenario('exe-adulterado', releaseRoutes({ ver: '0.8.1', exe: bad, ymlSha: sha512(EXE) }), ({ ev, file, errs }) => ev === 'error' && !file && errs.some(l => /sha512 checksum mismatch/i.test(l))));
  results.push(await scenario('versao-menor', releaseRoutes({ ver: '0.7.1', exe: EXE }), ({ ev, seen }) => ev === 'fachada:none' && !seen.some(u => /\.exe/.test(u))));
  results.push(await scenario('sem-assinatura', releaseRoutes({ ver: '0.8.1', exe: EXE, sig: 'none' }), ({ ev, seen, errs }) => ev === 'fachada:error' && !seen.some(u => /\.exe/.test(u)) && errs.some(l => /sem assinatura/.test(l))));
  results.push(await scenario('assinatura-de-outra-chave', releaseRoutes({ ver: '0.8.1', exe: EXE, sig: 'other' }), ({ ev, seen, errs }) => ev === 'fachada:error' && !seen.some(u => /\.exe/.test(u)) && errs.some(l => /não confere/.test(l))));
  results.push(await scenario('host-fora-da-lista', releaseRoutes({ ver: '0.8.1', exe: EXE, exeRedirect: 'https://evil.example/setup.exe' }),
    ({ ev, file, seen, errs }) => ev === 'error' && !file && !seen.some(u => /evil\.example/.test(u)) && errs.some(l => /fora da lista: evil\.example/.test(l))));
  const out = { electron: process.versions.electron, electronUpdater: require('electron-updater/package.json').version, results };
  const file = process.env.BANCADA_E2E_OUT || path.join(ROOT, 'resultado.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FALHOU'} ${r.name}: ${r.ev} → estado ${r.final}${r.pendingExe ? ` (${r.pendingExe})` : ''}${r.errors.length ? ` · ${r.errors[r.errors.length - 1]}` : ''}`);
  console.log(`resultado: ${file}`);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 2 });
  app.exit(results.every(r => r.ok) ? 0 : 1);
});
