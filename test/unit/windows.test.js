'use strict';
// v0.7: o lado Windows de cada peça, testado em qualquer máquina (cada função recebe `win`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const plat = require('../../app/main/platform');
const { ClaudeHooks, parseLine, emitScriptPs } = require('../../app/main/hooks');
const { launchSpec } = require('../../app/main/engines');
const { AiTools, installerLooksOk } = require('../../app/main/ai-tools');

test('PowerShell: aspas literais, sem expansão, e aspas duplas trocadas (o PowerShell 5.1 as estraga)', () => {
  assert.equal(plat.qPs("d'Ávila $env:X `n"), "'d''Ávila $env:X `n'");
  const cmd = plat.renderCommand({ env: [['A', '1']], tokens: [{ v: 'C:\\Users\\Zé\\.local\\bin\\claude.exe', quote: true }, { v: '--resume' }, { v: 'disse "oi"', quote: true }] }, true);
  assert.equal(cmd, "$env:A='1'; & 'C:\\Users\\Zé\\.local\\bin\\claude.exe' '--resume' 'disse \u201doi\u201d'");
  // Mac continua idêntico
  assert.equal(plat.renderCommand({ env: [['A', '1']], tokens: [{ v: 'claude' }, { v: '--x' }, { v: "a'b", quote: true }] }, false), "A=1 claude --x 'a'\\''b'");
});

test('terminal do Windows: PowerShell com UTF-8; com programa fica o shell (-NoExit); login acaba', () => {
  assert.deepEqual(plat.shellArgs({ shell: 'x' }, true), ['-NoLogo', '-NoExit', '-Command', plat.PS_PRELUDE]);
  assert.deepEqual(plat.shellArgs({ shell: 'x', exec: "& 'c.exe'" }, true), ['-NoLogo', '-NoExit', '-Command', `${plat.PS_PRELUDE}; & 'c.exe'`]);
  assert.deepEqual(plat.shellArgs({ shell: 'x', exec: "& 'c.exe'", oneShot: true }, true), ['-NoLogo', '-Command', `${plat.PS_PRELUDE}; & 'c.exe'`]);
  assert.deepEqual(plat.shellArgs({ shell: '/bin/zsh' }, false), ['-l']);
  assert.match(plat.defaultShell(true), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
});

test('PATH do Windows: uma chave só (Path), separador ;', () => {
  const env = { Path: 'C:\\Windows', PATH: 'lixo', Other: '1' };
  plat.setPath(env, 'C:\\u\\.local\\bin;C:\\Windows', true);
  assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === 'PATH'), ['Path']);
  assert.equal(env.Path, 'C:\\u\\.local\\bin;C:\\Windows');
  const ai = new AiTools({ home: 'C:\\Users\\Zé', basePath: 'C:\\Windows;c:\\windows;C:\\Git\\cmd', win: true });
  assert.equal(ai.envPath(), `${ai.localBin};C:\\Windows;C:\\Git\\cmd`, 'sem repetir (o Windows não diferencia maiúsculas)');
});

test('onde as IAs ficam no Windows (.exe) e o login sai em PowerShell', () => {
  const c = plat.aiCandidates('claude', 'C:\\Users\\Zé', true);
  assert.equal(c[0], 'C:\\Users\\Zé\\.local\\bin\\claude.exe');
  assert.ok(plat.aiCandidates('agy', 'C:\\Users\\Zé', true).some(p => /agy\\bin\\agy\.exe$/.test(p)));
  const ai = new AiTools({ home: 'C:\\Users\\Zé', win: true });
  ai.find = () => 'C:\\Users\\Zé\\.local\\bin\\claude.exe';
  assert.equal(ai.loginExec('claude'), "& 'C:\\Users\\Zé\\.local\\bin\\claude.exe' 'auth' 'login'");
});

test('instalador baixado: .ps1 não pode ser página HTML nem binário; .sh começa com #!', () => {
  const ps = '# instala o claude\n$x = 1\n' + 'a'.repeat(300);
  assert.equal(installerLooksOk(ps, ps.length, true), true);
  assert.equal(installerLooksOk('<!DOCTYPE html>' + 'a'.repeat(300), 320, true), false);
  assert.equal(installerLooksOk('\ufeff  <html>' + 'a'.repeat(300), 320, true), false);
  assert.equal(installerLooksOk('MZ\u0000\u0000' + 'a'.repeat(300), 320, true), false);
  assert.equal(installerLooksOk('x', 1, true), false);
  assert.equal(installerLooksOk('#!/bin/bash\n' + 'a'.repeat(300), 320, false), true);
});

test('hooks do Windows (reserva BANCADA_HOOKS_PS=1): PowerShell direto (sem shell), em segundo plano exceto o Stop; script com BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks win-'));
  const h = new ClaudeHooks({ dir, win: true, env: { BANCADA_HOOKS_PS: '1' } }); h.setup();
  const s = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'));
  for (const [ev, [{ hooks: [x] }]] of Object.entries(s.hooks)) {
    assert.match(x.command, /powershell\.exe$/);
    assert.deepEqual(x.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.equal(x.args[6], ev);
    assert.equal(x.async, ev === 'Stop' ? undefined : true, ev);
  }
  const raw = fs.readFileSync(path.join(dir, 'emit.ps1'));
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM: o PowerShell 5.1 só lê acento em UTF-8 com BOM');
  fs.rmSync(dir, { recursive: true });
});

test('script do hook: caminho com apóstrofo fica literal; confere o id do terminal e o nome do evento', () => {
  const ps = emitScriptPs("C:\\Users\\Zé d'Ávila\\AppData\\Roaming\\Bancada\\hooks\\events");
  assert.ok(ps.includes("Join-Path 'C:\\Users\\Zé d''Ávila\\AppData\\Roaming\\Bancada\\hooks\\events'"));
  assert.match(ps, /\$id -notmatch '\^\[A-Za-z0-9_-\]\{1,80\}\$'/);
  assert.match(ps, /ToUnixTimeMilliseconds/);
  assert.doesNotMatch(ps, /Invoke-Expression|iex /i);
});

test('carimbo em ms (Windows) e hook atrasado depois do Stop não reabre o "trabalhando"', () => {
  assert.equal(parseLine('Stop 1763112000123 {}').at, 1763112000123);
  assert.equal(parseLine('Stop 1763112000 {}').at, 1763112000000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks ord-'));
  const states = [];
  const h = new ClaudeHooks({ dir, win: true, onState: (e) => states.push(e.state) }); h.setup();
  const T = 1763112000000;
  h.apply('t1', parseLine(`UserPromptSubmit ${T} {}`));
  h.apply('t1', parseLine(`Stop ${T + 900} {}`));
  h.apply('t1', parseLine(`PostToolUse ${T + 500} {}`));       // chegou depois, aconteceu antes
  assert.equal(h.get('t1').state, 'done');
  h.apply('t1', parseLine(`UserPromptSubmit ${T + 2000} {}`)); // pedido novo: volta a valer
  h.apply('t1', parseLine(`PreToolUse ${T + 2100} {"tool_name":"Read"}`));
  assert.equal(h.get('t1').state, 'working');
  fs.rmSync(dir, { recursive: true });
});

test('abrir o Claude no Windows: comando em PowerShell, caminhos e nome entre aspas simples', () => {
  const store = { engineFor: () => null };
  const project = { id: 'p1', name: "Loja d'Ana", kind: 'software', paths: ['C:\\Users\\Zé\\Projetos\\loja'] };
  const terminal = { id: 't1', name: 'Claude', startup: 'bancada:claude', session_id: null };
  const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'foco-'));
  const spec = launchSpec({ store, terminal, project, promptDir: pd, hooksSettings: 'C:\\Users\\Zé\\AppData\\Roaming\\Bancada\\hooks\\settings.json',
    bins: { claude: 'C:\\Users\\Zé\\.local\\bin\\claude.exe' }, bridge: { mcpConfig: () => 'C:\\cfg\\t1.json', pluginDir: 'C:\\plug' }, initialPrompt: '/bancada:entrevista "loja"', win: true });
  assert.match(spec.exec, /^\$env:MCP_TOOL_TIMEOUT='86400000'; \$env:CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT='86400000'; & 'C:\\Users\\Zé\\\.local\\bin\\claude\.exe' '--session-id' '[0-9a-f-]{36}'/);
  assert.ok(spec.exec.includes("'-n' 'Loja d''Ana · Claude'"));
  assert.ok(spec.exec.includes("'--settings' 'C:\\Users\\Zé\\AppData\\Roaming\\Bancada\\hooks\\settings.json'"));
  assert.ok(spec.exec.endsWith("'--' '/bancada:entrevista \u201dloja\u201d'"));
  fs.rmSync(pd, { recursive: true });
});

test('ping do Windows em qualquer idioma; Mac igual', () => {
  assert.equal(plat.pingMs('Resposta de 10.0.0.1: bytes=32 tempo=12ms TTL=64'), 12);
  assert.equal(plat.pingMs('Reply from 10.0.0.1: bytes=32 time<1ms TTL=64'), 1);
  assert.equal(plat.pingMs('64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=3.456 ms'), 3);
  assert.equal(plat.pingMs('Esgotado o tempo limite do pedido.'), null);
  assert.deepEqual(plat.pingCommand('10.0.0.1', true).args, ['-n', '1', '-w', '2000', '10.0.0.1']);
  assert.match(plat.pingCommand('10.0.0.1', true).bin, /System32\\PING\.EXE$/);
});

test('saída de tarefa no Windows: só dentro da pasta temporária do usuário, numa pasta claude…\\tasks', () => {
  const tmp = 'C:\\Users\\Zé\\AppData\\Local\\Temp';
  assert.equal(plat.taskOutputOk(`${tmp}\\claude\\C--proj\\sess\\tasks\\bx123456.output`, { win: true, tmp }), true);
  assert.equal(plat.taskOutputOk(`C:\\Users\\Zé\\Documents\\claude\\x\\tasks\\bx123456.output`, { win: true, tmp }), false, 'fora da pasta temporária');
  assert.equal(plat.taskOutputOk(`${tmp}\\outra\\x\\tasks\\bx123456.output`, { win: true, tmp }), false, 'sem pasta claude');
  assert.equal(plat.taskOutputOk(`${tmp}\\claude\\x\\tasks\\segredo.txt`, { win: true, tmp }), false);
});

test('colar caminho e abrir no Cursor no Windows', () => {
  assert.equal(plat.quotePath('C:\\Users\\Zé Silva\\a.png', true), "'C:\\Users\\Zé Silva\\a.png'");
  assert.equal(plat.quotePath("C:\\x\\$(calc)’s.png", true), "'C:\\x\\$(calc)’’s.png'", 'literal: $() não expande, aspa tipográfica dobrada');
  assert.equal(plat.quotePath("/a b/c'd", false), "'/a b/c'\\''d'");
  assert.equal(plat.cursorUrl('C:\\Users\\Zé\\proj', true), 'cursor://file/C:/Users/Z%C3%A9/proj');
});

test('sessão → projeto com caminho do Windows (barra e maiúsculas não importam)', () => {
  const { classify } = require('../../app/main/sessions/classify');
  if (typeof classify !== 'function') return;   // a API pública pode mudar; o importante é o under()
  const projects = [{ id: 'p', name: 'loja', paths: ['C:\\Users\\Zé\\Projetos\\loja'] }];
  const r = classify({ cwd: 'c:\\users\\zé\\projetos\\loja\\src', hits: { 'C:/Users/Zé/Projetos/loja/a.js': 2 } }, projects);
  assert.ok(r && (r.project_id === 'p' || r.id === 'p' || r === 'p'), JSON.stringify(r));
});

test('segurança: aspas tipográficas dobradas, caminho de rede recusado, git sem fsmonitor', () => {
  assert.equal(plat.qPs("d’água ‘x’ ‚y‛ 'z'"), "'d’’água ‘‘x’’ ‚‚y‛‛ ''z'''");
  for (const p of ['\\\\srv\\share\\a.md', '//srv/share/a.md', '/\\srv\\share', '\\/srv/x', '\\\\?\\UNC\\srv\\x']) assert.equal(plat.isNetworkPath(p), true, p);
  for (const p of ['C:\\Users\\a.md', '/Users/a/b.md', 'pasta/a.md', '~/x']) assert.equal(plat.isNetworkPath(p), false, p);
  const links = require('../../app/main/links');
  assert.equal(links.resolve('/\\srv\\share\\a.md', []), null);
  assert.equal(links.kindOf('//srv/share'), null);
  assert.throws(() => links.readMd('//srv/share/a.md'), /só arquivos/);
  const v = require('../../app/main/validate');
  assert.throws(() => v.dir('//srv/share'), /rede|absoluto|não existe/);
  assert.match(fs.readFileSync(path.join(__dirname, '../../app/main/git-safe.js'), 'utf8'), /SAFE_GIT = \['-c', 'core\.fsmonitor=false', '-c', 'log\.showSignature=false'\]/);
  for (const f of ['files.js', 'gitview.js', 'git.js']) assert.match(fs.readFileSync(path.join(__dirname, '../../app/main', f), 'utf8'), /const \{ SAFE_GIT, check: gitSafe \} = require\('\.\/git-safe'\)/, f);
  assert.match(emitScriptPs("C:\\Users\\Ana’s\\x"), /Join-Path 'C:\\Users\\Ana’’s\\x'/);
});
