// Voz → texto no terminal (v0.8, E6). Botão 🎤 no cabeçalho de cada painel de terminal:
//  · segurar = grava; soltar = transcreve · toque rápido = liga (toque de novo = transcreve) · Esc cancela
//  · atalho T.voiceKey (mesma regra: segurar ou tocar)
// Gravação aqui na tela: getUserMedia (só áudio) → AudioContext a 16 kHz (ou reamostrado) → PCM 16 bits mono → WAV em
// memória (sem formato comprimido, sem ffmpeg) → processo principal (whisper local). Teto 60 s. O texto cai no terminal
// SEM Enter. Microfone e contexto de áudio são soltos no fim de toda gravação (nada fica ligado).
'use strict';
(function () {
  const { h, toast, modal, T } = window.UI;
  const B = window.bancada;
  const RATE = 16000;
  const MAX_S = 60;
  const HOLD_MS = 350;          // menos que isso entre apertar e soltar = toque (alterna)
  const MIN_S = 0.3;

  // fonte do áudio (o smoke troca por um som sintético; nunca pede o microfone de verdade)
  let synthetic = false;   // fonte trocada (smoke): sem microfone de verdade, sem aviso
  let source = () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let opts = { currentTerm: () => null, termName: (id) => id };

  // phase: idle · starting (pedindo o microfone) · recording · sending
  const S = { phase: 'idle', term: null, mode: 'hold', downAt: 0, by: null, startAt: 0, chunks: [], n: 0, inRate: RATE, level: 0,
    ctx: null, stream: null, src: null, node: null, tick: 0 };

  // ---------- áudio (puro: testado) ----------
  // reamostra para 16 kHz pela média das amostras de cada intervalo (filtro passa-baixa simples) — só se o contexto
  // não aceitou 16 kHz direto
  function resample(f32, inRate, outRate = RATE) {
    if (inRate === outRate) return f32;
    const ratio = inRate / outRate; const n = Math.floor(f32.length / ratio); const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
      let s = 0; for (let j = a; j < b && j < f32.length; j++) s += f32[j];
      out[i] = s / (b - a);
    }
    return out;
  }
  function join(chunks, n) { const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c.subarray(0, Math.min(c.length, n - o)), o); o += c.length; if (o >= n) break; } return all; }
  function encodeWav(f32) {
    const buf = new ArrayBuffer(44 + f32.length * 2); const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, RATE, true);
    dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, f32.length * 2, true);
    for (let i = 0; i < f32.length; i++) { const x = Math.max(-1, Math.min(1, f32[i])); dv.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Uint8Array(buf);
  }

  // ---------- indicador (um só, fixo na tela: o cabeçalho do painel é redesenhado o tempo todo) ----------
  let pill = null, pillTxt = null, pillBar = null;
  function ensurePill() {
    if (pill) return;
    pillBar = h('span', { class: 'vp-bar' }, h('i'));
    pillTxt = h('span', { class: 'vp-txt' });
    pill = h('div', { id: 'voice-pill', class: 'hidden', role: 'status' }, h('span', { class: 'vp-dot' }), pillTxt, pillBar);
    document.body.appendChild(pill);
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function paintPill() {
    ensurePill();
    pill.className = S.phase === 'idle' ? 'hidden' : S.phase;
    if (S.phase === 'idle') return;
    const name = opts.termName(S.term) || 'terminal';
    if (S.phase === 'starting') pillTxt.textContent = 'Abrindo o microfone…';
    else if (S.phase === 'sending') pillTxt.textContent = `Transcrevendo para ${name}…`;
    else {
      const sec = S.n / S.inRate;
      pillTxt.textContent = `Gravando ${mmss(sec)} · ${S.mode === 'hold' ? 'solte para enviar' : 'toque no 🎤 para enviar'} · Esc cancela`;
    }
    pillBar.firstChild.style.width = `${Math.round(Math.min(1, S.level * 4) * 100)}%`;
  }
  function paintButtons() {
    for (const b of document.querySelectorAll('.pane-mic[data-id]')) {
      const mine = b.dataset.id === S.term && S.phase !== 'idle';
      b.classList.toggle('on', mine); b.classList.toggle('sending', mine && S.phase === 'sending');
    }
  }
  function paint() { paintPill(); paintButtons(); }

  // ---------- gravar ----------
  async function start(term, by) {
    if (S.phase !== 'idle' || !term) return;
    if (!B.voice) { toast(T.voiceRemote); return; }
    S.phase = 'starting'; S.term = term; S.mode = 'hold'; S.by = by; S.downAt = performance.now(); paint();
    let st = null;
    try { st = await B.voice.status(); } catch (e) { reset(); toast(e.message); return; }
    if (!st.binary) { reset(); toast('O motor de voz não veio nesta instalação. Reinstale a Bancada.', 6000); return; }
    if (!st.model.present) { reset(); downloadModal(st); return; }
    // Mac, 1º uso: aviso sobre a permissão do microfone valer também para os terminais (segurar de novo depois)
    if (!synthetic && await window.UI.macPermNeeded()) {
      reset();
      if (await window.UI.macPermNotice('mic')) toast('Pronto. Segure o 🎤 de novo para falar.', 4000);
      return;
    }
    let stream;
    try { stream = await source(); } catch (e) { reset(); micDenied(e); return; }
    if (S.phase !== 'starting') { stream.getTracks().forEach(t => t.stop()); return; }   // cancelado enquanto pedia
    S.stream = stream;
    try {
      let ctx; try { ctx = new AudioContext({ sampleRate: RATE }); } catch { ctx = new AudioContext(); }
      S.ctx = ctx; S.inRate = ctx.sampleRate; S.chunks = []; S.n = 0;
      S.src = ctx.createMediaStreamSource(stream);
      S.node = ctx.createScriptProcessor(4096, 1, 1);
      S.node.onaudioprocess = (ev) => {
        if (S.phase !== 'recording') return;
        const d = ev.inputBuffer.getChannelData(0);
        let sum = 0; for (let i = 0; i < d.length; i += 8) sum += d[i] * d[i];
        S.level = Math.sqrt(sum / (d.length / 8));
        S.chunks.push(new Float32Array(d)); S.n += d.length;
        if (S.n >= MAX_S * S.inRate) { toast(`Gravação parou em ${MAX_S} s`); finish(true); }
      };
      S.src.connect(S.node); S.node.connect(ctx.destination);   // a saída fica muda (não escrevemos nela)
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (e) { teardown(); reset(); toast('Não deu para gravar: ' + e.message); return; }
    S.phase = 'recording'; S.startAt = performance.now();
    clearInterval(S.tick); S.tick = setInterval(paintPill, 200);     // um único timer, parado no fim
    document.addEventListener('keydown', onEsc, true);
    paint();
  }

  // soltar o botão/tecla: segurou → envia; foi um toque → fica gravando até o próximo toque
  function release() {
    if (S.phase !== 'starting' && S.phase !== 'recording') return;
    if (S.mode !== 'hold') return;
    if (performance.now() - S.downAt < HOLD_MS || S.phase === 'starting') { S.mode = 'toggle'; paint(); return; }
    finish(true);
  }
  // apertar: parado → começa; gravando em modo toque → envia
  function press(term, by) {
    if (S.phase === 'idle') return start(term, by);
    if ((S.phase === 'recording' || S.phase === 'starting') && S.mode === 'toggle') { S.mode = 'done'; return finish(true); }
  }

  function onEsc(e) { if (e.key === 'Escape' && (S.phase === 'recording' || S.phase === 'starting')) { e.preventDefault(); e.stopPropagation(); finish(false); } }

  function teardown() {
    clearInterval(S.tick); S.tick = 0;
    document.removeEventListener('keydown', onEsc, true);
    try { if (S.node) { S.node.onaudioprocess = null; S.node.disconnect(); } } catch {}
    try { if (S.src) S.src.disconnect(); } catch {}
    try { if (S.stream) S.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { if (S.ctx) S.ctx.close(); } catch {}
    S.node = S.src = S.stream = S.ctx = null; S.level = 0;
  }
  function reset() { S.phase = 'idle'; S.term = null; S.chunks = []; S.n = 0; paint(); }

  async function finish(send) {
    if (S.phase !== 'recording' && S.phase !== 'starting') return;
    const term = S.term;
    const wasRecording = S.phase === 'recording';
    const pcm = wasRecording && send ? resample(join(S.chunks, Math.min(S.n, MAX_S * S.inRate)), S.inRate) : null;
    S.chunks = []; S.n = 0;
    teardown();
    if (!send || !pcm) { reset(); if (!send) toast('Gravação cancelada'); return; }
    if (pcm.length < MIN_S * RATE) { reset(); toast('Gravação curta demais: segure o 🎤 enquanto fala'); return; }
    S.phase = 'sending'; paint();
    const t0 = performance.now();
    try {
      const r = await B.voice.transcribe(term, encodeWav(pcm));
      window.__voiceLast = { ms: Math.round(performance.now() - t0), engineMs: r.ms, seconds: r.seconds, chars: (r.text || '').length, pasted: r.pasted };
      if (!r.text) toast('Não deu para entender a gravação. Tente de novo, mais perto do microfone.', 4000);
      else if (!r.pasted) toast('O terminal não está rodando: o texto não foi colado.', 5000);
      else if (window.Terminals) window.Terminals.focus(term);
    } catch (e) {
      const code = window.UI.errCode(e);
      if (code === 'NO_MODEL') { reset(); return openDownload(); }
      toast(String(e.message).replace(/^\[[A-Z_]+\]\s*/, ''), 5000);
    }
    reset();
  }

  async function openDownload() { try { downloadModal(await B.voice.status()); } catch (e) { toast(e.message); } }

  // ---------- microfone negado ----------
  function micDenied(e) {
    const name = e && e.name;
    if (name === 'NotFoundError' || name === 'OverconstrainedError') { toast('Nenhum microfone encontrado neste computador.', 5000); return; }
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      modal((c, close) => c.append(h('h2', { text: 'O microfone está bloqueado para a Bancada' }),
        h('p', { class: 'small', text: 'Para falar com a IA pelo 🎤, libere o microfone:' }),
        h('p', { class: 'small', text: T.micHelp }),
        h('p', { class: 'muted small', text: 'O áudio nunca sai do computador: vira texto aqui mesmo e é apagado.' }),
        h('div', { class: 'row end' }, h('button', { class: 'aurora-btn aurora-btn--primary', onclick: close }, 'Entendi'))));
      return;
    }
    toast('Não deu para abrir o microfone: ' + ((e && e.message) || e), 5000);
  }

  // ---------- baixar o modelo ----------
  const mb = (b) => Math.round(b / 1048576 / 10) * 10;   // "≈ 550 MB"
  function downloadModal(st) {
    let off = null;
    modal((c, close) => {
      const bar = h('progress', { class: 'voice-progress', max: String(st.model.size), value: '0' });
      const info = h('p', { class: 'muted small', text: st.downloading ? 'Baixando…' : '' });
      const go = h('button', { class: 'aurora-btn aurora-btn--primary' }, `Baixar voz (≈ ${mb(st.model.size)} MB)`);
      const stop = h('button', { class: 'aurora-btn aurora-btn--text', onclick: () => { B.voice.cancel().catch(() => {}); } }, 'Parar download');
      off = B.voice.onProgress((p) => {
        bar.value = p.got;
        info.textContent = p.phase === 'conferindo' ? 'Conferindo o arquivo (SHA-256)…' : p.phase === 'pronto' ? 'Pronto.' : `${Math.round(p.got / p.total * 100)}% · ${mb(p.got)} de ${mb(p.total)} MB`;
      });
      go.addEventListener('click', async () => {
        go.disabled = true; info.textContent = 'Começando…';
        try { await B.voice.download(); info.textContent = 'Pronto! Segure o 🎤 e fale. (A 1ª vez prepara o motor em segundo plano.)'; go.textContent = 'Baixado'; }
        catch (e) { go.disabled = false; info.textContent = String(e.message).replace(/^\[[A-Z_]+\]\s*/, ''); }
      });
      if (st.downloading) go.disabled = true;
      c.append(h('h2', { text: 'Voz no terminal' }),
        h('p', { class: 'small', text: `Fale e o texto aparece no terminal, sem Enter (você confere antes). Tudo acontece neste ${T.host}: o áudio não vai para a internet.` }),
        h('p', { class: 'small', text: `Antes, a Bancada precisa baixar o modelo de voz uma vez (${st.model.label}, do Hugging Face, conferido pela assinatura do arquivo). Se a internet cair, continua de onde parou.` }),
        bar, info, h('div', { class: 'row end' }, stop, h('button', { class: 'aurora-btn aurora-btn--text', onclick: close }, 'Fechar'), go));
    }, { onClose: () => { if (off) off(); } });
  }

  // ---------- Checagem (Ajustes → Voz no terminal) ----------
  // checkLine vem do app.js (mesma linha ✅/❌/• das IAs). A Checagem pronta vem do processo principal (checkup.js).
  // um ouvinte de progresso só: o da seção aberta por último; sai ao fechar os Ajustes (closeSettings) ou ao reabrir
  let settingsOff = null;
  function closeSettings() { if (settingsOff) { try { settingsOff(); } catch {} settingsOff = null; } }
  function settingsSection(checkLine) {
    const box = h('div', { class: 'voice-check' });
    if (!B.voice) { box.append(h('p', { class: 'muted small', text: `${T.voiceRemote}.` })); return box; }
    closeSettings();
    let off = null;
    const paint = async () => {
      let st; try { st = await B.voice.status(); } catch (e) { box.replaceChildren(h('p', { class: 'small amber-text', text: e.message })); return; }
      if (!box.isConnected && off) { off(); if (settingsOff === off) settingsOff = null; off = null; return; }
      const lines = (st.checkup ? st.checkup.steps : []).map(sp => checkLine(sp.fix === 'mic' ? { ...sp, hint: T.micHelp } : sp));
      const bar = st.downloading ? h('progress', { class: 'voice-progress', max: String(st.downloading.total), value: String(st.downloading.got) }) : null;
      const fixes = new Set((st.checkup ? st.checkup.steps : []).map(s => s.fix).filter(Boolean));
      const btn = (cls, label, fn) => h('button', { class: `aurora-btn ${cls} sm`, onclick: fn }, label);
      const model = h('select', { class: 'aurora-input sm', title: 'Modelo de voz' }, st.models.map(m => h('option', { value: m.id, text: m.label, selected: m.id === st.model.id })));
      model.addEventListener('change', async () => { try { await B.voice.setModel(model.value); } catch (e) { toast(e.message); } paint(); });
      box.replaceChildren(...lines, bar || '',
        h('div', { class: 'row wrap' },
          fixes.has('download') && !st.downloading ? btn('aurora-btn--primary', `Baixar voz (≈ ${mb(st.model.size)} MB)`, () => { B.voice.download().then(() => paint(), (e) => { toast(String(e.message).replace(/^\[[A-Z_]+\]\s*/, ''), 5000); paint(); }); setTimeout(paint, 400); }) : null,
          st.downloading ? btn('aurora-btn--text', 'Parar download', () => B.voice.cancel().finally(paint)) : null,
          fixes.has('vc') ? btn('aurora-btn--primary', 'Instalar runtime', () => B.voice.openHelp('vc')) : null,
          fixes.has('mic') ? btn('aurora-btn--glass', 'Abrir ajustes do microfone', () => B.voice.openHelp('mic')) : null,
          h('label', { class: 'muted small' }, 'Modelo: ', model),
          btn('aurora-btn--text', 'Testar', () => paint())),
        h('p', { class: 'muted small', text: `Segure o 🎤 no cabeçalho do terminal (ou ${T.voiceKey}) e fale; solte e o texto aparece sem Enter. O áudio não sai deste ${T.host}.` }));
    };
    off = settingsOff = B.voice.onProgress((p) => { const b = box.querySelector('.voice-progress'); if (b) b.value = p.got; if (p.phase === 'pronto' || !b) paint(); });
    paint();
    return box;
  }

  // ---------- botão e atalho ----------
  function button(id) {
    // celular/iPad: microfone exige HTTPS (o remoto é HTTP no Tailscale) → botão apagado que explica
    if (!B.voice) return window.__REMOTE ? h('button', { class: 'pane-mic off', 'aria-disabled': 'true', title: T.voiceRemote, 'aria-label': T.voiceRemote,
      onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); toast(`${T.voiceRemote}: o navegador do celular só libera o microfone em conexão segura (HTTPS).`, 4000); } }, '🎤') : null;
    const mine = S.term === id && S.phase !== 'idle';
    const b = h('button', { class: `pane-mic ${mine ? 'on' : ''} ${mine && S.phase === 'sending' ? 'sending' : ''}`, dataset: { id },
      title: `Falar: segure para gravar e solte para enviar · toque para ligar/desligar · Esc cancela (${T.voiceKey}). O texto cai no terminal sem Enter.`,
      onmousedown: (e) => e.stopPropagation(), 'aria-label': 'Falar' }, '🎤');
    b.addEventListener('pointerdown', (e) => { if (e.button) return; e.preventDefault(); e.stopPropagation(); press(id, 'pointer'); });
    return b;
  }

  const isVoiceKey = (e) => (T.win ? e.ctrlKey && e.shiftKey && !e.metaKey : e.metaKey && e.shiftKey && !e.ctrlKey) && !e.altKey && (e.key === 'm' || e.key === 'M');
  function onKeyDown(e) {
    if (!isVoiceKey(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat) return;
    const term = S.phase === 'idle' ? opts.currentTerm() : S.term;
    if (!term) { toast('Abra um terminal para falar com ele'); return; }
    press(term, 'key');
  }
  // no Mac o soltar da letra com ⌘ apertado nem sempre chega: soltar o ⌘/Ctrl/Shift também conta
  function onKeyUp(e) { if (S.by === 'key' && ['m', 'M', 'Meta', 'Control', 'Shift'].includes(e.key)) release(); }

  function init(o = {}) {
    opts = { ...opts, ...o };
    if (!B.voice) return;
    window.addEventListener('pointerup', () => { if (S.by === 'pointer') release(); });
    window.addEventListener('pointercancel', () => { if (S.by === 'pointer') release(); });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    // janela perdeu o foco no meio de "segurar": vira modo toque (não envia sozinho, não perde a gravação)
    window.addEventListener('blur', () => { if (S.mode === 'hold' && (S.phase === 'recording' || S.phase === 'starting')) { S.mode = 'toggle'; paint(); } });
  }

  window.VoiceUI = { init, button, paint, openDownload, settingsSection, closeSettings, cancel: () => finish(false), press, release,
    _setSource: (fn) => { source = fn; synthetic = true; }, _state: () => ({ phase: S.phase, term: S.term, mode: S.mode, seconds: S.n / S.inRate }),
    _test: { resample, encodeWav, join } };
})();
