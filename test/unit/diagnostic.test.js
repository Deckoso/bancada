'use strict';
// "Relatar problema": o relatório sai limpo mesmo quando a entrada tem segredo (tokens FALSOS montados aqui).
const test = require('node:test');
const assert = require('node:assert');
const { buildReport } = require('../../app/main/diagnostic');
const { BLOCKED } = require('../../app/main/remote');

const rep = (c, n) => c.repeat(n);
const FAKE = {
  sk: 'sk-ant-api03-' + rep('A', 40), ghp: 'ghp_' + rep('b', 36), xox: 'xoxp-' + rep('7', 24),
  jwt: ['eyJ' + rep('h', 16), rep('p', 20), rep('s', 20)].join('.'), mail: 'pessoa.teste@exemplo.org',
};
const home = '/Users/pessoa';

function sample() {
  return {
    version: '0.8.0', packaged: true, platform: 'darwin', release: '25.0.0', arch: 'arm64', electron: '45.3.2', locale: 'pt-BR', uptimeMin: 12, crashes: 1,
    ais: [
      { id: 'claude', name: 'Claude', installed: true, version: '2.1.300', connected: true, account: FAKE.mail, accountPlan: 'max', path: home + '/.local/bin/claude',
        checkup: { ready: true, steps: [{ key: 'installed', ok: true }, { key: 'connected', ok: true }, { key: 'plan', ok: true }] } },
      { id: 'codex', name: 'Codex', installed: true, version: '0.170.0', connected: false, account: null, checkup: { ready: false, steps: [{ key: 'installed', ok: true }, { key: 'connected', ok: false }] } },
      { id: 'google', name: 'Google', installed: false },
    ],
    feedback: [{ kind: 'week', answer: 'boa', note: 'mandei ' + FAKE.ghp + ' sem querer', at: Date.UTC(2026, 10, 13, 17) }],
    logLines: [
      '2026-11-16 10:00:00.000 info  [main] Bancada 0.8.0 aberta',
      `2026-11-16 10:01:00.000 error [main] falhou ${FAKE.sk} em ${home}/Documents/proj (192.168.1.20)`,
      `2026-11-16 10:02:00.000 error [tela] TypeError com ${FAKE.jwt} e ${FAKE.xox} de ${FAKE.mail}`,
    ],
  };
}

test('relatório: versões, IAs com a Checagem e registro — sem conta, sem caminho, sem token', () => {
  const t = buildReport(sample(), { home });
  assert.match(t, /Bancada 0\.8\.0 · Electron 45\.3\.2/);
  assert.match(t, /Sistema: darwin 25\.0\.0 arm64 · pt-BR/);
  assert.match(t, /- Claude: versão 2\.1\.300 · conectado · plano max · Checagem: pronto \(installed=ok connected=ok plan=ok\)/);
  assert.match(t, /- Codex: versão 0\.170\.0 · não conectado · Checagem: falta algo \(installed=ok connected=falta\)/);
  assert.match(t, /- Google: não instalado/);
  assert.match(t, /semana: boa — "mandei \[token-github\] sem querer"/);
  assert.match(t, /Registro \(últimas 3 linhas\)/);
  assert.match(t, /Relatórios de travamento guardados: 1/);
  for (const v of Object.values(FAKE)) assert.ok(!t.includes(v), 'vazou ' + v);
  for (const bad of ['pessoa', '192.168', '.local/bin', 'eyJh']) assert.ok(!t.includes(bad), 'vazou ' + bad);
  assert.match(t, /~\/Documents\/proj/);
});

test('relatório sem IAs e sem registro não quebra; tamanho tem teto', () => {
  const t = buildReport({ ais: null, logLines: [] }, { home });
  assert.match(t, /não deu para conferir agora/); assert.match(t, /\(vazio\)/);
  const big = buildReport({ logLines: Array.from({ length: 150 }, (_, i) => 'x'.repeat(590) + i) }, { home });
  assert.ok(big.length <= 60 * 1024 + 10, String(big.length));
});

test('relatar problema é só no computador (canal bloqueado no remoto)', () => {
  assert.ok(BLOCKED.has('diag:report'));
});
