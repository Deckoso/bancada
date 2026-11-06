// Janela de captura do ⌥Space: digita, ⌘↩, some. Zero decisão obrigatória.
'use strict';
(function () {
  const B = window.bancada;
  const t = document.getElementById('t');
  const to = document.getElementById('to');
  let type = 'note';
  let active = { name: 'Inbox' };
  let sending = false;

  function setTo() {
    const m = /^\s*#([\p{L}\p{N}_-]{1,40})\s/u.exec(t.value);
    to.textContent = '';
    to.append('→ ');
    const b = document.createElement('b');
    b.textContent = m ? `#${m[1]}` : active.name;
    to.append(b);
  }

  for (const p of document.querySelectorAll('.pill')) {
    p.addEventListener('click', () => { type = p.dataset.type; for (const q of document.querySelectorAll('.pill')) q.classList.toggle('on', q === p); t.focus(); });
  }

  B.capture.onOpen(({ activeProject }) => { active = activeProject || active; t.value = ''; sending = false; setTo(); t.focus(); });
  t.addEventListener('input', setTo);
  t.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); B.capture.hide(); return; }
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      const text = t.value.trim();
      if (!text || sending) return;
      sending = true;
      try {
        const r = await B.capture.submit({ text, type });
        to.textContent = ''; const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = `✓ em ${r.project.name}`; to.append(ok);
        t.value = '';
        setTimeout(() => B.capture.hide(), 350);
      } catch (err) { to.textContent = String(err.message).replace(/^\[[A-Z_]+\]\s*/, ''); }
      finally { sending = false; }
    }
  });
  setTo();
})();
