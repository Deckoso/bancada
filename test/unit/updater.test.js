'use strict';
// Atualização (E8-T8.1/T8.2/T8.3) — sem publicar nada e sem rede: a "Release" é uma pasta de fixture servida por um
// transporte injetado (o equivalente a file://), com os mesmos redirecionamentos do GitHub de verdade.
// Cenários: versão nova válida → baixa/confere/agenda · hash adulterado → recusa · versão menor → recusa · host fora
// da lista → recusa · DR diferente (Mac) → recusa · instalada ad-hoc → "baixe pelo site" · tamanho/versão do app que não
// batem → recusa. Windows: configuração do electron-updater (instala só ao sair, sem downgrade, filtro de hosts) e a
// conferência de SHA-512 que ele usa (DigestTransform do builder-util-runtime).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const U = require('../../app/main/updater');

const MAC = process.platform === 'darwin';
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atualiza-'));
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
const DR_OK = 'identifier "com.mcpp.bancada" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"';
const DR_OUTRO = 'identifier "com.mcpp.bancada" and certificate leaf = H"fedcba9876543210fedcba9876543210fedcba98"';
const DR_ADHOC = 'cdhash H"0cce0cce0cce0cce0cce0cce0cce0cce0cce0cce"';
const CDH = 'abcdef0123456789abcdef0123456789abcdef01';
// chaves de TESTE (geradas aqui; nada a ver com a chave de quem publica)
const KEY = crypto.generateKeyPairSync('ed25519');
const OTHER = crypto.generateKeyPairSync('ed25519');
const PUB = KEY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const signWith = (k, name, text) => crypto.sign(null, U.manifestMessage(name, Buffer.from(text)), k.privateKey).toString('base64');

// ---------- "Release" de fixture ----------
function plist(ver, id = 'com.mcpp.bancada') {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${ver}</string></dict></plist>\n`;
}
// zip com uma Bancada.app falsa (só o Info.plist), como o ditto do build-mac.js faz
function fakeZip(dir, ver, { appVer = ver, id } = {}) {
  const src = path.join(dir, `src-${ver}-${appVer}`); const app = path.join(src, 'Bancada.app', 'Contents');
  fs.mkdirSync(app, { recursive: true }); fs.writeFileSync(path.join(app, 'Info.plist'), plist(appVer, id));
  const zip = path.join(dir, `Bancada-${ver}-universal-mac.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(src, 'Bancada.app'), zip]);
  return zip;
}
function ymlFor(ver, zip, { sha = null, size = null } = {}) {
  const buf = fs.readFileSync(zip);
  return [`version: ${ver}`, 'files:', `  - url: Bancada-${ver}-universal-mac.zip`, `    sha512: ${sha || sha512(buf)}`, `    size: ${size == null ? buf.length : size}`,
    `path: Bancada-${ver}-universal-mac.zip`, `sha512: ${sha || sha512(buf)}`, `releaseDate: '2026-11-16T12:00:00.000Z'`, ''].join('\n');
}
// transporte = "GitHub" de mentira: latest/download → download/vX → host de arquivos (como o de verdade)
function release({ ver, yml, zip, ymlRedirect = null, zipRedirect = null, sig = 'ok', name = 'latest-mac.yml' }) {
  const seen = [];
  const routes = new Map();
  // .sig da mesma tag: 'ok' (chave certa) · 'none' (sem .sig) · 'other' (outra chave) · 'tampered' (yml mudou depois de assinar)
  if (sig !== 'none') {
    const s = sig === 'other' ? signWith(OTHER, name, yml) : sig === 'tampered' ? signWith(KEY, name, yml.replace(/^version: .*$/m, 'version: 9.9.9')) : signWith(KEY, name, yml);
    routes.set(`${U.BASE}/download/v${ver}/${name}.sig`, { body: () => Buffer.from(s + '\n') });
  }
  const tagYml = `${U.BASE}/download/v${ver}/latest-mac.yml`;
  routes.set(`${U.BASE}/latest/download/latest-mac.yml`, { redirect: ymlRedirect || tagYml });
  routes.set(tagYml, { redirect: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/latest-mac.yml?sig=x' });
  routes.set('https://release-assets.githubusercontent.com/github-production-release-asset/1/latest-mac.yml?sig=x', { body: () => Buffer.from(yml) });
  if (zip) {
    routes.set(`${U.BASE}/download/v${ver}/Bancada-${ver}-universal-mac.zip`, { redirect: zipRedirect || 'https://objects.githubusercontent.com/github-production-release-asset/1/zip?sig=y' });
    routes.set('https://objects.githubusercontent.com/github-production-release-asset/1/zip?sig=y', { body: () => fs.createReadStream(zip) });
  }
  const transport = async (url) => {
    seen.push(url);
    const r = routes.get(url);
    if (!r) return { status: 404, headers: {}, body: Readable.from([]) };
    if (r.redirect) return { status: 302, headers: { location: r.redirect }, body: Readable.from([]) };
    const b = r.body(); return { status: 200, headers: {}, body: Buffer.isBuffer(b) ? Readable.from([b]) : b };
  };
  return { transport, seen };
}
// codesign falso (o resto — ditto, plutil — é o de verdade): DR por caminho
function fakeExec({ installed, staged, verifyOk = true }) {
  const calls = [];
  const real = (cmd, args) => new Promise((resolve) => require('child_process').execFile(cmd, args, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })));
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === '/usr/bin/codesign') {
      if (args[0] === '--verify') return { code: verifyOk ? 0 : 1, stdout: '', stderr: '' };
      const target = args[args.length - 1];
      if (args[0] === '-dvvv') return { code: 0, stdout: '', stderr: `Executable=${target}\nCDHash=${CDH}\n` };
      const dr = /\/nova\/Bancada\.app$/.test(target) ? staged : installed;
      return dr ? { code: 0, stdout: `designated => ${dr}\n`, stderr: `Executable=${target}\n` } : { code: 1, stdout: '', stderr: 'code object is not signed at all' };
    }
    return real(cmd, args);
  };
  return { exec, calls };
}
function setup({ cur = '0.8.0', ver = '0.8.1', installedDr = DR_OK, stagedDr = DR_OK, tamper = false, appVer, size, ymlRedirect, zipRedirect, verifyOk, sig = 'ok' } = {}) {
  const root = tmpdir();
  const appDir = path.join(root, 'Aplicativos'); fs.mkdirSync(path.join(appDir, 'Bancada.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Bancada.app', 'Contents', 'Info.plist'), plist(cur));
  const relDir = path.join(root, 'release'); fs.mkdirSync(relDir);
  const zip = fakeZip(relDir, ver, { appVer });
  let yml = ymlFor(ver, zip, { size });
  if (tamper === true) fs.appendFileSync(zip, Buffer.from('byte a mais de quem mexeu no caminho'));   // zip adulterado, yml original
  if (tamper === 'same-size') yml = ymlFor(ver, zip, { sha: sha512(Buffer.from('outro conteúdo')) });   // mesmo tamanho, hash de outro arquivo
  const rel = release({ ver, yml, zip, ymlRedirect, zipRedirect, sig });
  const ex = fakeExec({ installed: installedDr, staged: stagedDr, verifyOk });
  const spawned = [];
  const mu = new U.MacUpdater({ dir: path.join(root, 'dados', 'atualizacao'), app: path.join(appDir, 'Bancada.app'), currentVersion: cur,
    transport: rel.transport, exec: ex.exec, spawnSwap: (s) => spawned.push(s), publicKey: PUB });
  return { root, mu, rel, ex, spawned, dataDir: path.join(root, 'dados', 'atualizacao') };
}
const leftovers = (dir) => { try { return fs.readdirSync(dir).filter(f => !/^(troca\.log)$/.test(f)); } catch { return []; } };

// ---------- puros ----------
test('versão: só X.Y.Z; compara número a número (0.10.0 > 0.9.9); pré-lançamento e lixo recusados', () => {
  assert.equal(U.cmpVersion('0.8.1', '0.8.0'), 1); assert.equal(U.cmpVersion('0.8.0', '0.8.0'), 0); assert.equal(U.cmpVersion('0.7.9', '0.8.0'), -1);
  assert.equal(U.cmpVersion('0.10.0', '0.9.9'), 1);
  for (const v of ['0.8.1-beta', 'v0.8.1', '0.8', '', null, '1.2.3.4', '0.8.1 ']) if (v !== '0.8.1 ') assert.equal(U.parseVersion(v), null, String(v));
  assert.throws(() => U.cmpVersion('0.8.1-beta', '0.8.0'), /inválida/);
});

test('latest-mac.yml: lê o formato do electron-builder; zip só da MESMA versão, com SHA-512 e tamanho', () => {
  const sha = sha512(Buffer.from('x'));
  const yml = `version: 0.8.1\nfiles:\n  - url: Bancada-0.8.1-universal-mac.zip\n    sha512: ${sha}\n    size: 1234\n  - url: Bancada-0.8.1-universal-mac.dmg\n    sha512: ${sha}\n    size: 999\npath: Bancada-0.8.1-universal-mac.zip\nsha512: ${sha}\nreleaseDate: '2026-11-16T12:00:00.000Z'\n`;
  const info = U.parseLatestYml(yml);
  assert.equal(info.version, '0.8.1'); assert.equal(info.files.length, 2); assert.equal(info.files[0].size, 1234);
  const a = U.macAsset(info);
  assert.equal(a.url, 'https://github.com/Deckoso/bancada/releases/download/v0.8.1/Bancada-0.8.1-universal-mac.zip'); assert.equal(a.sha512, sha);
  // o yml não escolhe o endereço: um "url" absoluto para outro host não é aceito
  const evil = U.parseLatestYml(yml.replace(/url: Bancada-0\.8\.1-universal-mac\.zip/, 'url: https://evil.example/Bancada-0.8.1-universal-mac.zip'));
  assert.throws(() => U.macAsset(evil), /sem Bancada-0\.8\.1-universal-mac\.zip/);
  assert.throws(() => U.macAsset(U.parseLatestYml(yml.replace(/sha512: \S+\n    size: 1234/, 'size: 1234'))), /SHA-512/);
  assert.throws(() => U.parseLatestYml('files:\n'), /sem versão/);
  assert.throws(() => U.parseLatestYml('version: 0.8.1-rc1\n'), /sem versão/);
});

test('hosts: só HTTPS para github.com, api.github.com e os servidores de arquivo do GitHub', () => {
  for (const u of ['https://github.com/Deckoso/bancada/releases.atom', 'https://api.github.com/repos/x', 'https://objects.githubusercontent.com/a', 'https://release-assets.githubusercontent.com/a']) assert.ok(U.hostAllowed(u), u);
  for (const u of ['http://github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x', 'https://raw.githubusercontent.com/x', 'file:///etc/passwd', 'https://user:pw@github.com/x', 'https://github.com:8443/x', 'nada'])
    assert.equal(U.hostAllowed(u), false, u);
});

test('script da troca: aspas seguras (espaço, apóstrofo), espera o PID, confere assinatura+DR, guarda o antigo e volta se falhar; nunca reassina', () => {
  const s = U.swapScript({ pid: 4242, staged: "/x/Application Support/Bancada/atualizacao/nova/Bancada.app", app: "/Applications/Bancada d'Ana.app",
    backup: '/x/anterior/Bancada.app', dr: DR_OK, logFile: '/x/troca.log' });
  assert.match(s, /^PID=4242$/m);
  assert.match(s, /^APP='\/Applications\/Bancada d'\\''Ana\.app'$/m);
  assert.match(s, /^NEW='\/x\/Application Support\/Bancada\/atualizacao\/nova\/Bancada\.app'$/m);
  assert.match(s, /while kill -0 "\$PID"/);
  assert.match(s, /codesign --verify --deep --strict "\$NEW"/); assert.match(s, /\[ "\$GOT" = "\$DR" \]/);
  assert.match(s, /\/bin\/mv "\$APP" "\$OLD"/); assert.match(s, /\/bin\/mv "\$OLD" "\$APP"/);
  assert.doesNotMatch(s, /codesign[^\n]*(--sign|-s )/, 'nunca assina na máquina de quem recebe');
  // sem CDHash/versão conferidos, o script recusa (nunca troca por "qualquer Bancada assinada")
  assert.match(s, /^CDH='nenhum'$/m); assert.match(s, /^VER='0\.0\.0'$/m);
  assert.match(s, /\[ "\$GOTH" = "\$CDH" \] \|\| \{ echo "recusado: não é o app que foi conferido/);
  assert.match(s, /\[ "\$GOTV" = "\$VER" \] \|\| \{ echo "recusado: versão/);
  const s2 = U.swapScript({ pid: 1, staged: '/a', app: '/b', backup: '/c', dr: DR_OK, logFile: '/l', version: '0.8.1', cdhash: CDH });
  assert.ok(s2.includes(`CDH='${CDH}'`) && /^VER='0\.8\.1'$/m.test(s2));
  assert.doesNotMatch(s, /curl|https?:/, 'a troca não usa rede');
  // sintaxe do sh
  if (MAC) { const f = path.join(tmpdir(), 't.sh'); fs.writeFileSync(f, s); execFileSync('/bin/sh', ['-n', f]); }
});

test('DR estável: só certificado (folha) + identificador da Bancada; ad-hoc (cdhash) não serve', () => {
  assert.ok(U.stableDr(DR_OK)); assert.equal(U.stableDr(DR_ADHOC), false); assert.equal(U.stableDr(null), false);
  assert.equal(U.stableDr('identifier "outro.app" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"'), false);
  assert.equal(U.bundleOf('/Applications/Bancada.app/Contents/MacOS/Bancada'), '/Applications/Bancada.app');
  assert.equal(U.bundleOf('C:\\Users\\x\\Bancada.exe'), null);
  assert.match(U.placeProblem('/private/var/folders/ab/AppTranslocation/123/d/Bancada.app'), /temporário/);
  assert.match(U.placeProblem('/Volumes/Bancada 0.8.0/Bancada.app'), /\.dmg/);
});

// ---------- Mac: cenários com a "Release" de fixture ----------
test('Mac: versão nova válida → baixa (redirecionamentos do GitHub), confere SHA-512 + assinatura + DR + versão, deixa pronta e agenda a troca ao sair', { skip: !MAC }, async () => {
  const { mu, rel, ex, spawned, dataDir } = setup();
  const pcts = [];
  const r = await mu.check({ onProgress: (p) => pcts.push(p) });
  assert.deepEqual(r, { state: 'ready', version: '0.8.1' });
  assert.ok(fs.existsSync(path.join(dataDir, 'nova', 'Bancada.app', 'Contents', 'Info.plist')), 'extraído para staging');
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['nova'], 'o zip some depois de extraído');
  assert.equal(pcts[pcts.length - 1], 100);
  assert.ok(rel.seen.every(U.hostAllowed), 'só hosts permitidos'); assert.equal(rel.seen.length, 6, 'yml (3 saltos) + .sig + zip (2 saltos)');
  assert.ok(rel.seen.includes(`${U.BASE}/download/v0.8.1/latest-mac.yml.sig`));
  assert.ok(ex.calls.some(c => /codesign --verify --deep --strict .*\/nova\/Bancada\.app$/.test(c)));
  assert.ok(!ex.calls.some(c => /codesign.*(--sign|-s )/.test(c)), 'nunca reassina');
  // 2ª checagem não baixa de novo
  const n = rel.seen.length; assert.equal((await mu.check()).state, 'ready'); assert.equal(rel.seen.length, n);
  // ao sair: script destacado com o PID, o DR do instalado e o backup em atualizacao/anterior
  assert.equal(mu.scheduleSwap(4242), true);
  assert.equal(spawned.length, 1);
  const s = fs.readFileSync(spawned[0], 'utf8');
  assert.match(s, /^PID=4242$/m); assert.ok(s.includes(`DR='${DR_OK}'`)); assert.ok(s.includes(path.join(dataDir, 'anterior', 'Bancada.app')));
  assert.match(s, /^VER='0\.8\.1'$/m); assert.ok(s.includes(`CDH='${CDH}'`), 'CDHash do app conferido gravado no script');
  assert.equal(fs.statSync(spawned[0]).mode & 0o777, 0o700);
  // reabrir a Bancada antes de sair: a versão preparada é reaproveitada (sem baixar de novo)
  const again = new U.MacUpdater({ dir: dataDir, app: mu.app, currentVersion: '0.8.0', transport: async () => { throw new Error('não devia baixar'); }, exec: ex.exec, publicKey: PUB });
  assert.deepEqual(await again.restore(), { version: '0.8.1', staged: path.join(dataDir, 'nova', 'Bancada.app'), dr: DR_OK, cdhash: CDH });
  // já atualizada (abriu na 0.8.1): a sobra é apagada
  const done = new U.MacUpdater({ dir: dataDir, app: mu.app, currentVersion: '0.8.1', exec: ex.exec });
  assert.equal(await done.restore(), null); assert.equal(fs.existsSync(path.join(dataDir, 'nova')), false);
});

test('assinatura do manifesto: Ed25519 com a chave fixa; outra chave, yml alterado, nome trocado ou .sig malformado → recusado', () => {
  const yml = 'version: 0.8.1\nfiles:\n  - url: Bancada-Setup-0.8.1-windows-x64.exe\n    sha512: x\n';
  const sig = signWith(KEY, 'latest.yml', yml);
  assert.equal(U.verifyManifest('latest.yml', Buffer.from(yml), sig, PUB), true);
  assert.equal(U.verifyManifest('latest.yml', Buffer.from(yml + ' '), sig, PUB), false, 'manifesto alterado');
  assert.equal(U.verifyManifest('latest-mac.yml', Buffer.from(yml), sig, PUB), false, 'assinatura de um manifesto não vale para o outro');
  assert.equal(U.verifyManifest('latest.yml', Buffer.from(yml), signWith(OTHER, 'latest.yml', yml), PUB), false, '.sig de outra chave');
  for (const bad of ['', 'nada', sig.slice(0, 40), null]) assert.equal(U.verifyManifest('latest.yml', Buffer.from(yml), bad, PUB), false, String(bad));
  assert.equal(U.verifyManifest('latest.yml', Buffer.from(yml), sig), false, 'a chave fixa no app não é a de teste');
  assert.match(U.UPDATE_PUBLIC_KEY, /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/, 'chave pública Ed25519 fixa no código');
  // a privada nunca no repositório
  const { execFileSync: ex } = require('child_process');
  const tracked = ex('git', ['-C', path.join(__dirname, '../..'), 'ls-files'], { encoding: 'utf8' }).split('\n');
  assert.ok(!tracked.some(f => /\.pem$|ed25519/i.test(f)), 'nenhuma chave no repositório');
});

test('Mac: sem .sig, .sig de outra chave ou manifesto alterado depois de assinar → recusa ANTES de baixar o zip (falha fechada)', { skip: !MAC }, async () => {
  for (const sig of ['none', 'other', 'tampered']) {
    const { mu, rel, dataDir } = setup({ sig });
    await assert.rejects(mu.check(), (e) => e.code === 'SIG' && /recusada/.test(e.message), sig);
    assert.ok(!rel.seen.some(u => /\.zip|\/zip\?/.test(u)), `${sig}: não baixou o zip`);
    assert.deepEqual(leftovers(dataDir), [], sig);
  }
});

test('Mac: hash adulterado → recusa, apaga o baixado, nada preparado', { skip: !MAC }, async () => {
  const { mu, dataDir, spawned } = setup({ tamper: true });
  await assert.rejects(mu.check(), (e) => e.code === 'SIZE' || e.code === 'HASH');
  assert.deepEqual(leftovers(dataDir), [], 'nada sobra');
  assert.equal(mu.scheduleSwap(1), false); assert.equal(spawned.length, 0);
  // mesmo tamanho, conteúdo diferente do anunciado
  const b = setup({ tamper: 'same-size' });
  await assert.rejects(b.mu.check(), (e) => e.code === 'HASH' && /SHA-512/.test(e.message) && /assinado/.test(e.message));
  assert.deepEqual(leftovers(b.dataDir), []);
});

test('Mac: tamanho anunciado diferente → recusa', { skip: !MAC }, async () => {
  const { mu } = setup({ size: 10 });
  await assert.rejects(mu.check(), (e) => e.code === 'SIZE');
});

test('Mac: versão menor (ou igual) na Release → recusa sem baixar nada', { skip: !MAC }, async () => {
  const lower = setup({ cur: '0.8.1', ver: '0.8.0' });
  const r = await lower.mu.check();
  assert.equal(r.state, 'none'); assert.equal(r.refused, 'downgrade');
  assert.ok(!lower.rel.seen.some(u => /\.zip/.test(u)), 'não baixou o zip');
  const same = setup({ cur: '0.8.1', ver: '0.8.1' });
  assert.equal((await same.mu.check()).state, 'none');
  assert.ok(!same.rel.seen.some(u => /\.zip/.test(u)));
});

test('Mac: host fora da lista (no yml ou no zip) → recusa antes de conectar', { skip: !MAC }, async () => {
  const a = setup({ ymlRedirect: 'https://evil.example/latest-mac.yml' });
  await assert.rejects(a.mu.check(), (e) => e.code === 'HOST' && /evil\.example/.test(e.message));
  assert.ok(!a.rel.seen.some(u => /evil/.test(u)), 'nunca pediu ao host de fora');
  const b = setup({ zipRedirect: 'http://objects.githubusercontent.com/zip' });   // mesmo host, sem HTTPS
  await assert.rejects(b.mu.check(), (e) => e.code === 'HOST');
  assert.deepEqual(leftovers(b.dataDir), []);
});

test('Mac: DR do app novo diferente do instalado → recusa e apaga o staging', { skip: !MAC }, async () => {
  const { mu, dataDir } = setup({ stagedDr: DR_OUTRO });
  await assert.rejects(mu.check(), (e) => e.code === 'SIGN' && /DR diferente/.test(e.message));
  assert.deepEqual(leftovers(dataDir), []);
  const unsigned = setup({ verifyOk: false });
  await assert.rejects(unsigned.mu.check(), (e) => e.code === 'SIGN' && /assinatura/.test(e.message));
});

test('Mac: instalada com assinatura local (ad-hoc) ou sem assinatura → "baixe pelo site", sem baixar o zip', { skip: !MAC }, async () => {
  for (const dr of [DR_ADHOC, null]) {
    const { mu, rel } = setup({ installedDr: dr });
    await assert.rejects(mu.check(), (e) => e.code === 'MANUAL');
    assert.ok(!rel.seen.some(u => /\.zip/.test(u)));
  }
});

test('Mac: o app dentro do zip diz outra versão que o yml (troca de zip antigo assinado) → recusa', { skip: !MAC }, async () => {
  const { mu } = setup({ appVer: '0.7.1' });
  await assert.rejects(mu.check(), (e) => e.code === 'APP' && /diz 0\.7\.1/.test(e.message));
});

// ---------- fachada: 1×/dia, desligável, botão, modo dev ----------
function kvMem(init = {}) { const m = new Map(Object.entries(init)); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), m }; }
test('fachada: 1 checagem por dia; desligada não procura; botão procura mesmo desligada; uma checagem por vez; modo dev não faz nada', async () => {
  let now = 10 * U.DAY_MS; let checks = 0;
  const mac = { restore: async () => null, check: async () => { checks++; await new Promise(r => setTimeout(r, 5)); return { state: 'none', version: '0.8.0' } } };
  const kv = kvMem();
  const states = [];
  const up = new U.Updater({ platform: 'darwin', kv, currentVersion: '0.8.0', packaged: true, mac, now: () => now, onChange: (s) => states.push(s.state) });
  await up.tick(); assert.equal(checks, 1); up.stop();
  now += 3600 * 1000; await up.tick(); assert.equal(checks, 1, 'menos de 1 dia: não procura'); up.stop();
  now += U.DAY_MS; await up.tick(); assert.equal(checks, 2); up.stop();
  up.setAuto(false); now += 2 * U.DAY_MS; await up.tick(); assert.equal(checks, 2, 'desligada'); up.stop();
  const [a, b] = [up.check({ manual: true }), up.check({ manual: true })]; await Promise.all([a, b]);
  assert.equal(checks, 3, 'botão funciona desligada e não duplica');
  assert.equal(up.status().auto, false); assert.equal(up.status().state, 'none');
  const dev = new U.Updater({ platform: 'darwin', kv: kvMem(), currentVersion: '0.8.0', packaged: false, mac });
  assert.equal((await dev.check({ manual: true })).state, 'dev'); assert.equal(checks, 3);
});

test('fachada: erro de conferência vai para o registro como erro; "manual" mostra o motivo; pronta → onQuit agenda a troca', async () => {
  const lines = []; const log = { info: (o, m) => lines.push(['info', m]), warn: (o, m) => lines.push(['warn', m]), error: (o, m) => lines.push(['error', m]) };
  const res = [Object.assign(new Error('SHA-512 não confere com o latest-mac.yml'), { code: 'HASH' }), Object.assign(new Error('esta cópia não…'), { code: 'MANUAL' }), { state: 'ready', version: '0.8.1' }];
  let swapped = null;
  const mac = { restore: async () => null, check: async () => { const r = res.shift(); if (r instanceof Error) throw r; return r; }, scheduleSwap: (pid) => { swapped = pid; return true; } };
  const up = new U.Updater({ platform: 'darwin', kv: kvMem(), currentVersion: '0.8.0', packaged: true, mac, log });
  assert.equal((await up.check()).state, 'error'); assert.ok(lines.some(([l, m]) => l === 'error' && /SHA-512/.test(m)));
  assert.equal((await up.check()).state, 'manual');
  assert.equal(up.onQuit(99), false, 'nada pronto, nada agendado');
  const st = await up.check(); assert.equal(st.state, 'ready'); assert.equal(st.version, '0.8.1');
  assert.equal(up.onQuit(99), true); assert.equal(swapped, 99);
});

// ---------- Windows: electron-updater (só baixa) + manifesto assinado (quem decide) ----------
const winYml = (ver, sha, size = 1000) => `version: ${ver}\nfiles:\n  - url: Bancada-Setup-${ver}-windows-x64.exe\n    sha512: ${sha}\n    size: ${size}\npath: Bancada-Setup-${ver}-windows-x64.exe\nsha512: ${sha}\nreleaseDate: '2026-11-16T12:00:00.000Z'\n`;
// "Release" do Windows para o nosso fetch (latest.yml + .sig)
function winRelease({ ver, yml, sig = 'ok' }) {
  const routes = new Map();
  routes.set(`${U.BASE}/latest/download/latest.yml`, { redirect: `${U.BASE}/download/v${ver}/latest.yml` });
  routes.set(`${U.BASE}/download/v${ver}/latest.yml`, { body: Buffer.from(yml) });
  if (sig !== 'none') routes.set(`${U.BASE}/download/v${ver}/latest.yml.sig`, { body: Buffer.from((sig === 'other' ? signWith(OTHER, 'latest.yml', yml) : signWith(KEY, 'latest.yml', yml)) + '\n') });
  const seen = [];
  const transport = async (url) => {
    seen.push(url); const r = routes.get(url);
    if (!r) return { status: 404, headers: {}, body: Readable.from([]) };
    if (r.redirect) return { status: 302, headers: { location: r.redirect }, body: Readable.from([]) };
    return { status: 200, headers: {}, body: Readable.from([r.body]) };
  };
  return { transport, seen };
}
// electron-updater de mentira: anuncia o que lhe mandarem e "baixa" um arquivo de verdade no disco
function fakeAu({ announce = null, fileBody = null, dir = tmpdir() } = {}) {
  const au = new EventEmitter();
  au.filter = null; au.feed = null; au.checks = 0; au.downloads = 0; au.installs = [];
  au.quitAndInstall = (a, b) => { au.installs.push([a, b]); };
  au.netSession = { webRequest: { onBeforeRequest: (f, fn) => { au.filter = fn; } } };
  au.setFeedURL = (o) => { au.feed = o; };
  au.checkForUpdates = async () => { au.checks++; if (announce) au.emit('update-available', announce); return announce ? { updateInfo: announce, isUpdateAvailable: true } : null; };
  au.downloadUpdate = async () => {
    au.downloads++;
    const file = path.join(dir, `Bancada-Setup-${announce.version}-windows-x64.exe`); fs.writeFileSync(file, fileBody);
    au.file = file;
    setImmediate(() => au.emit('update-downloaded', { ...announce, downloadedFile: file }));
    return [file];
  };
  return au;
}
const waitState = (up, want) => new Promise((resolve) => { const t0 = Date.now(); (function w() { if (want.includes(up.status().state) || Date.now() - t0 > 3000) resolve(up.status()); else setTimeout(w, 5); })(); });
function winSetup({ cur = '0.8.0', ver = '0.8.1', sig = 'ok', announceSha = null, announceVer = null, fileTamper = false } = {}) {
  const exe = Buffer.from(`MZ instalador de teste ${ver} `.repeat(500));
  const sha = sha512(exe);
  const yml = winYml(ver, sha, exe.length);
  const rel = winRelease({ ver, yml, sig });
  const v = announceVer || ver;
  const announce = { version: v, files: [{ url: `Bancada-Setup-${v}-windows-x64.exe`, sha512: announceSha || sha, size: exe.length }] };
  const body = fileTamper ? Buffer.concat([exe.subarray(0, 100), Buffer.from('x'), exe.subarray(101)]) : exe;
  const au = fakeAu({ announce, fileBody: body });
  const lines = []; const log = { info: (o, m) => lines.push(['info', m]), warn: (o, m) => lines.push(['warn', m]), error: (o, m) => lines.push(['error', m]) };
  const up = new U.Updater({ platform: 'win32', kv: kvMem(), currentVersion: cur, packaged: true, makeWin: () => au, transport: rel.transport, publicKey: PUB, log });
  return { up, au, rel, lines, exe };
}

test('Windows: configuração do electron-updater — não baixa nem instala sozinho, sem downgrade, feed GitHub público, filtro de hosts', async () => {
  const au = fakeAu(); const states = [];
  U.configureWin(au, { log: null, current: '0.8.0', onState: (s) => states.push(s) });
  assert.equal(au.autoDownload, false); assert.equal(au.autoInstallOnAppQuit, false); assert.equal(au.allowDowngrade, false); assert.equal(au.allowPrerelease, false);
  assert.deepEqual(au.feed, { provider: 'github', owner: 'Deckoso', repo: 'bancada', releaseType: 'release' });
  assert.equal(await au.verifyUpdateCodeSignature(['x'], 'C:\\t.exe'), null);
  const ask = (url) => new Promise((r) => au.filter({ url }, (x) => r(x.cancel)));
  assert.equal(await ask('https://github.com/Deckoso/bancada/releases.atom'), false);
  assert.equal(await ask('https://release-assets.githubusercontent.com/x'), false);
  assert.equal(await ask('https://evil.example/Bancada-Setup.exe'), true);
  assert.equal(await ask('http://github.com/x'), true);
  au.emit('update-available', { version: '0.7.1' }); assert.equal(states.pop().refused, 'downgrade');
  // sem a fachada (sem conferência), um download nunca vira "pronta"
  au.emit('update-downloaded', { version: '0.8.1', downloadedFile: 'C:\\x.exe' }); assert.equal(states.pop().state, 'error');
  const pkg = require('../../package.json');
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'Deckoso', repo: 'bancada' }]);
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater é dependência de produção');
  for (const f of ['scripts/build-win.js', 'scripts/build-mac.js']) assert.match(fs.readFileSync(path.join(__dirname, '../..', f), 'utf8'), /'--publish', 'never'/, `${f} nunca publica`);
});

test('Windows: manifesto assinado válido → baixa, confere o SHA-512 do arquivo baixado, "pronta"; instala só no before-quit (reconfere)', async () => {
  const { up, au, rel, lines } = winSetup();
  await up.check({ manual: true });
  const st = await waitState(up, ['ready', 'error']);
  assert.equal(st.state, 'ready'); assert.equal(st.version, '0.8.1');
  assert.ok(rel.seen.includes(`${U.BASE}/download/v0.8.1/latest.yml.sig`)); assert.ok(rel.seen.every(U.hostAllowed));
  assert.equal(au.downloads, 1); assert.deepEqual(au.installs, [], 'nada instalado com a Bancada aberta');
  assert.ok(lines.some(([l, m]) => l === 'info' && /conferida/.test(m)));
  assert.equal(up.onQuit(1), false, 'will-quit não instala no Windows');
  assert.equal(up.onBeforeQuit(), true); assert.deepEqual(au.installs, [[true, false]]);
  assert.equal(up.onBeforeQuit(), false, 'uma vez só');
});

test('Windows: sem .sig, .sig de outra chave → recusa antes de pedir ao electron-updater (falha fechada, no registro)', async () => {
  for (const sig of ['none', 'other']) {
    const { up, au, lines } = winSetup({ sig });
    const st = await up.check({ manual: true });
    assert.equal(st.state, 'error', sig); assert.equal(au.checks, 0, `${sig}: nem perguntou`); assert.equal(au.downloads, 0);
    assert.ok(lines.some(([l, m]) => l === 'error' && /assinatura|\.sig/.test(m)), sig);
    assert.equal(up.onBeforeQuit(), false); assert.deepEqual(au.installs, []);
  }
});

test('Windows: anúncio do electron-updater diferente do manifesto assinado (versão ou hash) → recusa sem baixar', async () => {
  for (const o of [{ announceSha: sha512(Buffer.from('outro')) }, { announceVer: '0.8.2' }]) {
    const { up, au } = winSetup(o);
    const st = await up.check({ manual: true });
    assert.equal(st.state, 'error'); assert.match(st.error, /manifesto assinado/); assert.equal(au.downloads, 0);
  }
});

test('Windows: arquivo baixado diferente do manifesto assinado → apagado, nada instalado; arquivo trocado depois de conferido → não instala', async () => {
  const { up, au, lines } = winSetup({ fileTamper: true });
  await up.check({ manual: true });
  const st = await waitState(up, ['ready', 'error']);
  assert.equal(st.state, 'error'); assert.equal(fs.existsSync(au.file), false, 'arquivo apagado');
  assert.ok(lines.some(([l, m]) => l === 'error' && /SHA-512 do arquivo baixado diferente/.test(m)));
  assert.equal(up.onBeforeQuit(), false); assert.deepEqual(au.installs, []);
  // conferido, mas alguém troca o arquivo antes de sair
  const b = winSetup();
  await b.up.check({ manual: true }); assert.equal((await waitState(b.up, ['ready', 'error'])).state, 'ready');
  fs.appendFileSync(b.au.file, 'x');
  assert.equal(b.up.onBeforeQuit(), false); assert.deepEqual(b.au.installs, []); assert.equal(fs.existsSync(b.au.file), false);
});

test('Windows: versão menor ou igual no manifesto assinado → nada; a fachada nunca chama o electron-updater', async () => {
  const lower = winSetup({ cur: '0.8.1', ver: '0.8.0' });
  const st = await lower.up.check({ manual: true });
  assert.equal(st.state, 'none'); assert.equal(st.refused, 'downgrade'); assert.equal(lower.au.checks, 0);
  const same = winSetup({ cur: '0.8.1', ver: '0.8.1' });
  assert.equal((await same.up.check({ manual: true })).state, 'none'); assert.equal(same.au.checks, 0);
});

test('Windows: o SHA-512 do latest.yml é conferido pelo electron-updater (DigestTransform) — adulterado é recusado', async () => {
  const { DigestTransform } = require('builder-util-runtime');
  const exe = Buffer.from('MZ instalador de mentira 0.8.1 '.repeat(1000));
  const pass = (buf, sha) => new Promise((resolve, reject) => {
    const t = new DigestTransform(sha, 'sha512', 'base64');
    t.on('error', reject); t.on('finish', () => { try { t.validate(); resolve(true); } catch (e) { reject(e); } });
    t.on('data', () => {}); t.end(buf);
  });
  assert.equal(await pass(exe, sha512(exe)), true);
  const bad = Buffer.from(exe); bad[10] ^= 1;
  await assert.rejects(pass(bad, sha512(exe)), (e) => e.code === 'ERR_CHECKSUM_MISMATCH');
  // e o próprio electron-updater exige o sha512 no download (httpExecutor)
  const src = fs.readFileSync(require.resolve('builder-util-runtime/out/httpExecutor.js'), 'utf8');
  assert.match(src, /new DigestTransform\(sha512, "sha512"/);
});

test('remoto: atualização só no computador (canais bloqueados, script não vai ao celular)', () => {
  const { BLOCKED, BLOCKED_PREFIX } = require('../../app/main/remote');
  for (const ch of ['update:status', 'update:check', 'update:setAuto']) assert.ok(BLOCKED.has(ch) && BLOCKED_PREFIX.test(ch), ch);
  assert.match(fs.readFileSync(path.join(__dirname, '../../app/main/remote.js'), 'utf8'), /replace\('<script src="update-ui\.js"><\/script>\\n', ''\)/);
});

test('Mac: cópia da versão anterior apagada 7 dias depois de uma troca que deu certo; troca.log cortado', { skip: !MAC }, async () => {
  const root = tmpdir(); const dir = path.join(root, 'atualizacao');
  const prev = path.join(dir, 'anterior', 'Bancada.app', 'Contents'); fs.mkdirSync(prev, { recursive: true });
  fs.writeFileSync(path.join(prev, 'Info.plist'), plist('0.8.0'));
  fs.writeFileSync(path.join(dir, 'troca.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'troca.log'), Array.from({ length: 50 }, (_, i) => `linha ${i}`).join('\n') + '\n');
  const ex = fakeExec({ installed: DR_OK, staged: DR_OK });
  const mu = (cur) => new U.MacUpdater({ dir, app: path.join(root, 'Bancada.app'), currentVersion: cur, exec: ex.exec, publicKey: PUB });
  let now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(await mu('0.8.0').housekeep(now), false, 'mesma versão: não sabemos se trocou, não mexe');
  assert.equal(await mu('0.8.1').housekeep(now), false, '1ª abertura depois da troca: só marca o dia');
  assert.equal(fs.readFileSync(path.join(dir, 'troca.log'), 'utf8').trim().split('\n').length, 20);
  now += 6 * U.DAY_MS; assert.equal(await mu('0.8.1').housekeep(now), false); assert.ok(fs.existsSync(path.join(dir, 'anterior')));
  now += 2 * U.DAY_MS; assert.equal(await mu('0.8.1').housekeep(now), true);
  assert.equal(fs.existsSync(path.join(dir, 'anterior')), false); assert.equal(fs.existsSync(path.join(dir, 'troca.sh')), false);
});
