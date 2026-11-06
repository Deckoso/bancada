'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { open } = require('../../app/main/db');
const { inspect, launchSpec, q } = require('../../app/main/engines');

function fakeEngine() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'motor-'));
  fs.mkdirSync(path.join(d, '.claude', 'commands', 'ATHENA', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'CLAUDE.md'), '# motor');
  fs.writeFileSync(path.join(d, 'VERSION'), '3.2.0\n');
  fs.writeFileSync(path.join(d, '.claude', 'commands', 'ATHENA', 'tasks', 'forge-blueprint.md'), '# /ATHENA:tasks:forge-blueprint\n\n> Pipeline completo para forjar um Blueprint');
  fs.mkdirSync(path.join(d, '.claude', 'skills', 'pentest'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'skills', 'pentest', 'SKILL.md'), '---\nname: athena-pentest\ndescription: auditoria\n---\n');
  return d;
}

test('inspect lê versão, comandos com nome de barra e skills', () => {
  const d = fakeEngine();
  const r = inspect(d);
  assert.equal(r.ok, true); assert.equal(r.version, '3.2.0'); assert.equal(r.has_claude_md, true);
  assert.deepEqual(r.commands.map(c => c.name), ['/ATHENA:tasks:forge-blueprint']);
  assert.match(r.commands[0].description, /Pipeline completo/);
  assert.ok(r.skills.some(s => s.name === 'athena-pentest' && s.scope === 'motor'));
  assert.equal(inspect(path.join(d, 'nao-existe')).ok, false);
});

test('terminal "Claude no motor": roda NA pasta do motor, focado no projeto, com sessão presa', () => {
  const d = fakeEngine();
  const s = open(':memory:');
  s.addEngine({ name: 'athena', path: d });
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj o'brien-"));
  const p = s.createProject({ name: 'loja-app', paths: [projDir] });
  s.saveTerminal({ id: 't1', project_id: p.id, name: 'claude', cwd: null, startup: 'bancada:claude' });
  const spec = launchSpec({ store: s, terminal: s.getTerminal('t1'), project: p });
  assert.equal(spec.cwd, d);
  assert.match(spec.exec, /--session-id '[0-9a-f-]{36}'/);
  assert.ok(spec.exec.includes(`--add-dir ${q(projDir)}`), 'aspas simples escapadas no caminho');
  assert.match(spec.exec, /Projeto em foco: loja-app/);
  const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'foco-'));
  const withFile = launchSpec({ store: s, terminal: s.getTerminal('t1'), project: p, promptDir: pd });
  assert.match(withFile.exec, /--append-system-prompt-file '/);
  assert.match(fs.readFileSync(path.join(pd, 't1.txt'), 'utf8'), /Projeto em foco: loja-app/);
  assert.equal((fs.statSync(path.join(pd, 't1.txt')).mode & 0o777), 0o600);
  // mesmo terminal, sessão ainda sem arquivo → reusa o mesmo id (não troca de conversa)
  s.setTerminalSession('t1', spec.sessionId);
  const again = launchSpec({ store: s, terminal: s.getTerminal('t1'), project: p });
  assert.equal(again.sessionId, spec.sessionId);
});

test('projeto com motor "none" ou motor sumido abre na pasta do projeto, com aviso', () => {
  const d = fakeEngine();
  const s = open(':memory:');
  const e = s.addEngine({ name: 'athena', path: d });
  const p = s.createProject({ name: 'live', paths: [os.tmpdir()] });
  s.saveTerminal({ id: 't2', project_id: p.id, name: 'claude', startup: 'bancada:claude' });
  s.updateProject(p.id, { engine_id: 'none' });
  let spec = launchSpec({ store: s, terminal: s.getTerminal('t2'), project: s.getProject(p.id) });
  // sem motor (modo leigo): o Claude abre DIRETO na pasta do projeto, sem aviso e sem --add-dir dela
  assert.equal(spec.cwd, os.tmpdir()); assert.match(spec.exec, /^claude --session-id/); assert.equal(spec.warning, null);
  assert.doesNotMatch(spec.exec, new RegExp(`--add-dir ${q(os.tmpdir())}`)); assert.match(spec.exec, /linguagem simples/);
  s.updateProject(p.id, { engine_id: null });
  s.updateEngine(e.id, { path: path.join(d, 'sumiu') });
  spec = launchSpec({ store: s, terminal: s.getTerminal('t2'), project: s.getProject(p.id) });
  assert.match(spec.warning, /não encontrado/); assert.equal(spec.cwd, os.tmpdir()); assert.match(spec.exec, /^claude /);
});

test('IAs pelo caminho absoluto (bins): claude, codex e agy; não instalado vira aviso', () => {
  const s = open(':memory:');
  const p = s.createProject({ name: 'leigo', paths: [os.tmpdir()] });
  s.saveTerminal({ id: 'c1', project_id: p.id, name: 'claude', startup: 'bancada:claude' });
  s.saveTerminal({ id: 'x1', project_id: p.id, name: 'codex', startup: 'bancada:codex' });
  s.saveTerminal({ id: 'g1', project_id: p.id, name: 'google', startup: 'bancada:agy' });
  const bins = { claude: '/Users/a b/.local/bin/claude', codex: '/Users/a b/.local/bin/codex', google: null };
  const c = launchSpec({ store: s, terminal: s.getTerminal('c1'), project: p, bins });
  assert.ok(c.exec.startsWith(`${q('/Users/a b/.local/bin/claude')} --session-id`));
  const x = launchSpec({ store: s, terminal: s.getTerminal('x1'), project: p, bins });
  assert.equal(x.exec, q('/Users/a b/.local/bin/codex')); assert.equal(x.cwd, os.tmpdir());
  const g = launchSpec({ store: s, terminal: s.getTerminal('g1'), project: p, bins });
  assert.equal(g.exec, undefined); assert.match(g.warning, /Assistentes de IA/);
  assert.match(launchSpec({ store: s, terminal: s.getTerminal('c1'), project: p, bins: { claude: null } }).warning, /não está instalado/);
});

test('ponte da Bancada (v0.4): mcp-config por terminal, plugin, sem limite curto e 1ª mensagem só quando pedida', () => {
  const s = open(':memory:');
  const p = s.createProject({ name: 'w', paths: [os.tmpdir()] });
  s.saveTerminal({ id: 'c9', project_id: p.id, name: 'claude', startup: 'bancada:claude' });
  const calls = [];
  const bridge = { mcpConfig: (tid, pid) => { calls.push([tid, pid]); return '/x y/cfg/c9.json'; }, pluginDir: '/x y/plugin' };
  const spec = launchSpec({ store: s, terminal: s.getTerminal('c9'), project: p, bridge, initialPrompt: "/bancada:entrevista setor d'almox" });
  assert.match(spec.exec, /^MCP_TOOL_TIMEOUT=86400000 claude /);
  assert.ok(spec.exec.includes(`--mcp-config ${q('/x y/cfg/c9.json')} --plugin-dir ${q('/x y/plugin')}`));
  assert.ok(spec.exec.endsWith(` -- ${q("/bancada:entrevista setor d'almox")}`));
  assert.deepEqual(calls, [['c9', p.id]]);
  assert.match(spec.exec, /mcp__bancada__lista/);
  const plain = launchSpec({ store: s, terminal: s.getTerminal('c9'), project: p });
  assert.doesNotMatch(plain.exec, /mcp-config|MCP_TOOL_TIMEOUT|mcp__bancada| -- /);
});

test('motor padrão: o primeiro vira padrão; remover o padrão promove outro', () => {
  const s = open(':memory:');
  const a = s.addEngine({ name: 'a', path: '/a' }); const b = s.addEngine({ name: 'b', path: '/b' });
  assert.equal(s.defaultEngine().id, a.id);
  s.setDefaultEngine(b.id); assert.equal(s.defaultEngine().id, b.id);
  s.removeEngine(b.id); assert.equal(s.defaultEngine().id, a.id);
});

test('sessão presa pela Bancada vence o classificador', () => {
  const s = open(':memory:');
  const p = s.createProject({ name: 'x' });
  s.pinSession('abc', p.id, 't1');
  assert.equal(s.pinnedProject('abc'), p.id);
  assert.equal(s.pinnedProject('zzz'), null);
});

test('reordenar projetos e itens', () => {
  const s = open(':memory:');
  const [a, b, c] = ['a', 'b', 'c'].map(n => s.createProject({ name: n }));
  s.reorderProjects([c.id, a.id, b.id]);
  assert.deepEqual(s.listProjects().filter(p => !p.system).map(p => p.name), ['c', 'a', 'b']);
  const i1 = s.createItem({ project_id: a.id, text: '1' }); const i2 = s.createItem({ project_id: a.id, text: '2' });
  s.reorderItems([i2.id, i1.id]);
  assert.deepEqual(s.listItems(a.id).map(i => i.text), ['2', '1']);
});

test('terminal com "sem permissões" abre o claude com --dangerously-skip-permissions; o normal não', () => {
  const d = fakeEngine();
  const s = open(':memory:');
  s.addEngine({ name: 'athena', path: d });
  const p = s.createProject({ name: 'x', paths: [os.tmpdir()] });
  s.saveTerminal({ id: 'n1', project_id: p.id, name: 'claude', startup: 'bancada:claude' });
  s.saveTerminal({ id: 'k1', project_id: p.id, name: 'claude ⚡', startup: 'bancada:claude', skip_perms: true });
  assert.doesNotMatch(launchSpec({ store: s, terminal: s.getTerminal('n1'), project: p }).exec, /skip-permissions/);
  assert.match(launchSpec({ store: s, terminal: s.getTerminal('k1'), project: p }).exec, / --dangerously-skip-permissions/);
});

test('launchSpec soma os hooks da Bancada (--settings) e a pasta de anexos (--add-dir)', () => {
  const d = fakeEngine();
  const s = open(':memory:');
  s.addEngine({ name: 'athena', path: d });
  const p = s.createProject({ name: 'onda', paths: [] });
  s.saveTerminal({ id: 't9', project_id: p.id, name: 'claude', cwd: null, startup: 'bancada:claude' });
  const spec = launchSpec({ store: s, terminal: s.getTerminal('t9'), project: p, hooksSettings: '/x/Application Support/Bancada/hooks/settings.json', extraDirs: ['/x/anexos'] });
  assert.ok(spec.exec.includes(`--settings ${q('/x/Application Support/Bancada/hooks/settings.json')}`));
  assert.ok(spec.exec.includes(`--add-dir ${q('/x/anexos')}`));
});
