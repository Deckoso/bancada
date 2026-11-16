// Motor de voz do Windows: copia para build/whisper/win/ só os arquivos necessários do whisper.cpp OFICIAL
// (release b5454 = v1.9.5, whisper-bin-x64.zip). O zip é baixado de uma URL fixa e só é aberto se o SHA-256 bater com o
// fixo daqui; cada arquivo extraído vai para o manifesto (SHA-256 por arquivo) que o build confere. Roda no Mac ou no
// Windows (usado pelo npm run dist:win; sozinho: node scripts/fetch-whisper-win.js).
// Nada disso vai para o git (build/whisper/win/ está no .gitignore). Rede: só saída HTTPS para o GitHub.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const ZIP_SHA256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
// whisper-cli e o que ele carrega (llvm-objdump -p): whisper.dll, ggml.dll, ggml-base.dll + as variantes de CPU que o ggml
// escolhe ao rodar. Fora: llama, SDL2, parakeet, servidor, testes.
const WANT = /^(whisper-cli\.exe|whisper\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-[a-z0-9]+\.dll)$/i;
const OUT = path.join(__dirname, '..', 'build', 'whisper', 'win');
const MANIFEST = path.join(OUT, 'MANIFEST.sha256');
const ALLOWED = /^(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)$/;

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

// manifesto confere? (arquivos presentes com o SHA-256 anotado)
function verifyManifest() {
  let lines; try { lines = fs.readFileSync(MANIFEST, 'utf8').trim().split('\n'); } catch { return false; }
  if (!lines.length || !lines.some(l => / whisper-cli\.exe$/.test(l))) return false;
  for (const l of lines) {
    const [h, f] = l.split(/\s+/);
    try { if (sha(fs.readFileSync(path.join(OUT, f))) !== h) return false; } catch { return false; }
  }
  return true;
}

async function main() {
  if (verifyManifest()) { console.log('  • motor de voz do Windows já em build/whisper/win (manifesto conferido)'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-win-'));
  try {
    const zip = path.join(work, 'whisper-bin-x64.zip');
    const buf = await get(ZIP_URL);
    const got = sha(buf);
    if (got !== ZIP_SHA256) throw new Error(`SHA-256 do zip não confere: ${got}`);
    fs.writeFileSync(zip, buf);
    const ext = path.join(work, 'x'); fs.mkdirSync(ext);
    // Mac/Linux: unzip · Windows 10+: tar (bsdtar) do sistema
    if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', ext]);
    else execFileSync('/usr/bin/unzip', ['-q', zip, '-d', ext]);
    const src = path.join(ext, 'Release');
    const files = fs.readdirSync(src).filter(f => WANT.test(f)).sort();
    if (!files.includes('whisper-cli.exe') || !files.some(f => /^ggml-cpu-/.test(f))) throw new Error('zip sem os arquivos esperados');
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
    const lines = [];
    for (const f of files) { const b = fs.readFileSync(path.join(src, f)); fs.writeFileSync(path.join(OUT, f), b); lines.push(`${sha(b)}  ${f}`); }
    fs.writeFileSync(MANIFEST, lines.join('\n') + '\n');
    const mb = files.reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0) / 1048576;
    console.log(`  • motor de voz do Windows: ${files.length} arquivos (${mb.toFixed(1)} MB) em build/whisper/win, zip conferido (SHA-256)`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

if (require.main === module) main().catch((e) => { console.error('motor de voz do Windows:', e.message); process.exit(1); });
module.exports = { ZIP_URL, ZIP_SHA256, WANT, verifyManifest, main, OUT };
