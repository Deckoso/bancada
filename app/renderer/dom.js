// Helpers de DOM. Todo texto vindo de dados (sessões, notas) entra por textContent — nunca innerHTML.
'use strict';
(function () {
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason && e.reason.message || e.reason)));
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(sel) { return document.querySelector(sel); }

  function ago(ts) {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return `há ${m} min`;
    const hh = Math.round(m / 60); if (hh < 24) return `há ${hh} h`;
    const d = Math.round(hh / 24); return d === 1 ? 'ontem' : `há ${d} dias`;
  }
  function today() {
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  let toastTimer = null;
  function errCode(e) { const m = /^\[([A-Z_]+)\]/.exec(String(e && e.message || '')); return m ? m[1] : null; }
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = String(msg).replace(/^\[[A-Z_]+\]\s*/, ''); t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // opts.onClose(replaced): chamado uma vez ao fechar (replaced = outra janela tomou o lugar) · opts.noEscape: Esc não fecha (ex.: terminal de login, que usa o Esc)
  let currentClose = null;   // janela aberta agora: abrir outra fecha a anterior (senão o Esc dela continuava valendo)
  function modal(build, opts = {}) {
    if (currentClose) currentClose(true);
    const m = $('#modal'); const card = clear($('#modal-card')); card.className = 'modal-card';
    let closed = false;
    const close = (replaced = false) => {
      if (closed) return; closed = true; if (currentClose === close) currentClose = null;
      m.classList.add('hidden'); clear(card); card.className = 'modal-card'; document.removeEventListener('keydown', onKey, true);
      if (opts.onClose) { try { opts.onClose(replaced === true); } catch (e) { console.error(e); } }
    };
    const onKey = (e) => { if (e.key === 'Escape' && !opts.noEscape) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    currentClose = close;
    build(card, close);
    m.classList.remove('hidden');
    const f = card.querySelector('[autofocus], input, textarea, button'); if (f) f.focus();
    return close;
  }

  // Campo de texto que edita no lugar: clique → textarea, ⌘↩/blur salva, Esc cancela.
  function editable(el, value, onSave, { multiline = true, placeholder = '' } = {}) {
    el.classList.add('editable');
    el.title = 'Clique para editar';
    el.addEventListener('click', () => {
      if (el.querySelector('textarea,input')) return;
      const inp = h(multiline ? 'textarea' : 'input', { class: 'aurora-input inline', placeholder, rows: multiline ? 4 : null });
      inp.value = value || '';
      const old = [...el.childNodes]; clear(el); el.appendChild(inp); inp.focus(); inp.select();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        if (save && inp.value.trim() !== (value || '').trim()) { await onSave(inp.value.trim()); }
        else { clear(el); old.forEach(n => el.appendChild(n)); }
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
        if (e.key === 'Enter' && (!multiline || e.metaKey)) { e.preventDefault(); finish(true); }
      });
      inp.addEventListener('blur', () => finish(true));
    });
  }

  window.UI = { h, clear, $, ago, today, toast, modal, editable, errCode };
})();
