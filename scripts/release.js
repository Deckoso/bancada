// Monta a pasta release/ SÓ com o que vai para a Release do GitHub (nada de depuração, nada com caminho local):
//   Windows: Bancada-Setup-<v>-windows-x64.exe + .exe.blockmap + latest.yml        (de dist-win/, npm run dist:win)
//   Mac:     Bancada-<v>-universal-mac.zip + .dmg + latest-mac.yml                   (de dist-mac/, npm run dist:mac)
//   latest.yml.sig + latest-mac.yml.sig (Ed25519; sem eles o app não aceita a versão) e SHA256SUMS.txt de tudo acima.
// Confere antes de copiar: versão dos yml = package.json, SHA-512 dos yml = arquivos, nenhum yml com caminho local ou
// nome de usuário. Não publica nada (quem sobe a Release é a pessoa, depois do aval).
// Uso: npm run release:pack
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const root = path.join(__dirname, '..');

const VER = require('../package.json').version;
const OUT = path.join(root, 'release');
const die = (m) => { console.error(m); process.exit(1); };
const hash = (f, alg, enc) => crypto.createHash(alg).update(fs.readFileSync(f)).digest(enc);

// ---------- assinatura dos manifestos (Ed25519) ----------
// A chave PRIVADA fica só nesta máquina, fora do repositório: ~/.config/bancada-assinatura/atualizacao-ed25519.pem (0600).
// A PÚBLICA está fixa no app (app/main/updater.js, UPDATE_PUBLIC_KEY). O app só aceita latest.yml/latest-mac.yml cujo
// .sig confira com ela — publicar uma Release sem esta chave não atualiza ninguém.
const KEY_DIR = path.join(os.homedir(), '.config', 'bancada-assinatura');
const KEY_FILE = path.join(KEY_DIR, 'atualizacao-ed25519.pem');
function signingKey() {
  if (!fs.existsSync(KEY_FILE)) {
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.log(`chave de assinatura nova criada em ${KEY_FILE} (0600). Guarde uma cópia num cofre.`);
  }
  const mode = fs.statSync(KEY_FILE).mode & 0o077;
  if (mode) die(`${KEY_FILE}: permissões abertas demais (use chmod 600)`);
  if (fs.realpathSync(KEY_FILE).startsWith(fs.realpathSync(root) + path.sep)) die('a chave de assinatura nunca pode ficar dentro do repositório');
  return crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
}
const { UPDATE_PUBLIC_KEY, manifestMessage, verifyManifest } = require('../app/main/updater');
function publicOf(priv) { return crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64'); }
if (process.argv.includes('--chave')) {   // só mostra a chave pública (para conferir/fixar no updater.js)
  const pub = publicOf(signingKey());
  console.log(`chave pública: ${pub}`);
  console.log(pub === UPDATE_PUBLIC_KEY ? 'igual à fixada no app.' : 'DIFERENTE da fixada no app (UPDATE_PUBLIC_KEY em app/main/updater.js).');
  process.exit(0);
}

const exe = `Bancada-Setup-${VER}-windows-x64.exe`;
const zip = `Bancada-${VER}-universal-mac.zip`;
const dmg = `Bancada-${VER}-universal-mac.dmg`;
const want = [['dist-win', exe], ['dist-win', `${exe}.blockmap`], ['dist-win', 'latest.yml'], ['dist-mac', zip], ['dist-mac', dmg], ['dist-mac', 'latest-mac.yml']];
for (const [d, f] of want) if (!fs.existsSync(path.join(root, d, f))) die(`falta ${d}/${f} (rode npm run dist:win e npm run dist:mac)`);

// yml: versão, hash e nada pessoal
const user = os.userInfo().username;
for (const [d, yml, files] of [['dist-win', 'latest.yml', [exe]], ['dist-mac', 'latest-mac.yml', [zip, dmg]]]) {
  const t = fs.readFileSync(path.join(root, d, yml), 'utf8');
  if (!new RegExp(`^version: ${VER.replace(/\./g, '\\.')}$`, 'm').test(t)) die(`${yml}: versão diferente de ${VER}`);
  if (/\/(Users|home)\/|[A-Za-z]:\\\\|\/private\/|\/var\/folders/.test(t) || (user.length > 2 && t.includes(user))) die(`${yml}: tem caminho local`);
  for (const f of files) {
    const s512 = hash(path.join(root, d, f), 'sha512', 'base64');
    if (!t.includes(`sha512: ${s512}`)) die(`${yml}: SHA-512 de ${f} não confere`);
    if (!t.includes(`size: ${fs.statSync(path.join(root, d, f)).size}`) && f !== exe) die(`${yml}: tamanho de ${f} não confere`);
  }
}

const priv = signingKey();
if (publicOf(priv) !== UPDATE_PUBLIC_KEY) die('a chave privada não corresponde à chave pública fixada no app (UPDATE_PUBLIC_KEY em app/main/updater.js)');

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
for (const [d, f] of want) fs.copyFileSync(path.join(root, d, f), path.join(OUT, f));
// .sig de cada manifesto, conferido com a pública do app antes de seguir
for (const yml of ['latest.yml', 'latest-mac.yml']) {
  const bytes = fs.readFileSync(path.join(OUT, yml));
  const sig = crypto.sign(null, manifestMessage(yml, bytes), priv).toString('base64');
  if (!verifyManifest(yml, bytes, sig)) die(`${yml}: a assinatura gerada não confere com a chave do app`);
  fs.writeFileSync(path.join(OUT, `${yml}.sig`), sig + '\n');
}
const names = [...want.map(([, f]) => f), 'latest.yml.sig', 'latest-mac.yml.sig'];
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), names.map(f => `${hash(path.join(OUT, f), 'sha256', 'hex')}  ${f}`).join('\n') + '\n');
const extra = fs.readdirSync(OUT).filter(f => !names.includes(f) && f !== 'SHA256SUMS.txt');
if (extra.length) die(`release/ com arquivo a mais: ${extra.join(', ')}`);
for (const f of [...names, 'SHA256SUMS.txt']) {
  const b = fs.statSync(path.join(OUT, f)).size;
  console.log(`${String(b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`).padStart(9)}  ${hash(path.join(OUT, f), 'sha256', 'hex')}  ${f}`);
}
console.log(`release/ pronta (${VER}). Nada foi publicado.`);
