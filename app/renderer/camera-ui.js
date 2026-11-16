// Câmera → terminal (v0.8, E7). Botão 📷 no cabeçalho de cada painel de terminal:
//  · no computador: recorte de tela (seletor do sistema / Ferramenta de Captura) → anexos/ → caminho no terminal
//  · atalho T.shotKey
//  · no celular/iPad: câmera ou galeria → reduzida no aparelho (lado ≤ 2560, JPEG 0,85) → attach:image (1 envio por
//    toque, sem laço) → "foto enviada para o terminal X". Sem URL de objeto: lê por createImageBitmap (ou data:).
// A imagem nunca passa pela Área de Trabalho; o caminho cai no terminal sem Enter.
'use strict';
(function () {
  const { h, toast, modal, T } = window.UI;
  const B = window.bancada;
  let opts = { currentTerm: () => null, termName: (id) => id };
  let busy = false;
  const clean = (e) => String((e && e.message) || e).replace(/^\[[A-Z_]+\]\s*/, '');

  // aviso enquanto a Ferramenta de Captura do Windows está aberta (até 30 s), com Cancelar
  let pill = null;
  function waitPill(on) {
    if (!on) { if (pill) pill.remove(); pill = null; return; }
    pill = h('div', { id: 'shot-pill' }, h('span', { text: `Recorte a tela na ${T.shotTool} (até 30 s)…` }),
      h('button', { class: 'aurora-btn aurora-btn--text sm', onclick: () => B.shot.abort().catch(() => {}) }, 'Cancelar'));
    document.body.appendChild(pill);
  }

  async function screen(term) {
    if (!B.shot || busy || !term) return;
    if (!(await window.UI.macPermNotice('tela'))) return;   // Mac, 1º uso: aviso sobre a permissão valer para os terminais
    busy = true;
    if (T.win) waitPill(true);
    let r = null;
    try { r = await B.shot.screen(term); }
    catch (e) { toast(clean(e), 5000); }
    finally { busy = false; waitPill(false); }
    if (!r) { if (T.win) toast('Nenhum recorte chegou (cancelado ou demorou mais de 30 s).', 4000); return; }
    return deliver(r);
  }

  // ---------- prévia antes de colar (recorte e foto): Enviar (Enter) / Cancelar (Esc) ----------
  // fechar de qualquer jeito sem Enviar = cancelar (o recorte é apagado). Um envio só (botão trava ao clicar).
  function preview({ dataUrl, title, info, warn, termId, onSend, onCancel }) {
    let sent = false;
    modal((c, close) => {
      const go = h('button', { class: 'aurora-btn aurora-btn--primary', autofocus: true }, 'Enviar');
      const send = async () => {
        if (sent) return; sent = true; go.disabled = true;
        try { await onSend(); close(); } catch (e) { sent = false; go.disabled = false; toast(clean(e), 5000); }
      };
      go.addEventListener('click', send);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      c.append(h('h2', { text: title }),
        h('img', { class: 'shot-preview', src: dataUrl, alt: 'Prévia da imagem' }),
        h('p', { class: 'muted small', text: `${info} · vai para ${opts.termName(termId) || 'o terminal'} (o caminho entra sem Enter)` }),
        warn ? h('p', { class: 'small amber-text', text: warn }) : null,
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--text', onclick: () => close() }, 'Cancelar'), go));
    }, { onClose: () => { if (!sent && onCancel) onCancel(); } });
  }

  function deliver(r) {
    const warn = !T.win && r.perm && r.perm !== 'granted'
      ? `Se a imagem saiu só com o papel de parede, falta a permissão de Gravação de Tela: ${T.screenHelp}` : null;
    preview({ dataUrl: r.dataUrl, title: 'Mandar este recorte?', info: `${r.width}×${r.height} · ${r.kb} KB`, warn, termId: r.termId,
      onSend: async () => { await B.shot.send(r.token); toast(`Recorte colado em ${opts.termName(r.termId) || 'terminal'}`); if (window.Terminals) window.Terminals.focus(r.termId); },
      onCancel: () => { B.shot.cancel(r.token).catch(() => {}); } });
  }

  // Checagem (Ajustes → Recorte de tela): checkLine vem do app.js; a Checagem pronta vem do processo principal
  function settingsSection(checkLine) {
    const box = h('div', { class: 'shot-check' });
    if (!B.shot) { box.append(h('p', { class: 'muted small', text: 'Recorte de tela só no computador; no celular, o 📷 do terminal abre a câmera.' })); return box; }
    const paint = async () => {
      let st; try { st = await B.shot.status(); } catch (e) { box.replaceChildren(h('p', { class: 'small amber-text', text: clean(e) })); return; }
      const steps = st.checkup ? st.checkup.steps : [];
      box.replaceChildren(...steps.map(sp => checkLine(sp.fix === 'screen' ? { ...sp, hint: T.screenHelp } : sp)),
        h('div', { class: 'row wrap' },
          steps.some(s => s.fix === 'screen') && B.voice ? h('button', { class: 'aurora-btn aurora-btn--glass sm', onclick: () => B.voice.openHelp('screen') }, 'Abrir ajustes de Gravação de Tela') : null,
          h('button', { class: 'aurora-btn aurora-btn--text sm', onclick: paint }, 'Testar')),
        h('p', { class: 'muted small', text: `📷 no cabeçalho do terminal (ou ${T.shotKey}): recorte uma parte da tela e a imagem vai para o terminal, sem passar pela Área de Trabalho.` }));
    };
    paint();
    return box;
  }

  // ---------- celular: foto ----------
  const MAX_SIDE = 2560;
  let input = null, target = null, sending = false;
  function pickPhoto(id) {
    if (sending) { toast('Ainda enviando a foto anterior…'); return; }
    target = id;
    if (!input) {
      input = h('input', { type: 'file', accept: 'image/jpeg,image/png', capture: 'environment', style: { display: 'none' }, 'aria-hidden': 'true' });
      input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) photo(target, f); });
      document.body.appendChild(input);
    }
    input.click();
  }
  const readDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('imagem ilegível')); i.src = src; });
  // reduz no aparelho: lado maior ≤ 2560, JPEG 0,85 → data URL (base64). O canvas é zerado no fim (memória do iPhone).
  async function shrink(file) {
    let src = null, w = 0, hh = 0;
    if (window.createImageBitmap) { try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; hh = src.height; } catch { src = null; } }
    if (!src) { src = await loadImg(await readDataUrl(file)); w = src.naturalWidth; hh = src.naturalHeight; }
    const k = Math.min(1, MAX_SIDE / Math.max(w, hh, 1));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hh * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    const out = { dataUrl: c.toDataURL('image/jpeg', 0.85), width: c.width, height: c.height };
    c.width = c.height = 0;
    return out;
  }
  async function photo(id, file) {
    if (file.type && !/^image\/(jpeg|png)$/.test(file.type)) { toast('Só foto JPG ou PNG'); return; }
    if (file.size > 40 * 1024 * 1024) { toast('Foto grande demais'); return; }
    let img; try { img = await shrink(file); } catch (e) { toast('Não deu para ler a foto: ' + clean(e)); return; }
    preview({ dataUrl: img.dataUrl, title: 'Mandar esta foto?', info: `${img.width}×${img.height} · ${Math.round(img.dataUrl.length * 0.75 / 1024)} KB`, termId: id,
      onSend: () => sendPhoto(id, img), onCancel: null });
  }
  async function sendPhoto(id, img) {
    if (sending) return;
    sending = true;
    try {
      await B.attach.image(id, { name: 'foto.jpg', b64: img.dataUrl.replace(/^data:[^,]*,/, '') });
      toast(`Foto enviada para o terminal ${opts.termName(id) || ''}`.trim(), 3500);
    } finally { sending = false; }
  }

  function button(id) {
    // celular/iPad: 📷 = câmera ou galeria (a foto vai para o terminal no computador)
    if (!B.shot) return window.__REMOTE && B.attach && B.attach.image ? h('button', { class: 'pane-cam', title: 'Tirar ou escolher uma foto e mandar para este terminal', 'aria-label': 'Foto',
      onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); pickPhoto(id); } }, '📷') : null;
    return h('button', { class: 'pane-cam', title: `Recortar a tela e mandar a imagem para este terminal (${T.shotKey}). Vai para os anexos da Bancada, não para a Área de Trabalho.`,
      'aria-label': 'Recortar a tela', onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); screen(id); } }, '📷');
  }

  const isShotKey = (e) => (T.win ? e.ctrlKey && e.shiftKey && !e.metaKey : e.metaKey && e.shiftKey && !e.ctrlKey) && !e.altKey && (e.key === 'r' || e.key === 'R');
  function init(o = {}) {
    opts = { ...opts, ...o };
    if (!B.shot) return;
    document.addEventListener('keydown', (e) => {
      if (!isShotKey(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      const term = opts.currentTerm();
      if (!term) { toast('Abra um terminal para mandar o recorte'); return; }
      screen(term);
    }, true);
  }

  window.CameraUI = { init, button, screen, settingsSection, _photo: photo };
})();
