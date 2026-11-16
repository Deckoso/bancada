// Atualização (v0.8, E8): aviso discreto na lateral quando a versão nova já está baixada e conferida
// ("Nova versão 0.8.x — instala quando você fechar") e a seção "Atualização" dos Ajustes (procurar agora, ligar/desligar
// a checagem diária). Quem baixa, confere e troca é o processo principal (app/main/updater.js). Nada no celular.
'use strict';
(function () {
  const { h, toast, T } = window.UI;
  const B = window.bancada;
  const clean = (e) => String((e && e.message) || e).replace(/^\[[A-Z_]+\]\s*/, '');
  let last = null;
  let settingsPaint = null;   // só a seção aberta por último (nunca acumula)

  function line(st) {
    if (!st) return '';
    switch (st.state) {
      case 'dev': return 'Modo de desenvolvimento: a atualização automática fica desligada.';
      case 'checking': return 'Procurando versão nova…';
      case 'downloading': return `Baixando a versão ${st.version || 'nova'}${st.pct != null ? ` · ${st.pct}%` : ''} (em 2º plano)…`;
      case 'ready': return `Nova versão ${st.version} pronta — instala quando você fechar a Bancada.`;
      case 'none': return `Você está na versão mais nova (${st.current}).`;
      case 'manual': return `Esta cópia não se atualiza sozinha (${st.error}). Baixe a versão nova pelo site.`;
      case 'error': return `Não deu para procurar agora: ${st.error || 'sem internet?'}`;
      default: return `Versão ${st.current}.`;
    }
  }
  const when = (ms) => { if (!ms) return 'nunca'; const d = new Date(ms); return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };

  function pill(st) {
    const el = document.getElementById('update-note'); if (!el) return;
    const on = !!st && st.state === 'ready';
    el.classList.toggle('hidden', !on);
    el.textContent = on ? `Nova versão ${st.version} — instala quando você fechar` : '';
    el.title = on ? `A versão ${st.version} já foi baixada e conferida. Quando você sair da Bancada, ela troca sozinha e reabre. Seus projetos e ajustes continuam.` : '';
  }
  function apply(st) { last = st; pill(st); if (settingsPaint && settingsPaint.box.isConnected) { try { settingsPaint(st); } catch {} } }

  function init() {
    if (!B.update || window.__REMOTE) return;
    B.update.onChanged(apply);
    B.update.status().then(apply).catch(() => {});
  }

  function settingsSection() {
    const box = h('div', { class: 'update-check' });
    if (!B.update || window.__REMOTE) { box.append(h('p', { class: 'muted small', text: 'Atualização só no computador.' })); return box; }
    const status = h('p', { class: 'small', 'aria-live': 'polite' });
    const meta = h('p', { class: 'muted small' });
    const auto = h('input', { type: 'checkbox' });
    const btn = h('button', { class: 'aurora-btn aurora-btn--glass sm' }, 'Procurar atualização');
    const paint = (st) => {
      if (!st) return;
      status.textContent = line(st);
      status.className = `small ${st.state === 'ready' || st.state === 'none' ? 'ok-text' : st.state === 'error' || st.state === 'manual' ? 'amber-text' : ''}`;
      auto.checked = st.auto !== false;
      meta.textContent = `Instalada: ${st.current} · última procura: ${when(st.lastCheck)}`;
      btn.disabled = st.state === 'checking' || st.state === 'downloading' || st.state === 'dev';
    };
    btn.onclick = async () => { btn.disabled = true; try { paint(await B.update.check()); } catch (e) { toast(clean(e)); } finally { if (last) paint(last); } };
    auto.onchange = async () => { try { paint(await B.update.setAuto(auto.checked)); } catch (e) { toast(clean(e)); } };
    paint.box = box; settingsPaint = paint;
    box.append(status, meta,
      h('label', { class: 'field check' }, auto, h('span', { text: 'Procurar e baixar sozinha (1× por dia). Instala só quando você fechar a Bancada; seus projetos e ajustes continuam.' })),
      h('div', { class: 'row wrap' }, btn),
      h('p', { class: 'muted small', text: T.win
        ? 'Vem da página oficial da Bancada no GitHub e é conferida (SHA-512) antes de instalar.'
        : 'Vem da página oficial da Bancada no GitHub; antes de trocar, a Bancada confere o SHA-512 e a assinatura do app novo.' }));
    if (last) paint(last); else B.update.status().then(paint).catch(() => {});
    return box;
  }

  window.UpdateUI = { init, settingsSection, line };
})();
