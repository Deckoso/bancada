'use strict';
// Tela da voz (E6-T6.1): o WAV que a tela monta (PCM 16 kHz mono 16 bits) é exatamente o que o motor aceita; a
// reamostragem de 48 kHz para 16 kHz mantém a duração; sem microfone não há botão no celular nem atalho que grave.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const { parseWav } = require('../../app/main/voice');
const dir = path.join(__dirname, '../../app/renderer');

function load(bancada) {
  const listeners = [];
  const el = () => ({ appendChild() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} }, style: {}, dataset: {}, firstChild: { style: {} } });
  const win = { bancada, addEventListener: (...a) => listeners.push(a) };
  const document = { querySelector: () => null, querySelectorAll: () => [], createElement: el, createTextNode: () => ({}), addEventListener: (...a) => listeners.push(a), removeEventListener() {}, body: el() };
  const ctx = { window: win, document, performance: { now: () => 0 }, setTimeout, clearTimeout, setInterval, clearInterval, console, Float32Array, Uint8Array, ArrayBuffer, DataView, Math, String, Promise };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'dom.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'voice-ui.js'), 'utf8'), ctx);
  return { V: win.VoiceUI, listeners };
}

test('WAV da tela = formato que o motor aceita (16 kHz, mono, 16 bits), com a duração certa', () => {
  const { V } = load({ platform: 'darwin', voice: {} });
  const f = new Float32Array(16000 * 3).map((_, i) => Math.sin(i / 10) * 0.5);
  const r = parseWav(Buffer.from(V._test.encodeWav(f)));
  assert.equal(r.seconds, 3);
  assert.ok(Math.abs(r.pcm.readInt16LE(20) - Math.round(Math.sin(1) * 0.5 * 0x7fff)) <= 1);
  const clip = parseWav(Buffer.from(V._test.encodeWav(Float32Array.from([2, -2])))).pcm;   // satura em vez de estourar
  assert.equal(clip.readInt16LE(0), 0x7fff); assert.equal(clip.readInt16LE(2), -0x8000);
});

test('reamostragem 48 kHz → 16 kHz mantém a duração e o sinal; 16 kHz passa direto', () => {
  const { V } = load({ platform: 'darwin', voice: {} });
  const f = new Float32Array(48000).fill(0.25);
  const o = V._test.resample(f, 48000);
  assert.equal(o.length, 16000); assert.ok(Math.abs(o[100] - 0.25) < 1e-6);
  assert.equal(V._test.resample(f, 16000), f);
  assert.equal(V._test.resample(new Float32Array(44100), 44100).length, 16000);
  const j = V._test.join([Float32Array.from([1, 2]), Float32Array.from([3, 4])], 3);
  assert.deepEqual([...j], [1, 2, 3]);
});

test('sem motor de voz (celular): sem atalho e sem gravação', () => {
  const { V, listeners } = load({ platform: 'darwin' });
  V.init({ currentTerm: () => 't1' });
  assert.ok(!listeners.some(([ev]) => ev === 'keydown' || ev === 'pointerup'), 'nenhum ouvinte de gravação no celular');
});

test('atalho e ajuda do microfone por sistema (helper): no Windows nada de Mac', () => {
  const T = (platform) => { const { V } = load({ platform, voice: {} }); return V; };
  assert.ok(T('win32') && T('darwin'));
  const src = fs.readFileSync(path.join(dir, 'dom.js'), 'utf8');
  assert.match(src, /voiceKey: PC \? 'Ctrl\+Shift\+M' : '⌘⇧M'/);
  assert.match(src, /micHelp: PC \? 'Configurações → Privacidade e segurança → Microfone/);
});

test('Mac: o Info.plist explica microfone e gravação de tela (sem isso o sistema derruba o app ao pedir)', () => {
  const pkg = require('../../package.json');
  const info = pkg.build.mac.extendInfo;
  assert.match(info.NSMicrophoneUsageDescription, /microfone/); assert.match(info.NSScreenCaptureUsageDescription, /tela/);
  assert.deepEqual(pkg.build.mac.extraResources, [{ from: 'build/whisper/mac', to: 'whisper', filter: ['whisper-cli'] }]);
  // o binário não é versionado: compilado da fonte oficial (tag + SHA-256 fixos) pelo dist:mac / npm run whisper:mac
  const W = require('../../scripts/build-whisper-mac.js');
  assert.match(W.SRC_URL, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz$/);
  assert.match(W.SRC_SHA256, /^[0-9a-f]{64}$/);
  assert.ok(W.CMAKE_ARGS.includes('-DBUILD_SHARED_LIBS=OFF') && W.CMAKE_ARGS.includes('-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64'));
  assert.match(fs.readFileSync(path.join(__dirname, '../../.gitignore'), 'utf8'), /^build\/whisper\/mac\/$/m, 'binário fora do git');
  assert.match(fs.readFileSync(path.join(__dirname, '../../scripts/build-mac.js'), 'utf8'), /build-whisper-mac\.js/);
});

test('celular: 🎤 aparece apagado com "Voz só no computador" (pelo helper) e não grava', () => {
  const { V } = load({ platform: 'darwin' });
  const src = fs.readFileSync(path.join(dir, 'voice-ui.js'), 'utf8');
  assert.match(src, /window\.__REMOTE \? h\('button', \{ class: 'pane-mic off', 'aria-disabled': 'true', title: T\.voiceRemote/);
  assert.equal(V.button('t1'), null, 'no computador sem motor (não remoto): sem botão');
  const dom = fs.readFileSync(path.join(dir, 'dom.js'), 'utf8');
  assert.match(dom, /voiceRemote: 'Voz só no computador'/);
});

test('Ajustes: um ouvinte de progresso da voz só — reabrir troca o anterior; fechar os Ajustes solta', async () => {
  let live = 0;
  const voice = { status: () => new Promise(() => {}), onProgress: () => { live++; let on = true; return () => { if (on) { on = false; live--; } }; } };
  const { V } = load({ platform: 'darwin', voice });
  for (let i = 0; i < 5; i++) V.settingsSection(() => ({}));
  assert.equal(live, 1, '5 aberturas → 1 ouvinte vivo');
  V.closeSettings(); assert.equal(live, 0);
  V.closeSettings(); assert.equal(live, 0);
});
