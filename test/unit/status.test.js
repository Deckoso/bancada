'use strict';
// Medidor de limite: barra de status encadeada (a do usuário continua aparecendo; os arquivos dele nunca são tocados).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const { install, aggregate, Limits, winCommand } = require('../../app/main/status');
const { handle, limitsOf, userStatusLine } = require('../../app/main/status-line');
const { ClaudeHooks } = require('../../app/main/hooks');

// JSON de exemplo da documentação da statusLine (recortado)
const SAMPLE = { model: { display_name: 'Opus' }, workspace: { current_dir: '/x', project_dir: '/x' }, cwd: '/x',
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } };
const tmp = (p = 'bancada-st-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup() {
  const root = tmp(); const home = path.join(root, 'home'); const proj = path.join(root, 'proj'); const hooks = path.join(root, 'data', 'hooks');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const sl = install({ dir: hooks, exe: process.execPath, win: false });
  const data = { ...SAMPLE, cwd: proj, workspace: { current_dir: proj, project_dir: proj } };
  const env = { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', BANCADA_TERM_ID: 'tA1' };
  const run = (d = data, e = env) => spawnSync('/bin/sh', ['-c', sl.command], { input: JSON.stringify(d), env: e, encoding: 'utf8', timeout: 15000 });
  return { root, home, proj, hooks, sl, data, env, run };
}

test('rate_limits: lê as duas janelas; janela faltando ou sem número não inventa', () => {
  assert.deepEqual(limitsOf(SAMPLE), { five_hour: { pct: 23.5, resets_at: 1738425600 }, seven_day: { pct: 41.2, resets_at: 1738857600 } });
  assert.deepEqual(limitsOf({ rate_limits: { seven_day: { used_percentage: 5 } } }), { five_hour: null, seven_day: { pct: 5, resets_at: null } });
  assert.equal(limitsOf({}), null); assert.equal(limitsOf({ rate_limits: { five_hour: { used_percentage: 'x' } } }), null);
});

test('statusLine do Mac: Electron como Node; sem barra do usuário → linha curta própria; grava os números por terminal', () => {
  const s = setup();
  assert.match(s.sl.command, /^ELECTRON_RUN_AS_NODE=1 '.+' '.+status-line\.js'$/);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Opus · limite 5 h 24% · semana 41%\n');
  const saved = JSON.parse(fs.readFileSync(path.join(s.hooks, 'limits', 'tA1.json'), 'utf8'));
  assert.deepEqual(saved.five_hour, { pct: 23.5, resets_at: 1738425600 });
  assert.equal(saved.account, 'padrao');
  // id de terminal estranho: não grava fora da pasta
  s.run(s.data, { ...s.env, BANCADA_TERM_ID: '../x' });
  assert.deepEqual(fs.readdirSync(path.join(s.hooks, 'limits')), ['tA1.json']);
});

test('encadeia a barra do usuário (mesma entrada, sem o modo Node) e nunca mexe no settings dele', () => {
  const s = setup();
  const userFile = path.join(s.home, '.claude', 'settings.json');
  const userCfg = JSON.stringify({ statusLine: { type: 'command', command: 'printf "USUARIO[%s] " "${ELECTRON_RUN_AS_NODE:-livre}"; cat | head -c 30' }, model: 'x' });
  fs.writeFileSync(userFile, userCfg);
  const before = fs.statSync(userFile).mtimeMs;
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'USUARIO[livre] ' + JSON.stringify(s.data).slice(0, 30) + '\n');
  assert.equal(fs.readFileSync(userFile, 'utf8'), userCfg); assert.equal(fs.statSync(userFile).mtimeMs, before);
  assert.ok(fs.existsSync(path.join(s.hooks, 'limits', 'tA1.json')), 'grava os números mesmo encadeando');
});

test('só a barra do PRÓPRIO usuário: a do .claude/ da pasta do projeto nunca roda; settings.local.json do usuário > settings.json', () => {
  const s = setup();
  const marca = path.join(s.root, 'projeto-rodou');
  fs.writeFileSync(path.join(s.proj, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `touch "${marca}"; echo PROJETO` } }));
  fs.writeFileSync(path.join(s.proj, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: `touch "${marca}"; echo LOCAL-PROJETO` } }));
  assert.equal(s.run().stdout, 'Opus · limite 5 h 24% · semana 41%\n', 'sem barra do usuário: linha própria, nunca a do projeto');
  assert.equal(fs.existsSync(marca), false, 'o comando da pasta do projeto não rodou');
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo USUARIO' } }));
  assert.equal(s.run().stdout, 'USUARIO\n');
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo USUARIO-LOCAL' } }));
  assert.equal(s.run().stdout, 'USUARIO-LOCAL\n');
  assert.equal(fs.existsSync(marca), false);
  // current_dir/cwd também não: só o settings do usuário conta, qualquer que seja a pasta
  const d2 = { ...s.data, workspace: { current_dir: s.proj }, cwd: s.proj };
  assert.equal(s.run(d2).stdout, 'USUARIO-LOCAL\n'); assert.equal(fs.existsSync(marca), false);
  // HOME/CLAUDE_CONFIG_DIR apontando para dentro do projeto (bloco "env" de um settings de projeto) → ignorados
  assert.equal(userStatusLine([s.proj], { HOME: s.home, CLAUDE_CONFIG_DIR: path.join(s.proj, '.claude') }).command, 'echo USUARIO-LOCAL');
  assert.notEqual((userStatusLine([s.proj], { HOME: s.proj }) || {}).file, path.join(s.proj, '.claude', 'settings.local.json'));
});

test('disableAllHooks do usuário: nada encadeado', () => {
  const s = setup();
  const marca = path.join(s.root, 'usuario-rodou');
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true, statusLine: { type: 'command', command: `touch "${marca}"; echo U` } }));
  assert.equal(s.run().stdout, 'Opus · limite 5 h 24% · semana 41%\n'); assert.equal(fs.existsSync(marca), false);
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `touch "${marca}"; echo U` } }));
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }));
  assert.equal(s.run().stdout, 'Opus · limite 5 h 24% · semana 41%\n'); assert.equal(fs.existsSync(marca), false);
});

test('estouro do tempo mata a árvore toda (o comando e os filhos), sem órfãos', { skip: process.platform === 'win32' }, () => {
  const s = setup();
  const tag = `bancada-teste-orfao-${process.pid}`;
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `sh -c 'exec -a ${tag} sleep 20' & sleep 20; echo X` } }));
  const r = s.run();
  assert.equal(r.stdout, 'Opus · limite 5 h 24% · semana 41%\n');
  const left = spawnSync('/usr/bin/pgrep', ['-f', tag], { encoding: 'utf8' }).stdout.trim();
  if (left) spawnSync('/usr/bin/pkill', ['-f', tag]);
  assert.equal(left, '', 'nenhum filho sobrou');
});

test('barra do usuário lenta (timeout curto) ou que aponta para a nossa → linha própria, sem laço', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'sleep 6; echo TARDE' } }));
  const t0 = Date.now(); const r = s.run();
  assert.ok(Date.now() - t0 < 5000, 'não espera a barra lenta');
  assert.equal(r.stdout, 'Opus · limite 5 h 24% · semana 41%\n');
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: s.sl.command } }));
  assert.equal(s.run().stdout, 'Opus · limite 5 h 24% · semana 41%\n');
  // já dentro de uma cadeia: não encadeia de novo
  const out = await handle(JSON.stringify(s.data), { dir: s.hooks, env: { ...s.env, BANCADA_STATUSLINE_CHAIN: '1' } });
  assert.equal(out, 'Opus · limite 5 h 24% · semana 41%\n');
});

test('entrada sem rate_limits ou inválida: não grava, não quebra', async () => {
  const dir = tmp();
  assert.equal(await handle('não é json', { dir, env: { BANCADA_TERM_ID: 't1', BANCADA_STATUSLINE_CHAIN: '1' } }), 'Bancada\n');
  assert.equal(await handle(JSON.stringify({ model: { display_name: 'Sonnet' } }), { dir, env: { BANCADA_TERM_ID: 't1', BANCADA_STATUSLINE_CHAIN: '1' } }), 'Sonnet\n');
  assert.ok(!fs.existsSync(path.join(dir, 'limits')));
});

test('leitura na Bancada: a mais recente por conta; janela que já virou some; sem dado → vazio', () => {
  const now = 1_800_000_000_000;
  const fut = now / 1000 + 3600;
  const r = aggregate([
    { five_hour: { pct: 10, resets_at: fut }, seven_day: { pct: 30, resets_at: fut + 86400 }, at: now - 60000, account: 'padrao' },
    { five_hour: { pct: 62.4, resets_at: fut }, seven_day: { pct: 41, resets_at: now / 1000 - 1 }, at: now - 1000, account: 'padrao' },
    { five_hour: { pct: 90, resets_at: now / 1000 - 5 }, seven_day: null, at: now, account: 'outra' },
  ], now);
  assert.deepEqual(r, { accounts: [{ account: 'padrao', five_hour: { pct: 62, resets_at: fut }, seven_day: null, at: now - 1000 }] });
  assert.deepEqual(aggregate([], now), { accounts: [] });

  const real = Date.now(); const rfut = real / 1000 + 3600;
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'limits'));
  fs.writeFileSync(path.join(dir, 'limits', 't1.json'), JSON.stringify({ five_hour: { pct: 81, resets_at: rfut }, at: real, account: 'padrao' }));
  fs.writeFileSync(path.join(dir, 'limits', 'velho.json'), '{}');
  fs.utimesSync(path.join(dir, 'limits', 'velho.json'), new Date(real - 9 * 86400000), new Date(real - 9 * 86400000));
  const seen = []; const L = new Limits({ dir, now: () => real, onChange: (x) => seen.push(x) });
  L.read(); L.read();
  assert.equal(seen.length, 1, 'só avisa quando muda');
  assert.equal(L.list().accounts[0].five_hour.pct, 81);
  assert.ok(!fs.existsSync(path.join(dir, 'limits', 'velho.json')), 'arquivo de mais de 8 dias apagado');
});

test('Windows: statusLine é o caminho do .cmd com barras normais e ~ (serve no Git Bash e no PowerShell); .cmd só ASCII', () => {
  const env = { USERPROFILE: 'C:\\Users\\João Silva', LOCALAPPDATA: 'C:\\Users\\João Silva\\AppData\\Local', APPDATA: 'C:\\Users\\João Silva\\AppData\\Roaming' };
  assert.equal(winCommand('C:\\Users\\João Silva\\AppData\\Roaming\\Bancada\\hooks\\status-line.cmd', env), '~/AppData/Roaming/Bancada/hooks/status-line.cmd');
  assert.equal(winCommand('D:\\Dados\\Bancada\\hooks\\status-line.cmd', env), 'D:/Dados/Bancada/hooks/status-line.cmd');
  assert.equal(winCommand('D:\\Meus Dados\\status-line.cmd', env), null, 'espaço fora do home: sem medidor');
  const dir = tmp('st win-');
  install({ dir, exe: 'C:\\Users\\João Silva\\AppData\\Local\\Programs\\Bancada\\Bancada.exe', win: true, env });
  const cmd = fs.readFileSync(path.join(dir, 'status-line.cmd'), 'utf8');
  assert.match(cmd, /^[\x00-\x7f]*$/);
  assert.match(cmd, /set "BANCADA_RUN=%LOCALAPPDATA%\\Programs\\Bancada\\Bancada\.exe"\r\n"%BANCADA_RUN%" "%~dp0status-line\.js"\r\n$/);
});

test('settings.json da Bancada leva o statusLine junto dos hooks', () => {
  const dir = tmp();
  const sl = install({ dir, exe: '/Applications/Bancada.app/Contents/MacOS/Bancada', win: false });
  const h = new ClaudeHooks({ dir, win: false, extra: () => ({ statusLine: sl }) }); h.setup();
  const s = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'));
  assert.deepEqual(s.statusLine, sl);
  assert.ok(s.hooks.Stop && s.permissions);
});

test('tela: medidor âmbar a partir de 80%, nunca vermelho; some sem dado', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../app/renderer/styles.css'), 'utf8');
  const rules = css.split('\n').filter(l => /limits/.test(l));
  assert.ok(rules.some(l => /\.limits-row\.warn \{ color: var\(--amber\)/.test(l)));
  assert.ok(!rules.some(l => /--err|red|#f[0-9a-f]{2}3/i.test(l)), 'nada de vermelho');
  const js = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  assert.match(js, /const hot = w\.pct >= 80;/);
  assert.match(js, /el\.classList\.toggle\('hidden', !rows\.length\)/);
});
