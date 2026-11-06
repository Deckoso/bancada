'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { AiTools, TOOLS, parseVersion, parseClaudeStatus, parseCodexStatus, parseGoogleStatus, fixShellText, firstProjectDir } = require('../../app/main/ai-tools');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));

test('catálogo: só URLs HTTPS oficiais e fixas', () => {
  const hosts = Object.values(TOOLS).map(t => new URL(t.installUrl));
  assert.ok(hosts.every(u => u.protocol === 'https:'));
  assert.deepEqual(hosts.map(u => u.hostname).sort(), ['antigravity.google', 'chatgpt.com', 'claude.ai']);
});

test('versão e status de conta', () => {
  assert.equal(parseVersion('2.1.318 (Claude Code)'), '2.1.318');
  assert.equal(parseVersion('codex-cli 0.156.1'), '0.156.1');
  assert.equal(parseVersion('nada'), null);
  assert.deepEqual(parseClaudeStatus('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}'), { connected: true, account: 'a@b.c', plan: 'max' });
  assert.equal(parseClaudeStatus('{"loggedIn":false}').connected, false);
  assert.equal(parseClaudeStatus('lixo').connected, null);
  assert.deepEqual(parseCodexStatus('Logged in using ChatGPT\n', 0), { connected: true, account: 'ChatGPT' });
  assert.equal(parseCodexStatus('Not logged in\n', 1).connected, false);
  assert.equal(parseGoogleStatus('Error: Please sign in to view available models.', 0).connected, false);
  assert.equal(parseGoogleStatus('gemini-3-pro\n', 0).connected, true);
});

test('PATH injetado: ~/.local/bin na frente, sem repetir, com os do sistema', () => {
  const ai = new AiTools({ home: '/Users/x', basePath: '/usr/bin:/bin:/Users/x/.local/bin' });
  const p = ai.envPath().split(':');
  assert.equal(p[0], '/Users/x/.local/bin');
  assert.equal(p.filter(x => x === '/Users/x/.local/bin').length, 1);
  assert.ok(p.includes('/opt/homebrew/bin') && p.includes('/usr/sbin'));
});

test('acha o binário pelo caminho absoluto; o oficial (~/.local/bin) vence', () => {
  const home = tmpHome(); const ai = new AiTools({ home });
  assert.equal(ai.find('google'), null);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const b = path.join(home, '.local', 'bin', 'agy'); fs.writeFileSync(b, '#!/bin/sh\necho 1.5.2\n', { mode: 0o755 });
  assert.equal(ai.find('google'), b);
  assert.equal(ai.via(b), 'instalador oficial');
  assert.match(ai.loginExec('google'), /'.*\/\.local\/bin\/agy'$/);
  assert.throws(() => ai.loginExec('claude'), /não está instalado/);
  assert.throws(() => ai.tool('rm -rf'), /desconhecida/);
});

test('status de uma IA instalada (binário falso) e não instalada', async () => {
  const home = tmpHome(); const ai = new AiTools({ home });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; else echo "Logged in using ChatGPT"; fi\n', { mode: 0o755 });
  const s = await ai.status('codex');
  assert.equal(s.installed, true); assert.equal(s.version, '9.9.9'); assert.equal(s.connected, true);
  const n = await ai.status('google');
  assert.equal(n.installed, false); assert.equal(n.connected, null);
});

test('consertar .zshrc: remove duplicata, não mexe no resto, idempotente', () => {
  const dup = 'export PATH="$HOME/.local/bin:$PATH"\nexport PATH="$HOME/.local/bin:$PATH"\nalias ll="ls -l"\n';
  const r = fixShellText(dup, '/Users/x');
  assert.equal(r.removed, 1); assert.equal(r.added, false);
  assert.equal(r.text, 'export PATH="$HOME/.local/bin:$PATH"\nalias ll="ls -l"\n');
  assert.equal(fixShellText(r.text, '/Users/x').changed, false);
  // mesmo lugar escrito de dois jeitos (o instalador do Google usa o caminho completo) conta como repetido
  const mix = fixShellText('export PATH="$HOME/.local/bin:$PATH"\n# Added by Antigravity CLI installer\nexport PATH="/Users/x/.local/bin:$PATH"\n', '/Users/x');
  assert.equal(mix.removed, 1); assert.doesNotMatch(mix.text, /\/Users\/x\/\.local/);
  // pasta de OUTRO usuário não é mexida
  assert.equal(fixShellText('export PATH="/Users/y/.local/bin:$PATH"\n', '/Users/x').added, true);
  const e = fixShellText('alias a=b', '/Users/x');
  assert.equal(e.added, true); assert.match(e.text, /^alias a=b\n\n# Bancada.*\nexport PATH="\$HOME\/\.local\/bin:\$PATH"\n$/);
  assert.equal(fixShellText(e.text, '/Users/x').changed, false);
});

test('fixShell grava com backup e a 2ª vez não muda nada', () => {
  const home = tmpHome(); const ai = new AiTools({ home });
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, 'export PATH="$HOME/.local/bin:$PATH"\nexport PATH="$HOME/.local/bin:$PATH"\n');
  const a = ai.fixShell();
  assert.equal(a.changed, true); assert.ok(fs.existsSync(a.backup));
  assert.equal(fs.readFileSync(rc, 'utf8'), 'export PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal(ai.fixShell().changed, false);
  const h2 = tmpHome(); const b = new AiTools({ home: h2 }).fixShell();
  assert.equal(b.changed, true); assert.equal(b.backup, null);
  assert.match(fs.readFileSync(path.join(h2, '.zshrc'), 'utf8'), /\.local\/bin/);
});

test('um job por vez', () => {
  const ai = new AiTools({ home: tmpHome() });
  ai.startJob('claude', 'install');
  assert.throws(() => ai.startJob('codex', 'install'), /Espere terminar/);
  ai.job = null;
});

test('primeiro projeto: pasta com LEIA-ME, sem sobrescrever', () => {
  const home = tmpHome();
  const d = firstProjectDir(home);
  assert.ok(fs.existsSync(path.join(d, 'LEIA-ME.md')));
  fs.writeFileSync(path.join(d, 'LEIA-ME.md'), 'meu');
  firstProjectDir(home);
  assert.equal(fs.readFileSync(path.join(d, 'LEIA-ME.md'), 'utf8'), 'meu');
});
