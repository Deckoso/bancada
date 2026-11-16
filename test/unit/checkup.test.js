'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkup, SUGGEST_CODEX } = require('../../app/main/checkup');

const base = { id: 'claude', name: 'Claude', installed: true, version: '2.1.0', connected: true, account: 'pessoa@exemplo.com', accountPlan: 'max', authMethod: 'claude.ai' };

test('três degraus todos ok: instalada → conectada → plano', () => {
  const c = checkup(base);
  assert.equal(c.ready, true);
  assert.deepEqual(c.steps.map(s => [s.key, s.ok]), [['installed', true], ['connected', true], ['plan', true]]);
  assert.match(c.steps[2].text, /Max/);
});

test('não instalada: para no 1º degrau e o conserto é Instalar', () => {
  const c = checkup({ ...base, installed: false, connected: null });
  assert.equal(c.ready, false); assert.equal(c.fix, 'install');
  assert.equal(c.steps.length, 1); assert.match(c.steps[0].hint, /Instalar/);
});

test('instalada sem conta: conserto é Entrar na minha conta; sem internet não acusa erro', () => {
  const c = checkup({ ...base, connected: false });
  assert.equal(c.fix, 'login'); assert.match(c.steps[1].hint, /Entrar na minha conta/);
  const n = checkup({ ...base, connected: null });
  assert.equal(n.steps[1].ok, null); assert.equal(n.fix, null);
});

test('Claude sem plano pago (ou gratuito) sugere o Codex; conta de API conta como plano', () => {
  for (const accountPlan of [null, 'free']) {
    const c = checkup({ ...base, accountPlan });
    assert.equal(c.ready, false); assert.equal(c.steps[2].ok, false);
    assert.equal(c.suggest, 'codex'); assert.equal(c.steps[2].hint, SUGGEST_CODEX);
  }
  assert.equal(checkup({ ...base, accountPlan: null, authMethod: 'console' }).ready, true);
});

test('Codex e Google: plano não é conferível daqui (neutro, não bloqueia)', () => {
  for (const id of ['codex', 'google']) {
    const c = checkup({ ...base, id, name: id, accountPlan: null, authMethod: null });
    assert.equal(c.ready, true); assert.equal(c.steps[2].ok, null);
  }
});

test('frases em português, sem termo técnico em inglês', () => {
  const all = [checkup(base), checkup({ ...base, installed: false }), checkup({ ...base, connected: false }), checkup({ ...base, accountPlan: null })]
    .flatMap(c => c.steps.flatMap(s => [s.text, s.hint || '']));
  for (const t of all) assert.doesNotMatch(t, /\b(login|logged|install|subscription|status)\b/i, t);
});

test('Checagem da voz: motor → (Windows) runtime VC++ → modelo → microfone, com o conserto de cada um', () => {
  const { voiceCheckup } = require('../../app/main/checkup');
  const base = { binary: true, model: { id: 'turbo', label: 'Preciso (≈ 550 MB)', size: 574041195, present: true, verified: true }, perm: { mic: 'granted' }, vc: { ok: true, missing: [] } };
  const ok = voiceCheckup(base, { win: false });
  assert.equal(ok.ready, true); assert.deepEqual(ok.steps.map(s => s.key), ['binary', 'model', 'mic']);
  assert.match(ok.steps[1].text, /conferido \(SHA-256\)/);
  const noBin = voiceCheckup({ ...base, binary: false });
  assert.equal(noBin.ready, false); assert.equal(noBin.steps.length, 1);
  const noModel = voiceCheckup({ ...base, model: { ...base.model, present: false, verified: false } });
  assert.equal(noModel.ready, false); assert.equal(noModel.steps.find(s => s.key === 'model').fix, 'download');
  assert.match(noModel.steps.find(s => s.key === 'model').hint, /Baixar voz \(≈ 550 MB\)/);
  const dl = voiceCheckup({ ...base, model: { ...base.model, present: false }, downloading: { got: 50, total: 200 } });
  assert.match(dl.steps.find(s => s.key === 'model').text, /25%/);
  const denied = voiceCheckup({ ...base, perm: { mic: 'denied' } });
  assert.equal(denied.ready, false); assert.equal(denied.steps.find(s => s.key === 'mic').fix, 'mic');
  assert.equal(voiceCheckup({ ...base, perm: { mic: 'not-determined' } }).ready, true);
  const win = voiceCheckup({ ...base, vc: { ok: false, missing: ['vcomp140.dll'] }, lastMs: 9000 }, { win: true });
  assert.equal(win.ready, false);
  const vc = win.steps.find(s => s.key === 'vc'); assert.equal(vc.fix, 'vc'); assert.match(vc.text, /vcomp140\.dll/);
  assert.match(win.steps.find(s => s.key === 'speed').hint, /Rápido/);
  for (const s of [...win.steps, ...ok.steps]) assert.doesNotMatch(`${s.text} ${s.hint || ''}`, /\bMac\b|Finder|⌘/);
});

test('Checagem do recorte: Gravação de Tela só lida (Mac); bloqueada explica; Windows nada a liberar', () => {
  const { shotCheckup } = require('../../app/main/checkup');
  assert.equal(shotCheckup('granted').steps[0].ok, true);
  const d = shotCheckup('denied'); assert.equal(d.ready, false); assert.equal(d.steps[0].fix, 'screen'); assert.match(d.steps[0].text, /papel de parede/);
  assert.equal(shotCheckup('not-determined').steps[0].ok, null);
  const w = shotCheckup(null, { win: true }); assert.equal(w.ready, true); assert.match(w.steps[0].text, /Ferramenta de Captura/);
  for (const x of [w, d]) for (const s of x.steps) assert.doesNotMatch(s.text, /\bMac\b|Finder|⌘/);
});
