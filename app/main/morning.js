// Resumo da manhã + lembretes com hora (D12). Uma notificação por dia, mais os lembretes que o usuário criou.
// Timers: um setTimeout para a próxima manhã (recalculado a cada disparo) e um intervalo de 30 s para lembretes.
'use strict';

const MAX_TODAY = 3;

function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nextAt(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date(now); t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

class Morning {
  constructor({ store, notify, now = () => new Date() }) {
    this.store = store; this.notify = notify; this.now = now;
    this.timer = null; this.remTimer = null; this.lastRemCheck = Date.now();
  }

  start() {
    this.schedule();
    this.remTimer = setInterval(() => this.checkReminders(), 30 * 1000);
  }
  stop() { clearTimeout(this.timer); clearInterval(this.remTimer); this.timer = this.remTimer = null; }

  schedule() {
    clearTimeout(this.timer);
    const at = nextAt(this.store.kvGet('morning_time', '09:00'), this.now());
    // setTimeout aceita no máximo ~24,8 dias; aqui é sempre < 24 h
    this.timer = setTimeout(() => { this.fire(); this.schedule(); }, Math.max(1000, at - this.now()));
  }

  // Sugestões: o próximo passo de cada projeto em foco + lembretes de hoje. Nunca mais que 3.
  suggest() {
    const today = localDate(this.now());
    const chosen = this.store.listToday(today);
    const out = [];
    for (const p of this.store.listProjects().filter(p => p.status === 'focus')) {
      if (p.next_step) out.push({ kind: 'step', project_id: p.id, project_name: p.name, text: p.next_step });
    }
    const start = new Date(this.now()); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    for (const r of this.store.dueReminders(start.getTime(), end.getTime())) {
      const p = this.store.getProject(r.project_id);
      out.push({ kind: 'reminder', item_id: r.id, project_id: r.project_id, project_name: p ? p.name : '', text: r.text, remind_at: r.remind_at });
    }
    return { date: today, chosen, suggestions: out.slice(0, 6), max: MAX_TODAY };
  }

  // Define o "Hoje" com até 3 itens. O que estava no Hoje e saiu volta quieto para o projeto (sem culpa).
  setToday(itemIds) {
    const today = localDate(this.now());
    const ids = itemIds.slice(0, MAX_TODAY);
    this.store.db.transaction(() => {
      for (const it of this.store.listToday(today)) if (!ids.includes(it.id)) this.store.updateItem(it.id, { today_date: null });
      for (const id of ids) this.store.updateItem(id, { today_date: today });
    })();
    this.store.kvSet('today_set_on', today);
    return this.store.listToday(today);
  }

  fire() {
    const s = this.suggest();
    const list = (s.chosen.length ? s.chosen.map(i => i.text) : s.suggestions.map(x => x.text)).slice(0, MAX_TODAY);
    const body = list.length ? list.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join('\n') : 'Abra a Bancada e escolha as 3 coisas de hoje.';
    this.notify('Bancada — hoje', body);
  }

  checkReminders() {
    const now = Date.now();
    for (const r of this.store.dueReminders(this.lastRemCheck, now)) this.notify('Lembrete', r.text.slice(0, 200));
    this.lastRemCheck = now;
  }
}

module.exports = { Morning, localDate, nextAt, MAX_TODAY };
