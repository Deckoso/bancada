// Motor de voz do Mac: COMPILA o whisper-cli a partir do código-fonte oficial do whisper.cpp (tag fixa), universal
// (arm64 + x86_64) e estático, e o deixa em build/whisper/mac/whisper-cli. Nenhum binário pronto entra no repositório:
// quem quiser auditar lê a fonte da tag e este script, e o resultado sai igual na máquina de quem compila.
// - O tarball da tag é baixado de URL fixa (só HTTPS, só github.com/codeload.github.com) e SÓ é aberto se o SHA-256
//   bater com o fixo daqui.
// - Já compilado com a mesma fonte (carimbo build/whisper/mac/FONTE.txt) e universal? Não refaz (use --force).
// Uso: npm run whisper:mac  (o npm run dist:mac chama sozinho). Precisa: Xcode Command Line Tools + cmake (~45 s).
// Nada disso vai para o git (build/whisper/mac/ está no .gitignore). Rede: só saída HTTPS para o GitHub.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TAG = 'v1.9.5';
const SRC_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${TAG}.tar.gz`;
const SRC_SHA256 = 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720';
const OUT = path.join(__dirname, '..', 'build', 'whisper', 'mac');
const BIN = path.join(OUT, 'whisper-cli');
const STAMP = path.join(OUT, 'FONTE.txt');
const ALLOWED = /^(github\.com|codeload\.github\.com)$/;
const CMAKE_ARGS = ['-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DGGML_NATIVE=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_BUILD_SERVER=OFF', '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF', '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'];
const stampText = () => `whisper.cpp ${TAG}\nfonte: ${SRC_URL}\nsha256 da fonte: ${SRC_SHA256}\n`;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED.test(u.hostname)) return reject(new Error(`download recusado: ${u.href}`));
    https.get(u, { headers: { 'User-Agent': 'bancada-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); if (hops >= 5) return reject(new Error('redirecionamentos demais'));
        return resolve(get(new URL(res.headers.location, u).href, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 64 * 1048576) { res.destroy(); reject(new Error('arquivo grande demais')); } else parts.push(c); });
      res.on('end', () => resolve(Buffer.concat(parts))); res.on('error', reject);
    }).on('error', reject);
  });
}

const archs = (f) => { try { return execFileSync('lipo', ['-archs', f], { encoding: 'utf8' }).trim().split(/\s+/).sort().join(' '); } catch { return ''; } };
const upToDate = () => {
  try { return fs.readFileSync(STAMP, 'utf8') === stampText() && archs(BIN) === 'arm64 x86_64' && !!(fs.statSync(BIN).mode & 0o111); } catch { return false; }
};

async function main({ force = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('o motor de voz do Mac só compila num Mac');
  if (!force && upToDate()) { console.log(`  • motor de voz do Mac já compilado (whisper.cpp ${TAG}, universal)`); return; }
  for (const t of ['cmake', 'lipo', 'tar']) { try { execFileSync('/usr/bin/which', [t], { stdio: 'ignore' }); } catch { throw new Error(`falta ${t} (Xcode Command Line Tools / brew install cmake)`); } }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-mac-'));
  const t0 = Date.now();
  try {
    const buf = await get(SRC_URL);
    const got = sha(buf);
    if (got !== SRC_SHA256) throw new Error(`SHA-256 da fonte não confere: ${got}`);
    const tgz = path.join(work, `${TAG}.tar.gz`); fs.writeFileSync(tgz, buf);
    const src = path.join(work, 'src'); fs.mkdirSync(src);
    execFileSync('tar', ['-xzf', tgz, '-C', src, '--strip-components', '1']);
    const b = path.join(work, 'build');
    const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '12.0' };
    execFileSync('cmake', ['-S', src, '-B', b, ...CMAKE_ARGS], { stdio: ['ignore', 'ignore', 'inherit'], env });
    execFileSync('cmake', ['--build', b, '-j', String(Math.min(6, os.cpus().length)), '--target', 'whisper-cli'], { stdio: ['ignore', 'ignore', 'inherit'], env });
    const built = path.join(b, 'bin', 'whisper-cli');
    if (archs(built) !== 'arm64 x86_64') throw new Error(`whisper-cli não saiu universal (${archs(built) || 'nada'})`);
    // só frameworks do sistema e libc++ (nenhuma dylib do Homebrew ou da pasta de build)
    const libs = execFileSync('otool', ['-L', built], { encoding: 'utf8' }).split('\n').filter(l => /^\s/.test(l)).map(l => l.trim().split(' ')[0]).filter(Boolean);
    const bad = libs.filter(l => !/^\/(System\/Library|usr\/lib)\//.test(l));
    if (bad.length) throw new Error(`whisper-cli depende de bibliotecas fora do sistema: ${bad.join(', ')}`);
    fs.mkdirSync(OUT, { recursive: true });
    fs.copyFileSync(built, BIN); fs.chmodSync(BIN, 0o755);
    fs.writeFileSync(STAMP, stampText());
    const mb = fs.statSync(BIN).size / 1048576;
    console.log(`  • motor de voz do Mac compilado da fonte ${TAG} (SHA-256 conferido) em ${Math.round((Date.now() - t0) / 1000)} s: universal, ${mb.toFixed(1)} MB`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

if (require.main === module) main({ force: process.argv.includes('--force') }).catch((e) => { console.error('motor de voz do Mac:', e.message); process.exit(1); });
module.exports = { TAG, SRC_URL, SRC_SHA256, CMAKE_ARGS, BIN, STAMP, upToDate, main };
