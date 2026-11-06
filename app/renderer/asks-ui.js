// Cartões de pergunta (BP-2026-11-06-002 E3). O Claude chama a ferramenta da Bancada; o cartão aparece DENTRO do
// painel do terminal que perguntou (no Mac e no celular). Respostas por toque: lista (Já fiz / Adiar / Fazer agora por
// item) e pergunta (opções, texto livre, Pular, Chega). O rascunho de cada cartão sobrevive aos redesenhos dos painéis.
// Memória: só os cartões abertos (máx. 20, limite do processo principal) e um rascunho por cartão, apagado ao responder.
'use strict';
(function () {
  const { h, toast } = window.UI;
  const B = window.bancada;
  let asks = [];
  const drafts = new Map();     // ask id -> { escolhas, nota, texto, sel:Set, min:boolean }
  let goTerm = () => {};

  function init(opts) {
    goTerm = opts.goTerm || goTerm;
    B.asks.onChanged((list) => { asks = Array.isArray(list) ? list : []; prune(); paint(); });
    B.asks.list().then((l) => { asks = l || []; paint(); }).catch(() => {});
  }
  function prune() { for (const id of drafts.keys()) if (!asks.some(a => a.id === id)) drafts.delete(id); }
  function draft(a) {
    if (!drafts.has(a.id)) drafts.set(a.id, { escolhas: a.kind === 'lista' ? a.args.itens.map(() => ({ opcao: null, nota: '' })) : null, nota: '', texto: '', sel: new Set(), min: false });
    return drafts.get(a.id);
  }
  const forTerm = (termId) => asks.filter(a => a.term === termId);
  const count = () => asks.length;

  // ---- desenho: um cartão por painel (o mais antigo daquele terminal); os de terminais escondidos viram um aviso ----
  function paint() {
    const panes = [...document.querySelectorAll('#terms .pane')];
    const shown = new Set();
    for (const pane of panes) {
      const list = forTerm(pane.dataset.id);
      const a = list[0];
      let el = pane.querySelector(':scope > .ask-card');
      if (!a) { if (el) el.remove(); continue; }
      shown.add(a.id);
      if (el && el.dataset.ask === a.id) { el.classList.toggle('min', draft(a).min); continue; }
      if (el) el.remove();
      el = build(a, list.length);
      pane.appendChild(el);
      if (pane.classList.contains('focus') && !draft(a).min) setTimeout(() => { const f = el.querySelector('[data-autofocus]') || el; try { f.focus({ preventScroll: true }); } catch {} }, 30);
    }
    paintStrip();
  }

  function paintStrip() {
    const host = document.getElementById('terms'); if (!host) return;
    let strip = document.getElementById('ask-strip');
    const onScreen = new Set([...document.querySelectorAll('#terms .pane')].map(p => p.dataset.id));
    const hidden = asks.filter(a => !onScreen.has(a.term));   // os de um terminal à vista entram no "+N" do cartão dele
    if (!hidden.length) { if (strip) strip.remove(); return; }
    if (!strip) { strip = h('div', { id: 'ask-strip' }); host.parentElement.insertBefore(strip, host); }
    while (strip.firstChild) strip.removeChild(strip.firstChild);
    strip.appendChild(h('span', { class: 'ask-strip-t', text: hidden.length === 1 ? '✋ 1 cartão esperando você:' : `✋ ${hidden.length} cartões esperando você:` }));
    for (const a of hidden.slice(0, 4)) {
      strip.appendChild(h('button', { class: 'ask-strip-b', onclick: () => goTerm(a.project, a.term) }, a.kind === 'lista' ? a.args.titulo : a.args.pergunta.slice(0, 60)));
    }
  }

  function shell(a, more, title, body, foot) {
    const d = draft(a);
    const el = h('div', { class: `ask-card ${d.min ? 'min' : ''} ${a.orphan ? 'orphan' : ''}`, dataset: { ask: a.id }, tabindex: '-1',
      onmousedown: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation() },
      h('div', { class: 'ask-head' },
        h('span', { class: 'ask-ic', text: '✋' }),
        h('div', { class: 'ask-title' }, title),
        more > 1 ? h('span', { class: 'ask-more', text: `+${more - 1}` }) : null,
        h('button', { class: 'ask-min', title: d.min ? 'Abrir o cartão' : 'Recolher (para ler o terminal)', onclick: () => { d.min = !d.min; el.classList.toggle('min', d.min); } }, d.min ? '▴' : '▾')),
      a.orphan ? h('div', { class: 'ask-orphan', text: 'A conversa que perguntou foi encerrada: a resposta vai como mensagem no terminal.' }) : null,
      h('div', { class: 'ask-body' }, body),
      h('div', { class: 'ask-foot' }, foot));
    el.querySelector('.ask-head').addEventListener('click', (e) => { if (d.min && !e.target.closest('button')) { d.min = false; el.classList.remove('min'); } });
    return el;
  }

  async function send(a, payload, el) {
    for (const b of el.querySelectorAll('button')) b.disabled = true;
    try { await B.asks.answer(a.id, payload); drafts.delete(a.id); }
    catch (e) { for (const b of el.querySelectorAll('button')) b.disabled = false; toast(/GONE/.test(e.message) ? 'Esse cartão já foi respondido ou fechado.' : e.message); }
  }
  async function dismiss(a, el) {
    for (const b of el.querySelectorAll('button')) b.disabled = true;
    try { await B.asks.dismiss(a.id); drafts.delete(a.id); } catch (e) { toast(e.message); }
  }

  // ---- lista: cada item com os botões (padrão Já fiz / Adiar / Fazer agora) ----
  function build(a, more) { return a.kind === 'lista' ? buildLista(a, more) : buildPergunta(a, more); }

  function buildLista(a, more) {
    const d = draft(a); const { itens, opcoes } = a.args;
    const counter = h('span', { class: 'ask-count' });
    const rows = [];
    const sync = () => {
      const n = d.escolhas.filter(e => e.opcao != null).length;
      counter.textContent = `${n} de ${itens.length}`;
      rows.forEach((r, i) => { for (const [k, b] of r.btns.entries()) b.classList.toggle('on', d.escolhas[i].opcao === k); r.el.classList.toggle('done', d.escolhas[i].opcao != null); });
    };
    const list = h('div', { class: 'ask-items' }, itens.map((it, i) => {
      const btns = opcoes.map((o, k) => h('button', { class: `ask-opt o${k}`, onclick: () => { d.escolhas[i].opcao = d.escolhas[i].opcao === k ? null : k; sync(); } }, o));
      const nota = h('input', { class: 'ask-note hidden', placeholder: 'nota (opcional)', maxlength: '400', value: d.escolhas[i].nota, oninput: (e) => { d.escolhas[i].nota = e.target.value; } });
      if (d.escolhas[i].nota) nota.classList.remove('hidden');
      const el = h('div', { class: 'ask-item' },
        h('div', { class: 'ask-item-t' }, h('span', { class: 'ask-n', text: String(i + 1) }),
          h('div', { class: 'ask-item-txt' }, h('div', { text: it.texto }), it.detalhe ? h('div', { class: 'ask-det', text: it.detalhe }) : null),
          h('button', { class: 'ask-pen', title: 'Escrever uma nota neste item', onclick: () => { nota.classList.toggle('hidden'); if (!nota.classList.contains('hidden')) nota.focus(); } }, '✎')),
        h('div', { class: 'ask-btns' }, btns), nota);
      rows.push({ el, btns });
      return el;
    }));
    const all = h('div', { class: 'ask-all' }, h('span', { class: 'muted small', text: 'Os sem resposta:' }),
      opcoes.map((o, k) => h('button', { class: 'ask-opt sm', onclick: () => { d.escolhas.forEach(e => { if (e.opcao == null) e.opcao = k; }); sync(); } }, o)));
    const geral = h('input', { class: 'ask-geral', placeholder: 'Comentário geral (opcional)', maxlength: '600', value: d.nota, oninput: (e) => { d.nota = e.target.value; } });
    let el;
    const foot = [counter, h('span', { class: 'grow' }),
      h('button', { class: 'ask-ghost', onclick: () => dismiss(a, el) }, 'Fechar sem responder'),
      h('button', { class: 'ask-send', 'data-autofocus': '', onclick: () => send(a, { escolhas: d.escolhas, nota: d.nota }, el) }, 'Enviar respostas')];
    el = shell(a, more, a.args.titulo, [list, all, geral], foot);
    sync();
    return el;
  }

  // ---- pergunta: uma por vez. Clique numa opção (escolha única, sem texto) já responde: fluido como o Akinator ----
  function buildPergunta(a, more) {
    const d = draft(a); const { pergunta, opcoes, multipla, texto_livre, etapa, resumo } = a.args;
    let el;
    const ta = texto_livre ? h('textarea', { class: 'ask-text', rows: '2', maxlength: '4000', placeholder: opcoes.length ? 'Ou escreva do seu jeito… (⌘↩ envia)' : 'Sua resposta… (⌘↩ envia)', oninput: (e) => { d.texto = e.target.value; } }) : null;
    if (ta) ta.value = d.texto;
    const answer = () => send(a, { acao: 'responder', escolhas: [...d.sel], texto: d.texto }, el);
    const optEls = opcoes.map((o, k) => h('button', { class: `ask-choice ${d.sel.has(k) ? 'on' : ''}`, onclick: () => {
      if (multipla) { if (d.sel.has(k)) d.sel.delete(k); else d.sel.add(k); optEls[k].classList.toggle('on', d.sel.has(k)); return; }
      d.sel = new Set([k]); optEls.forEach((b, j) => b.classList.toggle('on', j === k));
      if (!d.texto.trim()) answer();
    } }, h('span', { class: 'ask-key', text: String(k + 1) }), h('span', { class: 'ask-choice-t' }, h('b', { text: o.rotulo }), o.descricao ? h('span', { class: 'ask-det', text: o.descricao }) : null)));
    if (ta) ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer(); } });
    const body = [
      h('div', { class: 'ask-q', text: pergunta }),
      resumo ? h('details', { class: 'ask-sum' }, h('summary', { text: 'O que já entendi' }), h('div', { class: 'ask-sum-t', text: resumo })) : null,
      opcoes.length ? h('div', { class: 'ask-choices' }, optEls) : null,
      multipla ? h('div', { class: 'muted small', text: 'Pode marcar várias.' }) : null,
      ta,
    ];
    const foot = [
      h('button', { class: 'ask-ghost', title: 'Não quero responder esta', onclick: () => send(a, { acao: 'pular', texto: d.texto }, el) }, 'Pular'),
      h('button', { class: 'ask-ghost', title: 'Parar as perguntas e ver o resumo', onclick: () => send(a, { acao: 'chega', texto: d.texto }, el) }, 'Chega, quero o resumo'),
      h('span', { class: 'grow' }),
      (multipla || ta || !opcoes.length) ? h('button', { class: 'ask-send', onclick: answer }, 'Responder') : null,
    ];
    el = shell(a, more, etapa ? h('span', { class: 'ask-step', text: etapa }) : 'Pergunta do Claude', body, foot);
    // teclas 1–6 escolhem a opção (com o cartão em foco e fora da caixa de texto)
    el.addEventListener('keydown', (e) => {
      if (e.target === ta || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = Number(e.key) - 1;
      if (k >= 0 && k < optEls.length) { e.preventDefault(); optEls[k].click(); }
    });
    if (ta) ta.setAttribute('data-autofocus', '');
    else if (optEls[0]) optEls[0].setAttribute('data-autofocus', '');
    return el;
  }

  window.AskUI = { init, paint, count, forTerm };
})();
