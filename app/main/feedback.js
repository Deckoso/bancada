// Cartões de retorno (v0.8): "Como foi a semana?" e "Travou?". Respostas ficam só neste computador (banco local) e
// entram no "Relatar problema". Nada vai para a rede.
// Semanal: 1× por semana, a partir de sexta às 16h (se a Bancada não estava aberta, vale até domingo), e só numa pausa:
// nenhum terminal trabalhando há pelo menos 2 min. "Travou?": depois de um erro no registro, no máximo 1 por dia, e só
// quando nenhum terminal está trabalhando.
// Um intervalo só (30 s), que não cria nada novo a cada volta.
// Resumo por IA: quem veio da 0.7 com ele ligado (o padrão antigo) vê UMA vez a pergunta "manter?"; até responder, o
// valor continua o que era. Responder (ou mudar nos Ajustes / na boas-vindas) marca ai_summary_asked.
'use strict';

const TICK_MS = 30 * 1000;
const PAUSE_MS = 2 * 60 * 1000;
const MAX_ROWS = 200;
const ANSWERS = { week: ['boa', 'mais ou menos', 'ruim'], crash: ['travou', 'não percebi nada'], summary: ['manter', 'desligar'] };

function localDate(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
// a semana do cartão é identificada pela sexta-feira dela (sexta, sábado e domingo → a mesma sexta)
function fridayOf(d) {
  const back = (d.getDay() + 2) % 7;                    // sex=0, sáb=1, dom=2, seg=3 …
  const f = new Date(d); f.setDate(d.getDate() - back); f.setHours(0, 0, 0, 0);
  return f;
}
function weekWindow(d) {
  const day = d.getDay();
  if (day === 5) return d.getHours() >= 16;
  return day === 6 || day === 0;
}

class Feedback {
  constructor({ store, busy = () => false, onChange = () => {}, now = () => new Date() }) {
    this.store = store; this.busy = busy; this.onChange = onChange; this.now = now;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, answer TEXT NOT NULL, note TEXT, at INTEGER NOT NULL)`);
    this.lastBusyAt = 0; this.card = null; this.errorAt = 0; this.timer = null; this.summaryShown = false;
  }

  start() { this.lastBusyAt = this.now().getTime(); this.tick(); this.timer = setInterval(() => this.tick(), TICK_MS); return this; }
  stop() { clearInterval(this.timer); this.timer = null; }

  // chamado a cada erro gravado no registro (barato: só marca; o cartão sai no próximo tick)
  onError() { if (!this.errorAt) this.errorAt = this.now().getTime(); }

  tick() {
    const d = this.now(); const t = d.getTime();
    const busy = !!this.busy();
    if (busy) this.lastBusyAt = t;
    if (this.card) return this.card;
    if (!this.summaryShown && this.store.kvGet('ai_summary', false) === true && !this.store.kvGet('ai_summary_asked', false)) {
      this.summaryShown = true;                             // "Agora não" → volta só na próxima abertura
      return this.show({ kind: 'summary', at: t });
    }
    if (busy) return null;
    if (this.errorAt && this.store.kvGet('feedback_crash_day', '') !== localDate(d)) {
      this.store.kvSet('feedback_crash_day', localDate(d));
      return this.show({ kind: 'crash', at: t, since: this.errorAt });
    }
    this.errorAt = 0;   // já houve o cartão de hoje: os erros seguintes não se acumulam
    const week = localDate(fridayOf(d));
    if (weekWindow(d) && t - this.lastBusyAt >= PAUSE_MS && this.store.kvGet('feedback_week', '') !== week) {
      this.store.kvSet('feedback_week', week);              // marcado ao mostrar: abrir e fechar o app não repete
      return this.show({ kind: 'week', at: t, week });
    }
    return null;
  }

  show(card) { this.card = card; this.errorAt = 0; try { this.onChange(card); } catch {} return card; }
  current() { return this.card; }

  answer(kind, answer, note) {
    if (!ANSWERS[kind] || !ANSWERS[kind].includes(answer)) throw Object.assign(new Error('resposta inválida'), { code: 'INVALID' });
    if (kind === 'summary') {
      this.store.kvSet('ai_summary', answer === 'manter'); this.store.kvSet('ai_summary_asked', true);
      return this.dismiss(kind);
    }
    const n = typeof note === 'string' ? note.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1000) : '';
    this.store.db.prepare('INSERT INTO feedback(kind,answer,note,at) VALUES(?,?,?,?)').run(kind, answer, n || null, this.now().getTime());
    this.store.db.prepare('DELETE FROM feedback WHERE id NOT IN (SELECT id FROM feedback ORDER BY id DESC LIMIT ?)').run(MAX_ROWS);
    return this.dismiss(kind);
  }
  dismiss(kind) {
    if (this.card && this.card.kind === kind) { this.card = null; try { this.onChange(null); } catch {} }
    return true;
  }
  list(n = 20) { return this.store.db.prepare('SELECT kind,answer,note,at FROM feedback ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(n, MAX_ROWS))); }
}

module.exports = { Feedback, fridayOf, weekWindow, ANSWERS, PAUSE_MS };
