// Atualização automática (v0.8).
//  · Autoria: latest.yml e latest-mac.yml são ASSINADOS (Ed25519) por quem gera a Release (scripts/release.js, chave
//    privada fora do repositório). A chave pública está fixa aqui (UPDATE_PUBLIC_KEY). O app baixa o manifesto e o .sig
//    por conta própria e confere ANTES de aceitar qualquer versão; sem .sig válido não atualiza (falha fechada, no
//    registro). O SHA-512 que vale é o do manifesto assinado — quem só consegue publicar na Release não instala nada.
//  · Windows: electron-updater (Release pública do GitHub Deckoso/bancada, sem token), só para baixar: a versão e o
//    SHA-512 que ele anuncia têm de ser os do manifesto assinado; terminado o download, o SHA-512 do arquivo baixado é
//    conferido de novo contra o manifesto assinado e, só então, instala AO SAIR (quitAndInstall no before-quit, com
//    nova conferência do arquivo). Divergiu → apaga e não instala. Sem certificado de código do Windows
//    (verifyUpdateCodeSignature → null): a assinatura do manifesto + o hash são a garantia.
//  · Mac: atualizador nosso (o Squirrel.Mac exige assinatura paga). Lê latest-mac.yml (assinado) da Release, baixa o .zip
//    universal para <dados>/atualizacao/, confere SHA-512 e tamanho, extrai com ditto para staging, confere
//    codesign --verify --deep --strict e que o designated requirement (DR) do app novo é IGUAL ao do instalado; troca
//    ao sair com um script destacado (aguarda a Bancada fechar, guarda o antigo em atualizacao/anterior, põe o novo,
//    confere de novo e reabre). NUNCA reassina: a chave de assinatura não existe na máquina de quem recebe.
//    Instalado com assinatura local (ad-hoc) ou desconhecida → não troca; mostra "baixe pelo site".
//  · Os dois: 1 checagem por dia (+ botão "Procurar atualização" nos Ajustes), desligável; versão menor ou igual é
//    recusada (sem downgrade); rede só HTTPS de SAÍDA para os hosts do GitHub abaixo, redirecionamento conferido a cada
//    salto; nenhuma porta. Tudo no registro (log.js).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn, execFile } = require('child_process');

const OWNER = 'Deckoso', REPO = 'bancada';
const BASE = `https://github.com/${OWNER}/${REPO}/releases`;
const ALLOWED_HOSTS = new Set(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const DAY_MS = 24 * 3600 * 1000;
const FIRST_MS = 90 * 1000;          // 1ª checagem 90 s depois de abrir (não disputa com a abertura)
const TICK_MS = 3600 * 1000;         // de hora em hora vê se já passou 1 dia (um único temporizador)
const MAX_HOPS = 5;
const MAX_YML = 64 * 1024;
const MAX_ZIP = 1024 * 1048576;      // 1 GB: muito acima do zip real (~230 MB); só barra resposta absurda
const BUNDLE_ID = 'com.mcpp.bancada';
const MAX_SIG = 1024;

// chave pública Ed25519 (SPKI, DER em base64) de quem assina os manifestos; a privada nunca está no repositório
const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAcoJA62Iza2DmegSPrXQyt4qzxa/A9MrlzeuTz9V2HKM=';

const bad = (msg, code) => Object.assign(new Error(msg), { code });

// ---------- versão ----------
// só X.Y.Z (sem pré-lançamento): o canal é a Release estável
function parseVersion(v) { const m = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/.exec(String(v || '').trim()); return m ? m.slice(1).map(Number) : null; }
function cmpVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw bad(`versão inválida: ${!x ? a : b}`, 'VERSION');
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// ---------- latest*.yml (formato do electron-builder; parser mínimo, sem dependência) ----------
function unq(s) { s = String(s).trim(); if ((s[0] === "'" && s.endsWith("'")) || (s[0] === '"' && s.endsWith('"'))) s = s.slice(1, -1); return s; }
function parseLatestYml(text) {
  if (typeof text !== 'string' || text.length > MAX_YML) throw bad('latest.yml inválido', 'YML');
  const out = { files: [] }; let cur = null; let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    let m;
    if ((m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw))) {
      inFiles = m[1] === 'files'; cur = null;
      if (!inFiles) out[m[1]] = unq(m[2]);
    } else if (inFiles && (m = /^\s+-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw))) {
      cur = { [m[1]]: unq(m[2]) }; out.files.push(cur);
    } else if (inFiles && cur && (m = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(raw))) {
      cur[m[1]] = unq(m[2]);
    }
  }
  if (!parseVersion(out.version)) throw bad(`latest.yml sem versão válida (${out.version || 'nada'})`, 'YML');
  for (const f of out.files) if (f.size != null) f.size = Number(f.size);
  return out;
}

// arquivo do Mac na Release: o .zip universal da MESMA versão do yml, com SHA-512 e tamanho
function macAsset(info) {
  const want = `Bancada-${info.version}-universal-mac.zip`;
  const f = info.files.find(x => x.url === want);
  if (!f) throw bad(`latest-mac.yml sem ${want}`, 'YML');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(f.sha512 || '')) throw bad('SHA-512 ausente ou malformado no latest-mac.yml', 'YML');
  if (!(f.size > 0 && f.size <= MAX_ZIP)) throw bad('tamanho do zip ausente ou absurdo no latest-mac.yml', 'YML');
  return { name: want, sha512: f.sha512, size: f.size, url: `${BASE}/download/v${info.version}/${want}` };
}

// ---------- assinatura do manifesto (Ed25519) ----------
// a mensagem assinada amarra o NOME do manifesto: a assinatura do latest.yml não serve para o latest-mac.yml
function manifestMessage(name, bytes) { return Buffer.concat([Buffer.from(`bancada-atualizacao-v1\n${name}\n`, 'utf8'), Buffer.from(bytes)]); }
function verifyManifest(name, bytes, sigText, publicKey = UPDATE_PUBLIC_KEY) {
  try {
    const b64 = String(sigText || '').trim();
    if (!/^[A-Za-z0-9+/]{86}==$/.test(b64)) return false;              // 64 bytes
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, manifestMessage(name, bytes), key, Buffer.from(b64, 'base64'));
  } catch { return false; }
}
// baixa <name> da última Release e o <name>.sig DA MESMA versão; só devolve o manifesto se a assinatura conferir
async function fetchSignedManifest(name, transport, publicKey = UPDATE_PUBLIC_KEY) {
  const res = await open(`${BASE}/latest/download/${name}`, transport);
  const bytes = await readSmallBuf(res.body, MAX_YML);
  const info = parseLatestYml(bytes.toString('utf8'));   // só para saber a versão (o .sig vem da mesma tag)
  let sigText;
  try { const s = await open(`${BASE}/download/v${info.version}/${name}.sig`, transport); sigText = (await readSmallBuf(s.body, MAX_SIG)).toString('utf8'); }
  catch (e) { if (e.code === 'NOTFOUND') throw bad(`${name} da versão ${info.version} sem assinatura (.sig): atualização recusada`, 'SIG'); throw e; }
  if (!verifyManifest(name, bytes, sigText, publicKey)) throw bad(`assinatura do ${name} (versão ${info.version}) não confere: atualização recusada`, 'SIG');
  return info;
}
// SHA-512 (base64) de um arquivo, em fluxo
function fileSha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512'); const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c)); s.on('error', reject); s.on('end', () => resolve(h.digest('base64')));
  });
}
function fileSha512Sync(file) {
  const h = crypto.createHash('sha512'); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(4 * 1048576);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('base64');
}
// instalador do Windows no manifesto assinado: o .exe da MESMA versão, com SHA-512 e tamanho
function winAsset(info) {
  const want = `Bancada-Setup-${info.version}-windows-x64.exe`;
  const f = info.files.find(x => x.url === want);
  if (!f) throw bad(`latest.yml sem ${want}`, 'YML');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(f.sha512 || '')) throw bad('SHA-512 ausente ou malformado no latest.yml', 'YML');
  return { name: want, sha512: f.sha512, size: f.size || null };
}

function hostAllowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && !u.username && !u.password && (u.port === '' || u.port === '443');
}

// ---------- rede (só saída HTTPS; redirecionamento seguido aqui, conferindo o host a cada salto) ----------
// transport(url) → Promise<{ status, headers, body: Readable }>. O padrão usa https sem seguir redirecionamento.
function httpsTransport(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Bancada-atualizador', Accept: '*/*' }, timeout: 30000 }, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
  });
}
async function open(url, transport) {
  let cur = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!hostAllowed(cur)) throw bad(`endereço fora da lista permitida: ${safeHost(cur)}`, 'HOST');
    const r = await transport(cur);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers && (r.headers.location || r.headers.Location);
      drain(r.body);
      if (!loc) throw bad('redirecionamento sem destino', 'HTTP');
      cur = new URL(loc, cur).href; continue;
    }
    if (r.status !== 200) { drain(r.body); throw bad(`HTTP ${r.status}`, r.status === 404 ? 'NOTFOUND' : 'HTTP'); }
    return r;
  }
  throw bad('redirecionamentos demais', 'HTTP');
}
function drain(body) { try { if (body && body.resume) body.resume(); } catch {} }
function safeHost(u) { try { return new URL(u).hostname || '?'; } catch { return '?'; } }
function readSmallBuf(body, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    body.on('data', (c) => { n += c.length; if (n > max) { body.destroy(); reject(bad('resposta grande demais', 'HTTP')); } else parts.push(c); });
    body.on('end', () => resolve(Buffer.concat(parts))); body.on('error', reject);
  });
}
// grava em arquivo calculando o SHA-512 ao passar (nada inteiro na memória); confere tamanho e hash
function download(body, file, { size, sha512, onProgress }) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512'); let n = 0; let lastPct = -1; let failed = false;
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const fail = (e) => { if (failed) return; failed = true; body.destroy && body.destroy(); out.destroy(); try { fs.rmSync(file, { force: true }); } catch {} reject(e); };
    body.on('data', (c) => {
      n += c.length;
      if (n > size) return fail(bad('o arquivo baixado é maior que o anunciado', 'SIZE'));
      h.update(c);
      const pct = Math.floor((n / size) * 100); if (pct !== lastPct && onProgress) { lastPct = pct; onProgress(pct); }
    });
    body.on('error', fail); out.on('error', fail);
    body.on('end', () => out.end());
    out.on('finish', () => {
      if (failed) return;
      if (n !== size) return fail(bad(`tamanho não confere (${n} de ${size} bytes)`, 'SIZE'));
      const got = h.digest('base64');
      if (got !== sha512) return fail(bad('SHA-512 não confere com o latest-mac.yml assinado', 'HASH'));
      resolve({ bytes: n });
    });
    body.pipe(out, { end: false });
  });
}

// ---------- ferramentas do Mac (injetáveis nos testes) ----------
function execTool(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 120000, maxBuffer: 4 * 1048576 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}
// designated requirement de um .app ("designated => …"), ou null
async function designatedReq(exec, app) {
  const r = await exec('/usr/bin/codesign', ['-d', '-r-', app]);
  const m = /^designated => (.+)$/m.exec(`${r.stdout}\n${r.stderr}`);
  return r.code === 0 && m ? m[1].trim() : null;
}
// CDHash do objeto conferido (amarra "conferir" e "trocar" ao MESMO app: outra Bancada assinada, até mais velha, não serve)
async function cdHash(exec, app) {
  const r = await exec('/usr/bin/codesign', ['-dvvv', app]);
  const m = /^CDHash=([0-9a-f]{40,64})$/m.exec(`${r.stdout}\n${r.stderr}`);
  return r.code === 0 && m ? m[1] : null;
}
// DR que serve para comparar: identidade de certificado (não ad-hoc/cdhash)
function stableDr(dr) { return !!dr && /certificate leaf\s*=\s*H"[0-9a-f]{40}"/i.test(dr) && !/\bcdhash\b/.test(dr) && dr.includes(`identifier "${BUNDLE_ID}"`); }

// .app que está rodando, a partir do executável (…/Bancada.app/Contents/MacOS/Bancada)
function bundleOf(execPath) { const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath || ''); return m ? m[1] : null; }
// onde a troca não pode acontecer (Gatekeeper "translocou" o app, ou ele roda de dentro do .dmg)
function placeProblem(app) {
  if (!app) return 'não achei o app instalado';
  if (/\/AppTranslocation\//.test(app)) return 'a Bancada está rodando de um lugar temporário do macOS: arraste-a para Aplicativos';
  if (/^\/Volumes\//.test(app)) return 'a Bancada está rodando de dentro do disco (.dmg): arraste-a para Aplicativos';
  try { fs.accessSync(path.dirname(app), fs.constants.W_OK); } catch { return 'sem permissão para trocar o app nessa pasta'; }
  return null;
}

// aspas simples seguras para sh
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// script da troca (roda destacado, depois que a Bancada fecha)
function swapScript({ pid, staged, app, backup, dr, logFile, reopen = true, version = '', cdhash = '' }) {
  const LSREG = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  return `#!/bin/sh
# Bancada — troca da versão ao sair (gerado pela própria Bancada; não reassina nada)
PID=${Number(pid) || 0}
NEW=${q(staged)}
APP=${q(app)}
OLD=${q(backup)}
DR=${q(dr)}
VER=${q(parseVersion(version) ? version : '0.0.0')}
CDH=${q(/^[0-9a-f]{40,64}$/.test(cdhash) ? cdhash : 'nenhum')}
exec >>${q(logFile)} 2>&1
echo "[$(date)] esperando a Bancada fechar para trocar"
i=0
while kill -0 "$PID" 2>/dev/null; do i=$((i+1)); if [ "$i" -gt 240 ]; then echo "desisti: a Bancada continuou aberta"; exit 0; fi; sleep 0.5; done
sleep 1
/usr/bin/codesign --verify --deep --strict "$NEW" || { echo "recusado: assinatura do app novo"; exit 1; }
GOT=$(/usr/bin/codesign -d -r- "$NEW" 2>&1 | /usr/bin/sed -n 's/^designated => //p')
[ "$GOT" = "$DR" ] || { echo "recusado: identidade (DR) do app novo diferente"; exit 1; }
# o MESMO app que a Bancada conferiu (CDHash) e a versão que ela conferiu — nada trocado no meio do caminho
GOTH=$(/usr/bin/codesign -dvvv "$NEW" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p')
[ "$GOTH" = "$CDH" ] || { echo "recusado: não é o app que foi conferido (CDHash diferente)"; exit 1; }
GOTV=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$NEW/Contents/Info.plist" 2>/dev/null)
[ "$GOTV" = "$VER" ] || { echo "recusado: versão do app novo ($GOTV) diferente da conferida ($VER)"; exit 1; }
/bin/rm -rf "$OLD"
/bin/mkdir -p "$(/usr/bin/dirname "$OLD")"
/bin/mv "$APP" "$OLD" || { echo "não consegui tirar o app antigo"; exit 1; }
if ! /bin/mv "$NEW" "$APP"; then echo "não consegui pôr o app novo; voltando"; /bin/rm -rf "$APP"; /bin/mv "$OLD" "$APP"; exit 1; fi
if ! /usr/bin/codesign --verify --deep --strict "$APP"; then echo "app novo não confere no lugar; voltando"; /bin/rm -rf "$APP"; /bin/mv "$OLD" "$APP"; exit 1; fi
GOTH=$(/usr/bin/codesign -dvvv "$APP" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p')
if [ "$GOTH" != "$CDH" ]; then echo "o app no lugar não é o conferido; voltando"; /bin/rm -rf "$APP"; /bin/mv "$OLD" "$APP"; exit 1; fi
${LSREG} -f "$APP" 2>/dev/null
echo "[$(date)] trocada"
${reopen ? '/usr/bin/open "$APP"' : 'true'}
`;
}

// ---------- Mac ----------
class MacUpdater {
  // dir: <dados>/atualizacao · app: .app instalado · currentVersion · transport/exec: injetáveis (testes)
  constructor({ dir, app, currentVersion, transport = httpsTransport, exec = execTool, log = null, spawnSwap = null, publicKey = UPDATE_PUBLIC_KEY }) {
    this.dir = dir; this.app = app; this.current = currentVersion; this.transport = transport; this.exec = exec; this.log = log; this.publicKey = publicKey;
    this.spawnSwap = spawnSwap || ((script) => { const c = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }); c.unref(); });
    this.ready = null;   // { version, staged, dr }
  }
  get stageDir() { return path.join(this.dir, 'nova'); }
  // versão já preparada numa abertura anterior (baixou e conferiu, mas a Bancada não fechou ainda)
  async restore() {
    const staged = path.join(this.stageDir, 'Bancada.app');
    if (!fs.existsSync(staged)) return null;
    try {
      const ver = await this.plist(staged, 'CFBundleShortVersionString');
      if (cmpVersion(ver, this.current) <= 0) { this.clean(); return null; }
      const installedDr = await this.installedDr();
      const r = await this.verifyApp(staged, ver, installedDr);
      this.ready = { version: ver, staged, dr: r.dr, cdhash: r.cdhash };
      return this.ready;
    } catch (e) { this.warn(`versão preparada descartada: ${e.message}`); this.clean(); return null; }
  }
  // depois de uma troca que deu certo (abrimos numa versão MAIOR que a guardada em anterior/): marca o dia e, 7 dias
  // depois, apaga a cópia antiga do app (centenas de MB, e uma versão velha executável no disco), o troca.sh, e corta
  // o troca.log nas últimas 20 linhas
  async housekeep(nowMs = Date.now()) {
    const prev = path.join(this.dir, 'anterior', 'Bancada.app');
    const mark = path.join(this.dir, 'anterior', '.trocada-em');
    try {
      const log = path.join(this.dir, 'troca.log');
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 20) fs.writeFileSync(log, lines.slice(-20).join('\n') + '\n', { mode: 0o600 });
    } catch {}
    if (!fs.existsSync(prev)) return false;
    let older = false;
    try { older = cmpVersion(this.current, await this.plist(prev, 'CFBundleShortVersionString')) > 0; } catch {}
    if (!older) return false;                                  // não sabemos se a troca deu certo: não mexe
    let since = 0; try { since = Number(fs.readFileSync(mark, 'utf8')) || 0; } catch {}
    if (!since) { try { fs.writeFileSync(mark, String(nowMs), { mode: 0o600 }); } catch {} return false; }
    if (nowMs - since < 7 * DAY_MS) return false;
    try { fs.rmSync(path.join(this.dir, 'anterior'), { recursive: true, force: true }); fs.rmSync(path.join(this.dir, 'troca.sh'), { force: true }); } catch {}
    this.info('cópia da versão anterior apagada (7 dias depois da troca)');
    return true;
  }
  clean() { try { fs.rmSync(this.stageDir, { recursive: true, force: true }); } catch {} try { for (const f of fs.readdirSync(this.dir)) if (/\.zip(\.part)?$/.test(f)) fs.rmSync(path.join(this.dir, f), { force: true }); } catch {} }
  warn(m) { if (this.log) this.log.warn('atualização', m); }
  info(m) { if (this.log) this.log.info('atualização', m); }
  async plist(app, key) {
    const r = await this.exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
    if (r.code !== 0) throw bad(`Info.plist sem ${key}`, 'APP');
    return r.stdout.trim();
  }
  async installedDr() {
    const problem = placeProblem(this.app);
    if (problem) throw bad(problem, 'MANUAL');
    const dr = await designatedReq(this.exec, this.app);
    if (!stableDr(dr)) throw bad('esta cópia da Bancada não tem a assinatura que permite atualizar sozinha', 'MANUAL');
    return dr;
  }
  async verifyApp(staged, version, installedDr) {
    if ((await this.exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])).code !== 0) throw bad('a assinatura do app baixado não confere', 'SIGN');
    const dr = await designatedReq(this.exec, staged);
    if (!dr || dr !== installedDr) throw bad('o app baixado não tem a mesma identidade do instalado (DR diferente)', 'SIGN');
    if (await this.plist(staged, 'CFBundleIdentifier') !== BUNDLE_ID) throw bad('o app baixado não é a Bancada', 'APP');
    const ver = await this.plist(staged, 'CFBundleShortVersionString');
    if (ver !== version) throw bad(`o app baixado diz ${ver}, o latest-mac.yml dizia ${version}`, 'APP');
    const cdhash = await cdHash(this.exec, staged);
    if (!cdhash) throw bad('não deu para ler o CDHash do app baixado', 'SIGN');
    return { dr, cdhash };
  }
  // procura; havendo versão maior: baixa, confere, extrai e deixa pronta para trocar ao sair
  async check({ onProgress } = {}) {
    if (this.ready) return { state: 'ready', version: this.ready.version };
    const info = await fetchSignedManifest('latest-mac.yml', this.transport, this.publicKey);   // falha fechada sem .sig válido
    const c = cmpVersion(info.version, this.current);
    if (c === 0) return { state: 'none', version: info.version };
    if (c < 0) { this.warn(`recusada versão menor na Release (${info.version} < ${this.current})`); return { state: 'none', version: this.current, refused: 'downgrade' }; }
    const installedDr = await this.installedDr();   // antes de baixar 230 MB: esta cópia consegue se atualizar?
    const asset = macAsset(info);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.clean();
    const part = path.join(this.dir, `${asset.name}.part`);
    this.info(`baixando ${info.version} (${Math.round(asset.size / 1048576)} MB)`);
    const res = await open(asset.url, this.transport);
    await download(res.body, part, { size: asset.size, sha512: asset.sha512, onProgress });
    const zip = path.join(this.dir, asset.name); fs.renameSync(part, zip);
    fs.mkdirSync(this.stageDir, { recursive: true, mode: 0o700 });
    try {
      const x = await this.exec('/usr/bin/ditto', ['-x', '-k', zip, this.stageDir]);
      if (x.code !== 0) throw bad('não consegui abrir o zip', 'ZIP');
      const ents = fs.readdirSync(this.stageDir).filter(f => f !== '.DS_Store');
      if (ents.length !== 1 || ents[0] !== 'Bancada.app') throw bad('o zip não traz só a Bancada.app', 'ZIP');
      const staged = path.join(this.stageDir, 'Bancada.app');
      const { dr, cdhash } = await this.verifyApp(staged, info.version, installedDr);
      fs.rmSync(zip, { force: true });
      this.ready = { version: info.version, staged, dr, cdhash };
      this.info(`${info.version} conferida (SHA-512 + assinatura + identidade); troca ao sair`);
      return { state: 'ready', version: info.version };
    } catch (e) { this.clean(); throw e; }
  }
  // chamado ao sair: dispara a troca destacada (sobrevive ao fim da Bancada)
  scheduleSwap(pid, { reopen = true } = {}) {
    if (!this.ready) return false;
    const script = path.join(this.dir, 'troca.sh');
    fs.writeFileSync(script, swapScript({ pid, staged: this.ready.staged, app: this.app, backup: path.join(this.dir, 'anterior', 'Bancada.app'),
      dr: this.ready.dr, logFile: path.join(this.dir, 'troca.log'), reopen, version: this.ready.version, cdhash: this.ready.cdhash }), { mode: 0o700 });
    this.info(`troca para ${this.ready.version} agendada para depois de fechar`);
    this.spawnSwap(script);
    return true;
  }
}

// ---------- Windows (electron-updater) ----------
// configura o autoUpdater do electron-updater; separado para os testes conferirem cada chave.
// guard: { expected() → { version, sha512 } | null (do manifesto assinado), onDownloaded(info) } — fornecido pela fachada
function configureWin(au, { log, onState, current, guard = null }) {
  au.logger = { info: (m) => log && log.info('atualização', m), warn: (m) => log && log.warn('atualização', m), error: (m) => log && log.warn('atualização', m), debug() {} };   // o que é falha de verdade chega pelo evento 'error'
  au.autoDownload = false;             // só baixa depois de conferir o anúncio contra o manifesto assinado
  au.autoInstallOnAppQuit = false;     // nunca sozinho: só depois de conferir o arquivo baixado (quitAndInstall ao sair)
  au.allowDowngrade = false;
  au.allowPrerelease = false;
  au.fullChangelog = false;
  au.disableWebInstaller = true;
  // sem certificado de código do Windows: a autoria vem da assinatura Ed25519 do latest.yml + SHA-512 do arquivo
  au.verifyUpdateCodeSignature = async () => null;
  au.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, releaseType: 'release' });
  // rede: só os hosts do GitHub, só HTTPS (inclusive nos redirecionamentos do download)
  try {
    au.netSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
      const ok = hostAllowed(d.url);
      if (!ok && log) log.warn('atualização', `recusado endereço fora da lista: ${safeHost(d.url)}`);
      cb({ cancel: !ok });
    });
  } catch (e) { if (log) log.warn('atualização', `sem filtro de endereços: ${e.message}`); }
  au.on('checking-for-update', () => onState({ state: 'checking' }));
  au.on('update-not-available', (i) => onState({ state: 'none', version: i && i.version }));
  au.on('update-available', (i) => {
    // reforço: nunca aceitar versão menor ou igual (o electron-updater já não aceita com allowDowngrade=false)
    let newer = false; try { newer = cmpVersion(i.version, current) > 0; } catch {}
    if (!newer) { onState({ state: 'none', version: current, refused: 'downgrade' }); return; }
    onState({ state: 'downloading', version: i.version, pct: 0 });
  });
  au.on('download-progress', (p) => onState({ state: 'downloading', pct: Math.floor((p && p.percent) || 0) }));
  // "pronta" só depois de a fachada conferir o arquivo baixado contra o manifesto assinado
  au.on('update-downloaded', (i) => { if (guard) guard.onDownloaded(i); else onState({ state: 'error', error: 'atualização sem conferência: recusada' }); });
  au.on('error', (e) => { const m = String((e && e.message) || e).split('\n')[0].slice(0, 300); if (log) log.error('atualização', m); onState({ state: 'error', error: /checksum|sha512/i.test(m) ? 'o arquivo baixado não passou na conferência (SHA-512) e foi descartado' : /ERR_BLOCKED_BY_CLIENT/.test(m) ? 'endereço fora da lista permitida' : /ERR_INTERNET|ENOTFOUND|ERR_NAME|ERR_NETWORK/i.test(m) ? 'sem internet?' : m.slice(0, 160) }); });
  return au;
}

// ---------- fachada usada pelo index.js ----------
class Updater {
  // platform: 'darwin'|'win32' · kv: { get(k, def), set(k, v) } · currentVersion · packaged · dir · app (Mac)
  // makeWin: () => autoUpdater (Windows) · mac: MacUpdater pronto (testes) · onChange(estado)
  constructor({ platform, kv, currentVersion, packaged, dir, app = null, log = null, onChange = () => {}, makeWin = null, mac = null, now = () => Date.now(), transport = httpsTransport, exec, publicKey = UPDATE_PUBLIC_KEY, hashFile = fileSha512, hashFileSync = fileSha512Sync }) {
    this.platform = platform; this.kv = kv; this.current = currentVersion; this.packaged = packaged; this.log = log; this.onChange = onChange; this.now = now;
    this.transport = transport; this.publicKey = publicKey; this.hashFile = hashFile; this.hashFileSync = hashFileSync;
    this.st = { state: 'idle', current: currentVersion };
    this.timer = null; this.busy = null; this.win = null;
    this.winExpect = null;   // { version, sha512 } do latest.yml ASSINADO desta checagem
    this.winReady = null;    // { version, file, sha512 } — arquivo baixado e conferido
    if (!packaged) this.st = { state: 'dev', current: currentVersion };
    else if (platform === 'win32' && makeWin) this.win = configureWin(makeWin(), { log, current: currentVersion, onState: (s) => this.set(s),
      guard: { onDownloaded: (i) => this.winDownloaded(i) } });
    else if (platform === 'darwin') this.mac = mac || new MacUpdater({ dir, app, currentVersion, transport, exec, log, publicKey });
  }
  get auto() { return this.kv.get('update_auto', true) !== false; }
  set(patch) { this.st = { ...this.st, ...patch, current: this.current }; if (patch.state && patch.state !== 'downloading') delete this.st.pct; if (patch.state && patch.state !== 'error') delete this.st.error; this.onChange(this.status()); }
  status() { return { ...this.st, auto: this.auto, lastCheck: this.kv.get('update_last_check', 0) || 0, platform: this.platform }; }
  async start() {
    if (this.st.state === 'dev') return this;
    if (this.mac) {
      const r = await this.mac.restore().catch(() => null); if (r) this.set({ state: 'ready', version: r.version });
      if (this.mac.housekeep) await this.mac.housekeep().catch(() => false);
    }
    this.schedule(FIRST_MS);
    return this;
  }
  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.tick(), ms); if (this.timer.unref) this.timer.unref(); }
  async tick() {
    try { if (this.auto && this.now() - (this.kv.get('update_last_check', 0) || 0) >= DAY_MS) await this.check(); }
    finally { if (this.st.state !== 'stopped') this.schedule(TICK_MS); }
  }
  stop() { clearTimeout(this.timer); this.timer = null; this.st.state = 'stopped'; }
  setAuto(on) { this.kv.set('update_auto', !!on); this.onChange(this.status()); return this.status(); }
  // manual (botão) ou do temporizador; uma checagem por vez
  check({ manual = false } = {}) {
    if (this.st.state === 'dev') return Promise.resolve(this.status());
    if (this.busy) return this.busy;
    this.busy = this.doCheck(manual).finally(() => { this.busy = null; });
    return this.busy;
  }
  async doCheck(manual) {
    this.kv.set('update_last_check', this.now());
    if (this.st.state === 'ready') return this.status();
    if (this.log) this.log.info('atualização', `procurando (${manual ? 'botão' : 'automática'}; instalada ${this.current})`);
    try {
      if (this.win) {
        this.set({ state: 'checking' });
        // 1) manifesto assinado, buscado por conta própria (falha fechada)
        const info = await fetchSignedManifest('latest.yml', this.transport, this.publicKey);
        const c = cmpVersion(info.version, this.current);
        if (c <= 0) {
          if (c < 0) this.log && this.log.warn('atualização', `recusada versão menor na Release (${info.version} < ${this.current})`);
          this.set({ state: 'none', version: c < 0 ? this.current : info.version, ...(c < 0 ? { refused: 'downgrade' } : {}) });
          return this.status();
        }
        const asset = winAsset(info);
        // 2) o que o electron-updater anuncia tem de ser exatamente o do manifesto assinado
        const r = await this.win.checkForUpdates();
        const ui = r && r.updateInfo;
        const announced = ui && (ui.files || []).find(f => f.url === asset.name);
        if (!ui || ui.version !== info.version || !announced || announced.sha512 !== asset.sha512)
          throw bad('o anúncio da Release não bate com o manifesto assinado: atualização recusada', 'SIG');
        this.winExpect = { version: info.version, sha512: asset.sha512 };
        // 3) baixa; o resultado chega por 'update-downloaded' (conferido em winDownloaded) ou 'error'
        const p = this.win.downloadUpdate();
        if (p && p.catch) p.catch(() => {});
        return this.status();
      }
      if (!this.mac) return this.status();
      this.set({ state: 'checking' });
      const r = await this.mac.check({ onProgress: (pct) => this.set({ state: 'downloading', pct }) });
      this.set(r);
    } catch (e) {
      const code = e && e.code;
      if (code === 'MANUAL') this.set({ state: 'manual', error: e.message });
      else this.set({ state: 'error', error: e.message });
      if (this.log) this.log[code === 'HASH' || code === 'SIGN' || code === 'SIG' || code === 'HOST' ? 'error' : 'warn']('atualização', e.message);
    }
    return this.status();
  }
  // Windows: o electron-updater terminou o download → confere o arquivo contra o manifesto assinado
  async winDownloaded(i) {
    const exp = this.winExpect; const file = i && i.downloadedFile;
    const refuse = (why) => {
      this.winReady = null;
      if (file) { try { fs.rmSync(file, { force: true }); } catch {} }
      if (this.log) this.log.error('atualização', `${why}: arquivo apagado, nada será instalado`);
      this.set({ state: 'error', error: 'o arquivo baixado não confere com o manifesto assinado e foi descartado' });
      return false;
    };
    if (!exp) return refuse('download sem manifesto assinado');
    if (!file || !i || i.version !== exp.version) return refuse('download de outra versão');
    let got; try { got = await this.hashFile(file); } catch (e) { return refuse(`não consegui ler o arquivo baixado (${e.message})`); }
    if (got !== exp.sha512) return refuse('SHA-512 do arquivo baixado diferente do manifesto assinado');
    this.winReady = { version: exp.version, file, sha512: exp.sha512 };
    if (this.log) this.log.info('atualização', `${exp.version} conferida (manifesto assinado + SHA-512 do arquivo); instala ao sair`);
    this.set({ state: 'ready', version: exp.version });
    return true;
  }
  // ao sair (before-quit): Windows instala SÓ o arquivo conferido (confere de novo, síncrono); Mac dispara a troca
  onBeforeQuit() {
    const w = this.winReady;
    if (!this.win || !w) return false;
    this.winReady = null;
    let ok = false; try { ok = this.hashFileSync(w.file) === w.sha512; } catch {}
    if (!ok) { try { fs.rmSync(w.file, { force: true }); } catch {} if (this.log) this.log.error('atualização', 'o arquivo conferido mudou antes de instalar: apagado, nada instalado'); return false; }
    try { this.win.quitAndInstall(true, false); return true; } catch (e) { if (this.log) this.log.error('atualização', e.message); return false; }
  }
  onQuit(pid) { if (this.mac && this.st.state === 'ready') { try { return this.mac.scheduleSwap(pid); } catch (e) { if (this.log) this.log.error('atualização', e.message); } } return false; }
}

module.exports = { Updater, MacUpdater, configureWin, parseVersion, cmpVersion, parseLatestYml, macAsset, winAsset, hostAllowed, open, download, swapScript,
  UPDATE_PUBLIC_KEY, manifestMessage, verifyManifest, fetchSignedManifest, fileSha512, fileSha512Sync,
  designatedReq, cdHash, stableDr, bundleOf, placeProblem, ALLOWED_HOSTS, BASE, DAY_MS, FIRST_MS, TICK_MS, OWNER, REPO };
