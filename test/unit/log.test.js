'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { EventEmitter } = require('events');
const { Log, redact, attachMain, attachRenderer, consoleError } = require('../../app/main/log');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-log-'));

test('log: linha com data, nível e origem; pasta e arquivo só do usuário', () => {
  const dir = path.join(tmp(), 'logs');
  const log = new Log({ dir, now: () => new Date(2026, 0, 2, 3, 4, 5, 6) });
  log.info('main', 'abriu'); log.error('tela', 'quebrou\nem duas linhas');
  const lines = fs.readFileSync(path.join(dir, 'bancada.log'), 'utf8').trim().split('\n');
  assert.equal(lines[0], '2026-01-02 03:04:05.006 info  [main] abriu');
  assert.equal(lines[1], '2026-01-02 03:04:05.006 error [tela] quebrou em duas linhas');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'bancada.log')).mode & 0o777, 0o600);
});

test('log: rotação 2 × limite — nunca passa de dois arquivos nem do dobro do tamanho', () => {
  const dir = tmp();
  const log = new Log({ dir, maxBytes: 2000 });
  let t = 0; log.now = () => new Date(1700000000000 + (t += 20000));   // fora da janela de enxurrada
  for (let i = 0; i < 300; i++) log.info('x', 'linha ' + i + ' ' + 'a'.repeat(40));
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['bancada.log', 'bancada.log.1']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 2000, f);
  const tail = log.tail(5);
  assert.equal(tail.length, 5);
  assert.match(tail[4], /linha 299 /);
});

test('log: rotação que falha não zera a conta; teto duro de 2 × limite no arquivo atual', () => {
  const dir = tmp();
  const log = new Log({ dir, maxBytes: 2000 });
  // o .1 vira uma pasta com conteúdo: a rotação (rename) passa a falhar sempre
  fs.mkdirSync(path.join(dir, 'bancada.log.1')); fs.writeFileSync(path.join(dir, 'bancada.log.1', 'x'), 'x');
  let t = 0; log.now = () => new Date(1700000000000 + (t += 20000));
  for (let i = 0; i < 300; i++) log.info('x', 'linha ' + i + ' ' + 'a'.repeat(40));
  const size = fs.statSync(path.join(dir, 'bancada.log')).size;
  assert.ok(size <= 4000, `arquivo atual com ${size} bytes passou do teto`);
  assert.ok(size > 2000, 'continuou gravando até o teto');
  // rotação volta a funcionar → volta a gravar
  fs.rmSync(path.join(dir, 'bancada.log.1'), { recursive: true });
  log.info('x', 'depois de destravar');
  assert.match(log.tail(1)[0], /depois de destravar/);
});

test('log: enxurrada vira "N linhas omitidas" (teto por janela de 10 s)', () => {
  const dir = tmp(); let now = 1700000000000;
  const log = new Log({ dir, now: () => new Date(now) });
  for (let i = 0; i < 500; i++) log.error('main', 'erro ' + i);
  now += 11000; log.info('main', 'depois');
  const text = fs.readFileSync(path.join(dir, 'bancada.log'), 'utf8');
  assert.equal(text.trim().split('\n').length, 120 + 2);
  assert.match(text, /380 linhas omitidas/);
});

test('log: avisa cada erro gravado (cartão "Travou?"), não avisa info', () => {
  const seen = []; const log = new Log({ dir: tmp(), onError: (l) => seen.push(l) });
  log.info('a', 'ok'); log.warn('a', 'hm'); log.error('a', 'ruim');
  assert.equal(seen.length, 1); assert.match(seen[0], /error \[a\] ruim/);
});

// tokens FALSOS montados aqui (nenhum é de verdade)
const fake = (prefix, n, ch = 'x') => prefix + ch.repeat(n);
test('redação: chaves, tokens, JWT, e-mail, IP privado e home somem', () => {
  const home = '/Users/fulano';
  const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
  const src = [
    'chave ' + fake('sk-ant-', 30), 'outra ' + fake('sk-', 24, 'Z'), fake('ghp_', 36, 'Q'), fake('github_pat_', 40, '9'),
    fake('xoxb-', 20, '1'), 'Authorization: Bearer ' + fake('', 30, 'k'), jwt, 'fulano.silva+x@exemplo.com.br',
    'ip 192.168.0.10 e 10.1.2.3 e 172.20.1.1 e 100.101.102.103', 'arquivo /Users/fulano/Documents/x.txt',
    'win C:\\Users\\fulano\\AppData\\x', 'senha=' + fake('', 12, 'p'), 'AKIA' + 'B'.repeat(16),
  ].join(' | ');
  const out = redact(src, { home });
  for (const bad of ['sk-ant-xxxxx', 'sk-ZZZZ', 'ghp_QQQ', 'github_pat_999', 'xoxb-111', 'kkkkkkkk', 'eyJaaaa', 'fulano', '192.168', '10.1.2.3', '172.20', '100.101', 'pppppp', 'AKIABBB']) {
    assert.ok(!out.includes(bad), `vazou ${bad}: ${out}`);
  }
  assert.match(out, /\[chave-sk\]/); assert.match(out, /\[token-github\]/); assert.match(out, /\[token-slack\]/); assert.match(out, /\[jwt\]/);
  assert.match(out, /\[email\]/); assert.match(out, /\[ip-local\]/); assert.match(out, /~\/Documents\/x\.txt/);
  // o que não é segredo continua legível
  assert.match(redact('versão 2.1.300 · ip público 8.8.8.8 · /usr/bin/git', { home }), /2\.1\.300 .*8\.8\.8\.8 .*\/usr\/bin\/git/);
});

test('redação: access/refresh_token, client_secret, tskey, npm, hf, stripe, cookies, PEM, IPv6 da tailnet, credencial em URL, caminhos fora do home', () => {
  const crypto = require('crypto');
  const r = (n) => Array.from(crypto.randomBytes(n), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');   // valores falsos, novos a cada execução
  const v = { at: r(20), rt: r(24), cs: r(24), ts: r(20), npm: r(36), hf: r(34), sl: r(24), st: r(24), ck: r(20), sc: r(20), pem: r(40), pw: r(12), ip6: 'fd7a:115c:a1e0:ab12::' + r(3).toLowerCase().replace(/[^a-f0-9]/g, 'a') };
  const src = [
    `https://exemplo.invalid/cb?access_token=${v.at}&x=1`, `refresh_token=${v.rt}`, `{"client_secret": "${v.cs}"}`, `tskey-auth-k${v.ts}`, `npm_${v.npm}`, `hf_${v.hf}`,
    `sk_live_${v.sl}`, `sk_test_${v.st}`, `Cookie: sessao=${v.ck}`, `Set-Cookie: id=${v.sc}; HttpOnly`, `-----BEGIN PRIVATE KEY----- ${v.pem} -----END PRIVATE KEY-----`,
    v.ip6, `https://usuario:${v.pw}@exemplo.invalid/x`,
    `ENOENT 'D:\\Clientes\\Empresa Fulana\\proposta.pdf'`, 'C:\\Projetos\\cliente-x\\app.js', '/Volumes/Disco Externo/obra-y/planta.dwg',
  ].join('\n');
  const out = redact(src, { home: '/Users/fulano' });
  for (const [k, val] of Object.entries(v)) assert.ok(!out.includes(val), `vazou ${k}: ${out}`);
  for (const bad of ['usuario', 'Clientes', 'Empresa', 'Projetos', 'cliente-x', 'Disco', 'obra-y', 'fd7a']) assert.ok(!out.includes(bad), `vazou ${bad}: ${out}`);
  for (const keep of ['…/proposta.pdf', '…/app.js', '…/planta.dwg', 'access_token=[oculto]&x=1', '[bloco-pem]', '[chave-tailscale]', '[token-npm]', '[token-hf]', '[chave-stripe]', 'Cookie: [oculto]', '[ip-local]', 'https://[credencial]@exemplo.invalid/x'])
    assert.ok(out.includes(keep), `faltou ${keep}: ${out}`);
  // o que não é segredo continua legível
  assert.equal(redact('versão 2.1.300 · /usr/bin/git · 8.8.8.8 · ~/Documents/proj · tempo 3s', { home: '/Users/fulano' }), 'versão 2.1.300 · /usr/bin/git · 8.8.8.8 · ~/Documents/proj · tempo 3s');
});

test('redação: Windows sem diferenciar caixa e com barra normal', () => {
  const out = redact('c:\\users\\Fulano\\x e C:/Users/Fulano/y', { home: 'C:\\Users\\Fulano' });
  assert.ok(!/fulano/i.test(out), out);
});

test('log grava já redigido (nada de token mesmo se alguém logar um por engano)', () => {
  const dir = tmp(); const log = new Log({ dir, home: '/Users/fulano' });
  log.error('main', 'falhou com ' + fake('sk-ant-', 30) + ' em /Users/fulano/x');
  const text = fs.readFileSync(path.join(dir, 'bancada.log'), 'utf8');
  assert.ok(!text.includes('sk-ant-x') && !text.includes('fulano'), text);
});

test('ganchos: exceção, promessa, tela e processo filho caídos entram no log; clean-exit não', () => {
  const dir = tmp(); const log = new Log({ dir });
  const proc = new EventEmitter(); const app = new EventEmitter(); let crashOpts = null;
  attachMain(log, { app, proc, crashReporter: { start: (o) => { crashOpts = o; } } });
  assert.equal(crashOpts.uploadToServer, false);
  proc.emit('uncaughtException', new Error('bum'));
  proc.emit('unhandledRejection', 'motivo');
  app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 5 });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'oom', exitCode: 9 });
  app.emit('child-process-gone', {}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 });
  const text = fs.readFileSync(path.join(dir, 'bancada.log'), 'utf8');
  assert.match(text, /\[main\] exceção não tratada: Error: bum/);
  assert.match(text, /\[main\] promessa rejeitada sem tratamento: motivo/);
  assert.match(text, /\[tela\] processo da tela caiu: crashed \(código 5\)/);
  assert.match(text, /\[filho\] processo GPU caiu: oom/);
  assert.ok(!/clean-exit/.test(text));
});

test('erros de console da tela: formato novo (objeto) e antigo (nível 3); outros níveis ignorados', () => {
  assert.deepEqual(consoleError([{ level: 'error', message: 'm', lineNumber: 2, sourceId: 'file:///a/app.js' }]), { message: 'm', line: 2, src: 'file:///a/app.js' });
  assert.equal(consoleError([{ level: 'info', message: 'x' }]), null);
  assert.deepEqual(consoleError([{}, 3, 'velho', 9, 's.js']), { message: 'velho', line: 9, src: 's.js' });
  assert.equal(consoleError([{}, 1, 'aviso', 9, 's.js']), null);
  const dir = tmp(); const log = new Log({ dir }); const wc = new EventEmitter(); let allow = true;
  attachRenderer(log, wc, { allow: () => allow });
  wc.emit('console-message', { level: 'error', message: 'TypeError: x', lineNumber: 7, sourceId: 'file:///x/renderer/app.js' });
  allow = false; wc.emit('console-message', { level: 'error', message: 'de outra página' });
  const text = fs.readFileSync(path.join(dir, 'bancada.log'), 'utf8');
  assert.match(text, /\[tela\] TypeError: x \(app\.js:7\)/);
  assert.ok(!/outra página/.test(text));
});
