'use strict';
// Hooks leves no Windows (v0.8): cmd.exe (forma exec) → hook.cmd (só ASCII) → Bancada em modo Node → hook.js.
// No Mac dá para provar o hook.js de verdade (o Electron como Node) e o texto exato do .cmd e do settings.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { ClaudeHooks, parseLine, clipPayload, cmdExePath, hookCmd } = require('../../app/main/hooks');
const hookJs = require('../../app/main/hook');

const WENV = { LOCALAPPDATA: 'C:\\Users\\João da Silva\\AppData\\Local', APPDATA: 'C:\\Users\\João da Silva\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\João da Silva', SystemRoot: 'C:\\Windows', 'ProgramFiles': 'C:\\Program Files' };
const EXE = 'C:\\Users\\João da Silva\\AppData\\Local\\Programs\\Bancada\\Bancada.exe';

test('caminho do executável no .cmd: prefixo por variável do Windows (acento e espaço fora do arquivo)', () => {
  assert.equal(cmdExePath(EXE, WENV), '%LOCALAPPDATA%\\Programs\\Bancada\\Bancada.exe');
  assert.equal(cmdExePath('c:\\program files\\Bancada\\Bancada.exe', WENV), '%ProgramFiles%\\Bancada\\Bancada.exe', 'sem diferenciar caixa');
  assert.equal(cmdExePath('D:\\Apps\\50%\\Bancada.exe', WENV), 'D:\\Apps\\50%%\\Bancada.exe', '% literal dobrado');
  assert.equal(cmdExePath('D:\\Programas\\Configuração\\Bancada.exe', WENV), null, 'acento sem variável → %BANCADA_EXE%');
});

test('hook.cmd: só ASCII, CRLF, liga o modo Node só dentro do setlocal, roda o hook.js ao lado com o evento', () => {
  const t = hookCmd(EXE, WENV);
  assert.match(t, /^[\x00-\x7f]*$/, 'só ASCII');
  assert.ok(t.split('\r\n').length >= 6 && !/[^\r]\n/.test(t), 'linhas com CRLF');
  assert.deepEqual(t.split('\r\n'), [
    '@echo off', 'rem Bancada: gerado automaticamente; pode apagar (e recriado).', 'setlocal DisableDelayedExpansion', 'set "ELECTRON_RUN_AS_NODE=1"',
    'set "BANCADA_RUN=%LOCALAPPDATA%\\Programs\\Bancada\\Bancada.exe"', '"%BANCADA_RUN%" "%~dp0hook.js" %1', '']);
  const t2 = hookCmd('D:\\Configuração\\Bancada.exe', WENV);
  assert.match(t2, /^[\x00-\x7f]*$/);
  assert.match(t2, /set "BANCADA_RUN=%BANCADA_EXE%"/);
});

test('executável com & ^ % ( ) ! " no caminho: hooks caem na reserva PowerShell e a barra de status não usa .cmd', () => {
  const { install } = require('../../app/main/status');
  for (const exe of ['D:\\Apps\\R&D\\Bancada.exe', 'D:\\Apps (x)\\Bancada.exe', 'D:\\Apps\\Oi!\\Bancada.exe', 'D:\\Apps\\50%\\Bancada.exe']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-exe-'));
    const h = new ClaudeHooks({ dir, win: true, exe, env: WENV }); h.setup();
    const s = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'));
    const any = Object.values(s.hooks)[0][0].hooks[0];
    assert.doesNotMatch(String(any.command), /cmd\.exe$/i, exe);
    assert.ok(!fs.existsSync(path.join(dir, 'hook.cmd')), exe);
    assert.equal(install({ dir: path.join(dir, 'st'), exe, win: true, env: WENV }), null, exe);
  }
});

test('settings.json do Windows: cmd.exe /d /c hook.cmd <Evento>, async menos o Stop; hook.js copiado ao lado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks wín '));          // espaço e acento na pasta
  const h = new ClaudeHooks({ dir, win: true, exe: EXE, env: WENV }); h.setup();
  const s = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'));
  const cmd = path.join(dir, 'hook.cmd');
  assert.ok(Object.keys(s.hooks).length >= 10);
  for (const [ev, [{ hooks: [x] }]] of Object.entries(s.hooks)) {
    assert.match(x.command, /[\\/]System32[\\/]cmd\.exe$/i);
    assert.deepEqual(x.args, ['/d', '/c', cmd, ev]);
    assert.equal(x.async, ev === 'Stop' ? undefined : true, ev);
    assert.equal(x.timeout, 10);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'hook.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../../app/main/hook.js'), 'utf8'));
  assert.equal(fs.readFileSync(cmd, 'utf8'), hookCmd(EXE, WENV));
  assert.ok(!fs.existsSync(path.join(dir, 'emit.ps1')), 'sem PowerShell por evento');
  fs.rmSync(dir, { recursive: true });
});

test('pasta com caractere que o cmd.exe não aceita entre aspas → reserva em PowerShell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a&b-'));
  const h = new ClaudeHooks({ dir, win: true, exe: EXE, env: WENV }); h.setup();
  const s = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'));
  assert.match(s.hooks.Stop[0].hooks[0].command, /powershell\.exe$/);
  fs.rmSync(dir, { recursive: true });
});

test('hook.js: mesmo corte começo + fim do emit (clipPayload) e mesmas regras de id/evento', () => {
  for (const p of ['{}', '{"a":"' + 'x'.repeat(7990) + '"}', '{"a":"' + 'é'.repeat(9000) + '","background_tasks":[]}', 'linha\r\nquebrada']) assert.equal(hookJs.clip(p), clipPayload(p));
  assert.equal(hookJs.valid('t-1_A', 'PreToolUse'), true);
  assert.equal(hookJs.valid('../x', 'Stop'), false);
  assert.equal(hookJs.valid('t1', 'Stop;rm'), false);
  assert.equal(hookJs.valid(undefined, 'Stop'), false);
});

test('hook.js de verdade (Electron como Node, como o hook.cmd roda): grava a linha que a Bancada lê', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookjs-'));
  fs.mkdirSync(path.join(dir, 'events'));
  fs.copyFileSync(path.join(__dirname, '../../app/main/hook.js'), path.join(dir, 'hook.js'));
  const big = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'x'.repeat(12000) }, background_tasks: [{ id: 'bg123456', type: 'shell', status: 'running', description: 'npm test' }] };
  const run = (id, ev, input) => execFileSync(process.execPath, [path.join(dir, 'hook.js'), ev], { input, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BANCADA_TERM_ID: id }, encoding: 'utf8' });
  const t0 = Date.now();
  assert.equal(run('tW1', 'PreToolUse', JSON.stringify(big)), '', 'nada no stdout');
  run('tW1', 'Stop', JSON.stringify({ background_tasks: big.background_tasks }));
  run('../fora', 'Stop', '{}');
  run('tW1', 'Evil;x', '{}');
  const lines = fs.readFileSync(path.join(dir, 'events', 'tW1.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const a = parseLine(lines[0]); const b = parseLine(lines[1]);
  assert.equal(a.event, 'PreToolUse'); assert.equal(a.tool, 'Bash'); assert.ok(a.at >= t0 - 5 && a.at <= Date.now(), 'carimbo em ms');
  assert.ok(lines[0].length < 8200, 'cortado');
  assert.equal(b.event, 'Stop'); assert.deepEqual(b.bg_tasks.map(t => t.id), ['bg123456']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'events')), ['tW1.log']);
  fs.rmSync(dir, { recursive: true });
});
