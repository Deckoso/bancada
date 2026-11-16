'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { open } = require('../../app/main/db');
const { Feedback, fridayOf, weekWindow } = require('../../app/main/feedback');
const { buildReport } = require('../../app/main/diagnostic');

function mk(start, { busy = false } = {}) {
  const store = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-fb-')), 'b.db'));
  const clock = { t: start.getTime() };
  const st = { busy };
  const cards = [];
  const fb = new Feedback({ store, busy: () => st.busy, onChange: (c) => cards.push(c), now: () => new Date(clock.t) });
  fb.lastBusyAt = clock.t;   // como o start(): recém-aberto não é pausa
  const adv = (ms) => { clock.t += ms; return fb.tick(); };
  return { fb, store, clock, st, cards, adv };
}
const MIN = 60000;

test('semana: sexta é a âncora; janela de sexta 16h até domingo', () => {
  assert.equal(fridayOf(new Date(2026, 10, 15, 10)).getDate(), 13);   // domingo 15/11 → sexta 13/11
  assert.equal(fridayOf(new Date(2026, 10, 13, 17)).getDate(), 13);
  assert.equal(weekWindow(new Date(2026, 10, 13, 15, 59)), false);
  assert.equal(weekWindow(new Date(2026, 10, 13, 16, 0)), true);
  assert.equal(weekWindow(new Date(2026, 10, 14, 9)), true);
  assert.equal(weekWindow(new Date(2026, 10, 16, 17)), false);         // segunda
});

test('"Como foi a semana?": só sexta depois das 16h, só numa pausa de 2 min, 1× por semana', () => {
  const { fb, st, adv, cards } = mk(new Date(2026, 10, 13, 15, 50));
  assert.equal(adv(MIN), null, 'antes das 16h');
  st.busy = true; assert.equal(adv(15 * MIN), null, 'trabalhando');    // 16:06, terminal trabalhando
  st.busy = false; assert.equal(adv(MIN), null, 'pausa de só 1 min');
  const c = adv(MIN + 1000);
  assert.equal(c && c.kind, 'week');
  assert.equal(cards.length, 1);
  fb.answer('week', 'boa', '  tudo certo  ');
  assert.equal(fb.current(), null);
  assert.equal(adv(60 * MIN), null, 'mesma semana não repete');
  assert.equal(adv(24 * 60 * MIN), null, 'sábado: mesma semana');
  assert.deepEqual(fb.list().map(x => [x.kind, x.answer, x.note]), [['week', 'boa', 'tudo certo']]);
});

test('semana: "Agora não" também conta como perguntado; a semana seguinte pergunta de novo', () => {
  const { fb, adv } = mk(new Date(2026, 10, 13, 17));
  assert.equal(adv(3 * MIN).kind, 'week');
  fb.dismiss('week');
  assert.equal(adv(5 * MIN), null);
  assert.equal(adv(7 * 24 * 60 * MIN).kind, 'week', 'sexta seguinte');
  assert.equal(fb.list().length, 0, 'dispensar não grava resposta');
});

test('"Travou?": depois de um erro, fora de trabalho, no máximo 1 por dia', () => {
  const { fb, st, adv } = mk(new Date(2026, 10, 16, 10));
  assert.equal(adv(MIN), null);
  st.busy = true; fb.onError();
  assert.equal(adv(MIN), null, 'espera parar de trabalhar');
  st.busy = false;
  assert.equal(adv(MIN).kind, 'crash');
  fb.answer('crash', 'travou', 'a tela ficou branca');
  fb.onError(); assert.equal(adv(MIN), null, 'segundo erro no mesmo dia: sem cartão');
  fb.onError(); assert.equal(adv(24 * 60 * MIN).kind, 'crash', 'dia seguinte');
});

test('respostas validadas e com teto; entram no relatório', () => {
  const { fb } = mk(new Date(2026, 10, 16, 10));
  assert.throws(() => fb.answer('week', 'ótima'), /inválida/);
  assert.throws(() => fb.answer('outro', 'boa'), /inválida/);
  for (let i = 0; i < 230; i++) fb.answer('week', 'ruim', 'n' + i);
  assert.equal(fb.store.db.prepare('SELECT COUNT(*) n FROM feedback').get().n, 200);
  const t = buildReport({ feedback: fb.list(3) }, { home: '/Users/ninguem' });
  assert.match(t, /semana: ruim — "n229"/);
});

test('resumo por IA herdado da 0.7 (ligado, nunca perguntado): pergunta UMA vez; valor mantido até responder', () => {
  const a = mk(new Date(2026, 10, 16, 10));
  a.store.kvSet('ai_summary', true);                          // como o initAiSummary faz para quem já tinha banco
  assert.equal(a.adv(MIN).kind, 'summary');
  assert.equal(a.store.kvGet('ai_summary'), true, 'até responder, continua ligado');
  a.fb.dismiss('summary');                                    // "Agora não": não volta nesta abertura
  assert.equal(a.adv(MIN), null);
  const b = new Feedback({ store: a.store, now: () => new Date(a.clock.t) });   // próxima abertura: pergunta de novo
  assert.equal(b.tick().kind, 'summary');
  b.answer('summary', 'desligar');
  assert.equal(a.store.kvGet('ai_summary'), false); assert.equal(a.store.kvGet('ai_summary_asked'), true);
  const c = new Feedback({ store: a.store, now: () => new Date(a.clock.t) });
  assert.equal(c.tick(), null, 'respondido: nunca mais');
  assert.equal(c.list().length, 0, 'não vira resposta de cartão no relatório');
  // instalação nova (desligado) ou quem já escolheu nos Ajustes/boas-vindas: nada
  const d = mk(new Date(2026, 10, 16, 10)); d.store.kvSet('ai_summary', false); assert.equal(d.adv(MIN), null);
  const e = mk(new Date(2026, 10, 16, 10)); e.store.kvSet('ai_summary', true); e.store.kvSet('ai_summary_asked', true); assert.equal(e.adv(MIN), null);
  assert.throws(() => e.fb.answer('summary', 'talvez'), /inválida/);
});
