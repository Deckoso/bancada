// Arrastar e soltar da Bancada. Um "payload" {kind, id, from} por vez; listas ordenáveis e alvos de soltura.
// kinds: project · item · tab · card · today
'use strict';
(function () {
  let cur = null;

  function clearMarks() { for (const el of document.querySelectorAll('.drop-before,.drop-after,.drop-into')) el.classList.remove('drop-before', 'drop-after', 'drop-into'); }

  function draggable(el, payload, { handle } = {}) {
    el.draggable = true;
    if (handle) {
      // só começa o arraste pela alça (ex.: cabeçalho do cartão), para não roubar seleção de texto
      el.addEventListener('mousedown', (e) => { el.draggable = !!e.target.closest(handle); });
    }
    el.addEventListener('dragstart', (e) => {
      if (e.target !== el) return;
      cur = payload;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(payload.text || payload.id)); } catch {}
      requestAnimationFrame(() => el.classList.add('dragging'));
      document.body.classList.add(`dragging-${payload.kind}`);
    });
    el.addEventListener('dragend', () => {
      cur = null; el.classList.remove('dragging'); clearMarks();
      document.body.className = document.body.className.replace(/\bdragging-\w+\b/g, '').trim();
    });
  }

  // Lista ordenável. onDrop recebe a nova ordem de ids e o payload (que pode ter vindo de outra lista).
  function sortable(container, { accepts, itemSelector, axis = 'y', onDrop }) {
    const items = () => [...container.querySelectorAll(itemSelector)].filter(el => el.parentElement === container || container.contains(el));
    container.addEventListener('dragover', (e) => {
      if (!cur || !accepts(cur)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      clearMarks();
      const target = e.target.closest(itemSelector);
      if (target && container.contains(target) && target.dataset.id !== cur.id) {
        const r = target.getBoundingClientRect();
        const before = axis === 'x' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
        target.classList.add(before ? 'drop-before' : 'drop-after');
      } else if (!target) container.classList.add('drop-into');
    });
    container.addEventListener('dragleave', (e) => { if (!container.contains(e.relatedTarget)) clearMarks(); });
    container.addEventListener('drop', (e) => {
      if (!cur || !accepts(cur)) return;
      e.preventDefault();
      const payload = cur;
      const ids = items().map(el => el.dataset.id).filter(id => id !== payload.id);
      const target = e.target.closest(itemSelector);
      let idx = ids.length;
      if (target && container.contains(target) && target.dataset.id !== payload.id) {
        const r = target.getBoundingClientRect();
        const before = axis === 'x' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
        idx = ids.indexOf(target.dataset.id) + (before ? 0 : 1);
      }
      ids.splice(Math.max(0, idx), 0, payload.id);
      clearMarks();
      cur = null;
      onDrop(ids, payload);
    });
  }

  // Alvo simples (ex.: soltar uma nota num projeto da barra lateral)
  function dropTarget(el, { accepts, onDrop }) {
    el.addEventListener('dragover', (e) => { if (cur && accepts(cur)) { e.preventDefault(); e.stopPropagation(); clearMarks(); el.classList.add('drop-into'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop-into'));
    el.addEventListener('drop', (e) => { if (!cur || !accepts(cur)) return; e.preventDefault(); e.stopPropagation(); const p = cur; cur = null; clearMarks(); onDrop(p); });
  }

  window.DnD = { draggable, sortable, dropTarget, current: () => cur };
})();
