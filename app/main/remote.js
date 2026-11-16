// Acesso remoto da Bancada (Emenda 1, D26): celular/iPad usam a MESMA tela, terminais incluídos.
// Rede (decisão de projeto, 2026-11-05): SÓ pelo IP do Tailscale do Mac (100.64.0.0/10). Nada na LAN, nada na internet.
// O transporte já é criptografado ponta a ponta pelo WireGuard do Tailscale; por isso HTTP simples dentro do tailnet.
// Camadas: bind só no IP do tailnet · Host e Origin conferidos (anti DNS-rebinding / CSWSH) · pareamento por QR de uso
// único (5 min) · token por aparelho (guardado só como hash) · revogação · canais de desktop bloqueados no remoto.
'use strict';
const plat = require('./platform');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT_DEFAULT = 8791;
const PAIR_TTL_MS = 5 * 60 * 1000;
const MAX_MSG = 15 * 1024 * 1024;      // foto do celular para o Claude (E4) vai em base64, até 10 MB
const MAX_CLIENTS = 6;
const PAIR_FAIL_LIMIT = 10;              // tentativas erradas por janela de 10 min → pareamento trava

// Canais que só fazem sentido (ou só são seguros) no Mac: escolher pasta, abrir app, mexer em motor/remoto, importar.
const BLOCKED = new Set(['app:pickFolder', 'app:openInCursor', 'app:importPromptPad', 'capture:submit', 'capture:hide',
  'engines:add', 'engines:update', 'engines:remove', 'engines:setDefault', 'remote:status', 'remote:enable', 'remote:disable',
  'remote:pairStart', 'remote:revoke', 'remote:devices', 'ui:focusTerm',
  'files:reveal', 'files:openInCursor', 'attach:clipboard', 'preview:open', 'ui:layoutSet',
  // instalar/atualizar/consertar/login de IA mexem no Mac e abrem o navegador do Mac: só no próprio Mac (o status pode)
  'ai:install', 'ai:update', 'ai:cancel', 'ai:shellCheck', 'ai:fixShell', 'ai:firstProject',
  // v0.6: o celular não dispara consulta aos servidores nem abre o arquivo da lista no Mac
  'servers:refresh', 'servers:edit',
  // links: Finder e Safari são do Mac (no celular o link da web abre no próprio aparelho)
  'links:openDir', 'links:reveal', 'links:openUrl',
  // v0.8: o diagnóstico copia para a área de transferência do computador e lê o registro: só no próprio computador
  'diag:report',
  // v0.8: voz (microfone, modelo, motor) e recorte de tela são do computador; a foto do celular usa o attach:image
  'voice:status', 'voice:download', 'voice:cancel', 'voice:setModel', 'voice:transcribe', 'voice:openHelp',
  'shot:screen', 'shot:send', 'shot:cancel', 'shot:abort', 'shot:status',
  // v0.8: atualização é do computador
  'update:status', 'update:check', 'update:setAuto']);
// e qualquer canal novo dessas famílias, mesmo que esquecido na lista acima
const BLOCKED_PREFIX = /^(voice|shot|update):/;
// Lista de LIBERAÇÃO: só estes canais são atendidos para o celular. Canal novo no index.js fica bloqueado até alguém
// decidir e pôr aqui ou em BLOCKED (o teste "todo canal classificado" falha enquanto isso não acontece).
const REMOTE_OK = new Set([
  // projetos, notas, dia
  'projects:list', 'projects:create', 'projects:update', 'projects:swapFocus', 'projects:discover', 'projects:git', 'projects:setActive', 'projects:reorder',
  'items:list', 'items:create', 'items:update', 'items:delete', 'items:today', 'items:reorder', 'today:suggest', 'today:set',
  // terminais (o celular pode o mesmo que digitar no terminal; login das IAs barrado por isLoginTerm)
  'terminals:list', 'terminals:save', 'terminals:remove', 'terminals:byIds', 'terminals:newConversation', 'terminals:reorder', 'terminals:initialPrompt',
  'pty:create', 'pty:kill', 'pty:live', 'pty:replay', 'pty:paste', 'pty:write', 'pty:resize',
  // cartões, estado do Claude, motores (só leitura), IAs (só status)
  'asks:list', 'asks:answer', 'asks:dismiss', 'claude:states', 'claude:context', 'claude:seen',
  'engines:list', 'engines:check', 'engines:details', 'engines:suggest', 'ai:installed', 'ai:status',
  // arquivos e git dentro do projeto; foto do celular → anexo
  'files:roots', 'files:list', 'files:read', 'git:status', 'git:diff', 'git:commit', 'attach:image',
  // sessões, resumo, faixa de atividade, servidores (leitura), layout (leitura)
  'sessions:forProject', 'sessions:unassigned', 'sessions:assign', 'sessions:rescan', 'summary:refresh', 'summary:status',
  'activity:list', 'servers:list', 'ui:layoutGet',
  // v0.8: pulso do projeto (o aparelho já vê os terminais), medidor de limite (só %), cartões de retorno (a nota do
  // feedback:answer é limpa de controles e passa pela redação do registro antes de entrar no "Relatar problema")
  'pulse:list', 'limits:get', 'feedback:current', 'feedback:answer', 'feedback:dismiss',
  // aguardando decisão: links:readMd lê qualquer .md; settings:set muda atalho/skip padrão
  'links:resolve', 'links:readMd', 'settings:get', 'settings:set',
]);
// terminal de login das IAs (ai-login-*): nem abrir, nem digitar, nem ver pelo celular
const isLoginTerm = (m) => /^pty:/.test(m.ch) && m.args && (/^ai-login-/.test(String(m.args[0] && typeof m.args[0] === 'object' ? m.args[0].id : m.args[0])));

// Arquivos que a página remota pode baixar (lista fechada; nada de caminho vindo do cliente)
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/dom.js': 'dom.js', '/dnd.js': 'dnd.js',
  '/terminals.js': 'terminals.js', '/layout.js': 'layout.js', '/files-panel.js': 'files-panel.js', '/asks-ui.js': 'asks-ui.js', '/office-model.js': 'office-model.js', '/voice-ui.js': 'voice-ui.js', '/camera-ui.js': 'camera-ui.js', '/activity-ui.js': 'activity-ui.js', '/app.js': 'app.js', '/remote-bridge.js': 'remote-bridge.js', '/mobile.css': 'mobile.css',
  '/vendor/xterm.js': 'vendor/xterm.js', '/vendor/xterm.css': 'vendor/xterm.css', '/vendor/addon-fit.js': 'vendor/addon-fit.js',
  '/vendor/addon-web-links.js': 'vendor/addon-web-links.js', '/vendor/addon-unicode11.js': 'vendor/addon-unicode11.js', '/vendor/aurora-tokens.css': 'vendor/aurora-tokens.css',
  '/office3d.js': 'office3d.js', '/md-view.js': 'md-view.js', '/vendor/three/three.module.js': 'vendor/three/three.module.js', '/vendor/three/three.core.js': 'vendor/three/three.core.js', '/vendor/three/OrbitControls.js': 'vendor/three/OrbitControls.js',
  '/assets/bancada-logo-128.png': 'assets/bancada-logo-128.png', '/apple-touch-icon.png': 'assets/bancada-logo-128.png',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function safeEq(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// IP do Tailscale deste Mac (faixa CGNAT 100.64.0.0/10). Sem Tailscale ligado → null (o remoto não sobe).
function tailscaleIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

class Remote {
  constructor({ store, rendererDir, handlers, port, onClientsChange = () => {}, keepAwake = () => {}, ipProvider = tailscaleIp }) {
    this.store = store; this.dir = rendererDir; this.handlers = handlers; this.port = port || PORT_DEFAULT;
    this.onClientsChange = onClientsChange; this.keepAwake = keepAwake; this.ipProvider = ipProvider;
    this.server = null; this.wss = null; this.ip = null; this.clients = new Set();
    this.pairing = null; this.pairFails = []; this.retry = null;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS remote_devices (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER)`);
  }

  status() {
    return { enabled: !!this.store.kvGet('remote_enabled', false), running: !!this.server, ip: this.ip, port: this.port,
      url: this.ip ? `http://${this.ip}:${this.port}` : null, clients: this.clients.size, tailscale: !!this.ipProvider(),
      pairing: this.pairing && this.pairing.expires > Date.now() ? { expires: this.pairing.expires } : null };
  }

  devices() { return this.store.db.prepare('SELECT id,name,created_at,last_seen FROM remote_devices ORDER BY created_at').all(); }

  revoke(id) {
    this.store.db.prepare('DELETE FROM remote_devices WHERE id=?').run(id);
    // revogar corta na hora: a partir daqui nada desse aparelho é atendido, e o socket cai mesmo que o cliente ignore o
    // fechamento (antes ele ainda digitava por ~30 s)
    for (const c of this.clients) if (c.deviceId === id) { c.revoked = true; try { c.ws.close(4001, 'revogado'); } catch {} setTimeout(() => { try { c.ws.terminate(); } catch {} }, 1000).unref(); }
    return true;
  }

  async enable() { this.store.kvSet('remote_enabled', true); return this.start(); }
  disable() { this.store.kvSet('remote_enabled', false); this.stop(); return this.status(); }

  start() {
    if (this.server) return Promise.resolve(this.status());
    const ip = this.ipProvider();
    if (!ip) {
      // Tailscale desligado: tenta de novo a cada 30 s (um timer só), nunca cai para a LAN
      clearTimeout(this.retry);
      this.retry = setTimeout(() => { this.retry = null; if (this.store.kvGet('remote_enabled', false)) this.start().catch(() => {}); }, 30000);
      return Promise.resolve({ ...this.status(), error: `Tailscale não está ligado neste ${plat.MACHINE}` });
    }
    this.ip = ip;
    this.server = http.createServer((req, res) => this.serve(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
    this.server.on('upgrade', (req, sock, head) => this.upgrade(req, sock, head));
    return new Promise((resolve) => {
      this.server.once('error', (e) => { this.server = null; this.wss = null; this.ip = null; resolve({ ...this.status(), error: e.message }); });
      this.server.listen(this.port, ip, () => { this.keepAwake(true); resolve(this.status()); });
    });
  }

  stop() {
    clearTimeout(this.retry); this.retry = null;
    // como na revogação: nada mais é atendido e o socket cai mesmo que o cliente ignore o fechamento
    for (const c of this.clients) {
      c.revoked = true;
      try { c.ws.close(1001, 'remoto desligado'); } catch {}
      setTimeout(() => { try { c.ws.terminate(); } catch {} }, 1000).unref();
    }
    this.clients.clear();
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    this.server = null; this.wss = null; this.ip = null; this.pairing = null;
    this.keepAwake(false); this.onClientsChange(0);
  }

  hostOk(req) { return req.headers.host === `${this.ip}:${this.port}`; }

  headers(extra = {}) {
    return {
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...extra,
    };
  }

  serve(req, res) {
    if (!this.hostOk(req)) { res.writeHead(421, this.headers()); return res.end(); }
    const url = new URL(req.url, `http://${this.ip}:${this.port}`);
    if (req.method === 'POST' && url.pathname === '/pair') return this.pair(req, res);
    if (req.method !== 'GET') { res.writeHead(405, this.headers()); return res.end(); }
    const rel = STATIC[url.pathname];
    if (!rel) { res.writeHead(404, this.headers()); return res.end(); }
    let body;
    try { body = fs.readFileSync(path.join(this.dir, rel)); } catch { res.writeHead(404, this.headers()); return res.end(); }
    if (rel === 'index.html') {
      // mesma tela do Mac; troca a ponte do Electron pela ponte remota e acrescenta o CSS de celular
      body = Buffer.from(String(body)
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
        // data-host: o sistema do computador (o celular precisa para pôr aspas certas no caminho colado no terminal)
        // atualização é só do computador: o script nem vai para o celular
        .replace('<script src="update-ui.js"></script>\n', '')
        .replace('<script src="dom.js"></script>', `<script src="remote-bridge.js" data-host="${process.platform === 'win32' ? 'win32' : 'darwin'}"></script>\n<script src="dom.js"></script>`)
        .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<meta name="apple-mobile-web-app-title" content="Bancada">\n<link rel="stylesheet" href="mobile.css">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
    }
    res.writeHead(200, this.headers({ 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' }));
    res.end(body);
  }

  // Abre uma janela de pareamento: devolve a URL do QR (o código vai no #fragmento, que não vai para log nem para o servidor no GET)
  pairStart() {
    if (!this.server) throw new Error('acesso remoto desligado');
    const code = crypto.randomBytes(18).toString('base64url');
    this.pairing = { hash: sha(code), expires: Date.now() + PAIR_TTL_MS };
    return { url: `http://${this.ip}:${this.port}/#pair=${code}`, expires: this.pairing.expires };
  }

  pair(req, res) {
    const now = Date.now();
    this.pairFails = this.pairFails.filter(t => now - t < 10 * 60 * 1000);
    const deny = (code, msg) => { res.writeHead(code, this.headers({ 'Content-Type': 'application/json' })); res.end(JSON.stringify({ error: msg })); };
    if (this.pairFails.length >= PAIR_FAIL_LIMIT) return deny(429, `muitas tentativas; gere um QR novo no ${plat.MACHINE} daqui a pouco`);
    if (req.headers.origin && req.headers.origin !== `http://${this.ip}:${this.port}`) return deny(403, 'origem recusada');
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let body; try { body = JSON.parse(raw); } catch { return deny(400, 'pedido inválido'); }
      const ok = this.pairing && this.pairing.expires > now && typeof body.code === 'string' && safeEq(sha(body.code), this.pairing.hash);
      if (!ok) { this.pairFails.push(now); return deny(401, 'código inválido ou vencido'); }
      this.pairing = null;                                   // uso único
      const token = crypto.randomBytes(32).toString('base64url');
      const id = crypto.randomBytes(8).toString('hex');
      const name = String(body.name || 'aparelho').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'aparelho';
      this.store.db.prepare('INSERT INTO remote_devices (id,name,token_hash,created_at) VALUES (?,?,?,?)').run(id, name, sha(token), now);
      res.writeHead(200, this.headers({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ token, device: id }));
    });
  }

  upgrade(req, sock, head) {
    const fail = (code) => { try { sock.write(`HTTP/1.1 ${code} No\r\n\r\n`); } catch {} sock.destroy(); };
    if (!this.hostOk(req)) return fail(421);
    if (req.headers.origin !== `http://${this.ip}:${this.port}`) return fail(403);
    if (this.clients.size >= MAX_CLIENTS) return fail(503);
    // token no subprotocolo (não vai para a URL nem para logs): "bancada.<token>"
    const proto = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).find(s => s.startsWith('bancada.'));
    const token = proto ? proto.slice('bancada.'.length) : '';
    const dev = token ? this.store.db.prepare('SELECT id,name FROM remote_devices WHERE token_hash=?').get(sha(token)) : null;
    if (!dev) return fail(401);
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      const client = { ws, deviceId: dev.id };
      this.clients.add(client); this.onClientsChange(this.clients.size);
      this.store.db.prepare('UPDATE remote_devices SET last_seen=? WHERE id=?').run(Date.now(), dev.id);
      ws.on('message', (data) => this.onMessage(client, data));
      ws.on('close', () => { this.clients.delete(client); this.onClientsChange(this.clients.size); });
      ws.on('error', () => {});
    });
  }

  async onMessage(client, data) {
    if (client.revoked) return;
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m.ch !== 'string' || !Array.isArray(m.args)) return;
    // escrita/resize de terminal: sem resposta (alta frequência)
    if (isLoginTerm(m)) { if (m.ch !== 'pty:write' && m.ch !== 'pty:resize') client.ws.send(JSON.stringify({ id: m.id, ok: false, error: 'não disponível no acesso remoto', code: 'REMOTE_BLOCKED' })); return; }
    if (m.ch === 'pty:write' || m.ch === 'pty:resize') { const fn = this.handlers.get(m.ch); if (fn) fn(...m.args); return; }
    const reply = (r) => { if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ id: m.id, ...r })); };
    if (BLOCKED.has(m.ch) || BLOCKED_PREFIX.test(String(m.ch)) || !REMOTE_OK.has(m.ch)) return reply({ ok: false, error: 'não disponível no acesso remoto', code: 'REMOTE_BLOCKED' });
    const fn = this.handlers.get(m.ch);
    if (!fn) return reply({ ok: false, error: 'canal desconhecido', code: 'ERR' });
    try { reply({ ok: true, data: await fn(...m.args) }); }
    catch (e) { reply({ ok: false, error: e.message, code: e.code || 'ERR' }); }
  }

  broadcast(channel, payload) {
    if (!this.clients.size) return;
    const msg = JSON.stringify({ ev: channel, payload });
    for (const c of this.clients) if (c.ws.readyState === 1 && c.ws.bufferedAmount < 8 * 1024 * 1024) c.ws.send(msg);
  }
}

module.exports = { Remote, tailscaleIp, BLOCKED, BLOCKED_PREFIX, REMOTE_OK, PORT_DEFAULT, isLoginTerm };
