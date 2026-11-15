// Escritório 3D (v0.6): maquete Aurora que você gira (arrastar) e aproxima (rolar/pinça).
// Tudo feito por código (sem modelo 3D, sem imagem): mesas, lounge, sala de reunião e sala de servidores de vidro.
// Os bonecos são os Claudes (crachá na cor do terminal) e os agentes que eles chamam; cada um anima o que está fazendo
// (digitar, ler, pesquisar, rodar comando, levantar a mão quando espera você, sofá/café quando parado).
// Zero IA: só desenha o que o processo principal já sabe (activity:changed, servers:changed).
// CPU/memória: desenha só quando algo mexe (0 quadros/s com a sala parada), no máximo 30 quadros/s, nada com a janela
// escondida; tudo o que é criado no mount é liberado no unmount (geometria, material, textura, renderer).
import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const MAX_ACTORS = 40;
const FPS_MS = 1000 / 30;
const WALK = 2.4;                 // unidades por segundo
const ROOM = { x0: -15, x1: 15, z0: -9, z1: 9 };
const CELL = 0.5;
const GW = (ROOM.x1 - ROOM.x0) / CELL, GH = (ROOM.z1 - ROOM.z0) / CELL;
const DOOR = { x: -13.6, z: 8.4 };
const ST_COLOR = { ok: '#30d158', lento: '#ffb020', fora: '#ff453a', 'sem-rota': '#8e8e93', esperando: '#c7c7cc', configurar: '#5e5ce6' };
const ST_TEXT = { ok: 'no ar', lento: 'lento', fora: 'sem resposta', 'sem-rota': 'fora de alcance', esperando: 'consultando…', configurar: 'configurar' };
const AMBER = '#ff9f0a';

// ------- layout fixo da sala (posições em unidades; y para cima, z para quem olha) -------
const DESKS = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) DESKS.push({ x: -12.4 + c * 3.0, z: -6.4 + r * 3.4 });
const MEET = { x0: 0, x1: 7, z0: -8.6, z1: -2, door: [1.0, 2.6] };
const SRV = { x0: 8.4, x1: 14.6, z0: -8.6, z1: -2, door: [9.0, 10.6] };
const MEET_SEATS = [];
// ry = giro da cadeira (o encosto fica do lado oposto à mesa); quem senta olha para a mesa
for (let i = 0; i < 4; i++) { MEET_SEATS.push({ x: 2.2 + i * 1.0, z: -6.5, ry: Math.PI }); MEET_SEATS.push({ x: 2.2 + i * 1.0, z: -4.0, ry: 0 }); }
const SOFA_SPOTS = [{ x: 6.0, z: 7.35 }, { x: 7.0, z: 7.35 }, { x: 8.0, z: 7.35 }, { x: 9.0, z: 7.35 }, { x: 11.05, z: 6.1 }, { x: 11.05, z: 5.1 }];
const COFFEE = { x: 13.0, z: 2.2 };
const STATIONS = [{ x: -1.2, z: 3.6 }, { x: -1.2, z: 5.4 }, { x: -1.2, z: 7.2 }];

function supported() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

// ------- estado de uma montagem -------
let S = null;

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const bg = (cs.getPropertyValue('--bg') || '#ececf1').trim() || '#ececf1';
  const c = new THREE.Color(bg); const dark = c.r * 0.3 + c.g * 0.59 + c.b * 0.11 < 0.35;
  const neon = (cs.getPropertyValue('--neon') || '#7c5cff').trim() || '#7c5cff';
  return dark ? {
    dark, bg, neon, floor: '#22222a', floor2: '#2a2a33', wall: '#303039', desk: '#3a3a44', top: '#474752', chair: '#34343d', glass: '#aab0ff', glassOp: 0.09,
    frame: '#565662', sofa: '#43434f', cushion: '#4d4d5a', plant: '#4c9a6c', pot: '#3a3a43', metal: '#6a6a75', screen: '#0b0b0e', rack: '#17171c', body: '#8a8a99', head: '#b4b4c2', txt: '#f5f5f7', sub: '#a1a1aa',
  } : {
    dark, bg, neon, floor: '#e2e2e8', floor2: '#dcdce3', wall: '#f5f5f8', desk: '#fbfbfd', top: '#ffffff', chair: '#d4d4db', glass: '#c9ccff', glassOp: 0.22,
    frame: '#c4c4cc', sofa: '#cdced8', cushion: '#d9dae3', plant: '#5e9e72', pot: '#e9e9ee', metal: '#b4b4bc', screen: '#1d1d1f', rack: '#2b2b31', body: '#dcdce3', head: '#f2f2f6', txt: '#1d1d1f', sub: '#6e6e73',
  };
}

// ------- ajudantes de criação (tudo registrado para liberar no unmount) -------
function track(o) { S.owned.push(o); return o; }
function mat(key, opts) {
  if (S.mats[key]) return S.mats[key];
  return (S.mats[key] = track(new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, ...opts })));
}
function geo(key, make) { return S.geos[key] || (S.geos[key] = track(make())); }
function box(w, h, d, m, x, y, z, { cast = true, receive = true, parent = S.room } = {}) {
  const g = geo(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
  const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); mesh.castShadow = cast; mesh.receiveShadow = receive; parent.add(mesh); return mesh;
}
function rbox(w, h, d, r, m, x, y, z, opts) {   // caixa arredondada: Aurora sem quina dura
  const g = geo(`r${w}|${h}|${d}|${r}`, () => {
    const s = new THREE.Shape(); const hw = w / 2 - r, hd = d / 2 - r;
    s.moveTo(-hw, -d / 2); s.lineTo(hw, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -hd); s.lineTo(w / 2, hd); s.quadraticCurveTo(w / 2, d / 2, hw, d / 2);
    s.lineTo(-hw, d / 2); s.quadraticCurveTo(-w / 2, d / 2, -w / 2, hd); s.lineTo(-w / 2, -hd); s.quadraticCurveTo(-w / 2, -d / 2, -hw, -d / 2);
    const e = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 4 }); e.rotateX(-Math.PI / 2); e.translate(0, -h / 2, 0); return e;
  });
  const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z);
  mesh.castShadow = !opts || opts.cast !== false; mesh.receiveShadow = true; ((opts && opts.parent) || S.room).add(mesh); return mesh;
}
function cyl(rt, rb, h, m, x, y, z, seg = 16, parent = S.room) {
  const g = geo(`c${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
  const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function canvasTex(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const t = track(new THREE.CanvasTexture(c)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return { c, ctx: c.getContext('2d'), t };
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ------- obstáculos e caminhos (grade simples + A*) -------
const blocked = new Uint8Array(GW * GH);
function cellOf(x, z) { return [Math.max(0, Math.min(GW - 1, Math.floor((x - ROOM.x0) / CELL))), Math.max(0, Math.min(GH - 1, Math.floor((z - ROOM.z0) / CELL)))]; }
function block(x0, z0, x1, z1, pad = 0.2) {
  const [a, b] = cellOf(x0 - pad, z0 - pad); const [c, d] = cellOf(x1 + pad - 0.001, z1 + pad - 0.001);
  for (let i = a; i <= c; i++) for (let j = b; j <= d; j++) blocked[j * GW + i] = 1;
}
function wallLine(x0, z0, x1, z1, gap) {    // parede de vidro com vão de porta [g0,g1] no eixo x
  if (z0 === z1 && gap) { block(x0, z0 - 0.05, gap[0], z0 + 0.05, 0.15); block(gap[1], z0 - 0.05, x1, z0 + 0.05, 0.15); }
  else block(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), 0.15);
}
function findPath(from, to) {
  const [sx, sz] = cellOf(from.x, from.z); const [tx, tz] = cellOf(to.x, to.z);
  const start = sz * GW + sx, goal = tz * GW + tx;
  if (start === goal) return [{ x: to.x, z: to.z }];
  const g = new Float32Array(GW * GH).fill(Infinity); const came = new Int32Array(GW * GH).fill(-1); const closed = new Uint8Array(GW * GH);
  const open = [start]; g[start] = 0;
  const hfn = (k) => { const x = k % GW, z = (k / GW) | 0; return Math.hypot(x - tx, z - tz); };
  const free = (k) => k === goal || k === start || !blocked[k];
  let iter = 0;
  while (open.length && iter++ < 6000) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (g[open[i]] + hfn(open[i]) < g[open[bi]] + hfn(open[bi])) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur === goal) break;
    closed[cur] = 1;
    const cx = cur % GW, cz = (cur / GW) | 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz; if (nx < 0 || nz < 0 || nx >= GW || nz >= GH) continue;
      const k = nz * GW + nx; if (closed[k] || !free(k)) continue;
      if (dx && dz && (!free(cz * GW + nx) || !free(nz * GW + cx))) continue;   // não corta quina
      const ng = g[cur] + (dx && dz ? 1.414 : 1);
      if (ng < g[k]) { g[k] = ng; came[k] = cur; if (!open.includes(k)) open.push(k); }
    }
  }
  if (came[goal] < 0) return [{ x: to.x, z: to.z }];   // sem caminho: vai reto (nunca trava)
  const cells = []; for (let k = goal; k !== start && k >= 0; k = came[k]) cells.push(k);
  cells.reverse();
  // tira pontos em linha reta (anda mais natural)
  const pts = []; let pd = null;
  for (let i = 0; i < cells.length; i++) {
    const k = cells[i]; const nk = cells[i + 1];
    const d = nk != null ? `${(nk % GW) - (k % GW)},${((nk / GW) | 0) - ((k / GW) | 0)}` : null;
    if (d !== pd || nk == null) pts.push({ x: ROOM.x0 + (k % GW + 0.5) * CELL, z: ROOM.z0 + (((k / GW) | 0) + 0.5) * CELL });
    pd = d;
  }
  pts[pts.length - 1] = { x: to.x, z: to.z };
  return pts;
}

// ------- construção da sala -------
function buildRoom() {
  const P = S.pal; const room = S.room;
  blocked.fill(0);
  // piso em duas tonalidades (área de trabalho × lounge) e rodapé de luz neon só na borda
  const floor = box(30, 0.2, 18, mat('floor', { color: P.floor, roughness: 0.95 }), 0, -0.1, 0, { cast: false });
  floor.userData.floor = true;
  box(13.6, 0.02, 11, mat('floor2', { color: P.floor2, roughness: 0.95 }), -8.2, 0.011, -1.8, { cast: false });
  box(30, 3.2, 0.24, mat('wall', { color: P.wall, roughness: 0.9 }), 0, 1.6, ROOM.z0 - 0.12, { cast: false });
  box(0.24, 3.2, 18, mat('wall'), ROOM.x0 - 0.12, 1.6, 0, { cast: false });
  box(30, 0.03, 0.03, mat('neon', { color: P.neon, emissive: P.neon, emissiveIntensity: 1.4 }), 0, 0.03, ROOM.z0 + 0.02, { cast: false });
  block(ROOM.x0, ROOM.z0, ROOM.x1, ROOM.z0 + 0.05); block(ROOM.x0, ROOM.z0, ROOM.x0 + 0.05, ROOM.z1);

  // mesas (cada uma com monitor de textura própria e um filete neon que acende quando alguém trabalha)
  S.desks = DESKS.map((d, i) => {
    const g = new THREE.Group(); g.position.set(d.x, 0, d.z); room.add(g);
    rbox(1.9, 0.07, 0.95, 0.12, mat('top', { color: P.top, roughness: 0.5 }), 0, 0.76, 0, { parent: g });
    for (const sx of [-0.85, 0.85]) box(0.06, 0.74, 0.8, mat('metal', { color: P.metal, metalness: 0.5, roughness: 0.4 }), sx, 0.37, 0, { parent: g });
    const led = box(1.7, 0.02, 0.02, track(new THREE.MeshStandardMaterial({ color: P.frame, emissive: '#000000' })), 0, 0.73, 0.47, { parent: g, cast: false });
    // monitor
    const mon = canvasTex(256, 144);
    const screen = new THREE.Mesh(geo('scr', () => new THREE.PlaneGeometry(0.92, 0.52)), track(new THREE.MeshBasicMaterial({ map: mon.t, toneMapped: false })));
    screen.position.set(0, 1.18, -0.24); g.add(screen);
    box(0.98, 0.58, 0.04, mat('bezel', { color: P.rack, roughness: 0.4 }), 0, 1.18, -0.27, { parent: g });
    box(0.06, 0.32, 0.06, mat('metal'), 0, 0.95, -0.3, { parent: g });
    // cadeira (gira quando o comando roda)
    const chair = new THREE.Group(); chair.position.set(0, 0, 0.78); g.add(chair);
    rbox(0.62, 0.08, 0.58, 0.14, mat('chair', { color: P.chair }), 0, 0.48, 0, { parent: chair });
    rbox(0.62, 0.62, 0.08, 0.04, mat('chair'), 0, 0.84, 0.27, { parent: chair });
    cyl(0.04, 0.04, 0.44, mat('metal'), 0, 0.24, 0, 8, chair);
    block(d.x - 0.95, d.z - 0.5, d.x + 0.95, d.z + 0.45);
    const desk = { i, g, mon, screen, led, chair, seat: { x: d.x, z: d.z + 0.78 }, key: '' };
    drawMonitor(desk, null);
    return desk;
  });

  // sala de reunião de vidro
  glassRoom(MEET);
  rbox(4.4, 0.08, 1.5, 0.5, mat('top'), 3.7, 0.76, -5.25);
  cyl(0.08, 0.08, 0.72, mat('metal'), 3.7, 0.37, -5.25, 10);
  block(1.5, -6.0, 5.9, -4.5);
  for (const s of MEET_SEATS) { const c = new THREE.Group(); c.position.set(s.x, 0, s.z); c.rotation.y = s.ry; room.add(c); rbox(0.5, 0.08, 0.5, 0.14, mat('chair'), 0, 0.48, 0, { parent: c }); rbox(0.5, 0.5, 0.07, 0.03, mat('chair'), 0, 0.78, 0.24, { parent: c }); }
  S.meetScreen = canvasTex(256, 128);
  const ms = new THREE.Mesh(geo('mscr', () => new THREE.PlaneGeometry(2.4, 1.2)), track(new THREE.MeshBasicMaterial({ map: S.meetScreen.t, toneMapped: false })));
  ms.position.set(3.5, 1.7, MEET.z0 + 0.05); room.add(ms);

  // sala de servidores de vidro (racks montados em syncServers)
  glassRoom(SRV);
  S.racksGroup = new THREE.Group(); room.add(S.racksGroup);
  box(5.6, 0.02, 0.6, mat('grate', { color: P.metal, roughness: 0.6 }), 11.5, 0.012, -4.4, { cast: false });

  // lounge: sofá em L, mesa de centro, tapete, plantas, café, bebedouro
  box(7.6, 0.01, 4.6, mat('rug', { color: P.dark ? '#1f1f26' : '#d3d4dd', roughness: 1 }), 8.3, 0.006, 5.2, { cast: false });
  rbox(4.6, 0.42, 0.9, 0.2, mat('sofa', { color: P.sofa }), 7.5, 0.21, 7.55);
  rbox(4.6, 0.6, 0.25, 0.1, mat('sofa'), 7.5, 0.6, 7.95);
  rbox(0.9, 0.42, 2.6, 0.2, mat('sofa'), 11.25, 0.21, 5.6);
  rbox(0.25, 0.6, 2.6, 0.1, mat('sofa'), 11.65, 0.6, 5.6);
  for (const x of [6.0, 7.0, 8.0, 9.0]) rbox(0.86, 0.12, 0.7, 0.18, mat('cushion', { color: P.cushion }), x, 0.48, 7.5);
  block(5.2, 7.1, 9.8, 8.1); block(10.8, 4.3, 11.8, 6.9);
  rbox(1.8, 0.06, 0.9, 0.3, mat('top'), 7.6, 0.42, 5.4);
  cyl(0.05, 0.05, 0.4, mat('metal'), 7.6, 0.2, 5.4, 8);
  block(6.7, 5.0, 8.5, 5.85, 0.1);
  plant(4.6, 7.9, 1.1); plant(14.2, 7.9, 1.4); plant(-14.2, -8.2, 1.2); plant(-0.4, -8.2, 0.9); plant(14.2, -0.9, 1.0);
  // balcão do café (com máquina) e bebedouro
  rbox(2.4, 0.95, 0.7, 0.1, mat('top'), 13.2, 0.475, 1.2);
  rbox(0.5, 0.55, 0.42, 0.08, mat('bezel'), 12.8, 1.23, 1.15);
  box(0.12, 0.04, 0.02, mat('neon'), 12.8, 1.38, 1.37, { cast: false });
  cyl(0.06, 0.05, 0.11, mat('cup', { color: '#f5f5f7', roughness: 0.3 }), 13.4, 1.0, 1.2, 10);
  block(12.0, 0.85, 14.4, 1.55);
  cyl(0.2, 0.2, 1.0, mat('pot'), 14.3, 0.5, 3.4, 14); cyl(0.17, 0.17, 0.45, mat('water', { color: '#9ec9ff', transparent: true, opacity: 0.6, roughness: 0.1 }), 14.3, 1.22, 3.4, 14);
  block(14.0, 3.1, 14.6, 3.7, 0.1);

  // estações de tarefa em segundo plano (quiosques com barra de progresso)
  S.stations = STATIONS.map((p) => {
    const g = new THREE.Group(); g.position.set(p.x, 0, p.z); room.add(g);
    rbox(0.6, 1.1, 0.5, 0.1, mat('bezel'), 0, 0.55, 0, { parent: g });
    const tex = canvasTex(192, 96);
    const scr = new THREE.Mesh(geo('stscr', () => new THREE.PlaneGeometry(0.5, 0.25)), track(new THREE.MeshBasicMaterial({ map: tex.t, toneMapped: false })));
    scr.position.set(-0.31, 0.92, 0); scr.rotation.y = -Math.PI / 2; g.add(scr);
    block(p.x - 0.35, p.z - 0.3, p.x + 0.35, p.z + 0.3, 0.1);
    const st = { g, tex, key: '', spot: { x: p.x - 0.95, z: p.z } };
    drawStation(st, null);
    return st;
  });

  // quadro de pendências e relógio na parede do fundo
  S.board = canvasTex(512, 300);
  const board = new THREE.Mesh(geo('board', () => new THREE.PlaneGeometry(3.6, 2.1)), track(new THREE.MeshBasicMaterial({ map: S.board.t, toneMapped: false })));
  board.position.set(-8.2, 1.75, ROOM.z0 + 0.03); room.add(board); board.userData.board = true; S.pick.push(board);
  S.clock = canvasTex(128, 128);
  const clock = new THREE.Mesh(geo('clock', () => new THREE.CircleGeometry(0.42, 32)), track(new THREE.MeshBasicMaterial({ map: S.clock.t, transparent: true, toneMapped: false })));
  clock.position.set(-2.6, 2.2, ROOM.z0 + 0.03); room.add(clock);
  drawBoard(null); drawClock();
  // porta (só um batente + luz)
  box(0.08, 2.3, 0.08, mat('frame', { color: P.frame }), DOOR.x - 0.9, 1.15, ROOM.z1 - 0.05);
  box(0.08, 2.3, 0.08, mat('frame'), DOOR.x + 0.9, 1.15, ROOM.z1 - 0.05);
  box(1.88, 0.08, 0.08, mat('frame'), DOOR.x, 2.3, ROOM.z1 - 0.05);
  box(1.7, 0.02, 0.02, mat('neon'), DOOR.x, 2.24, ROOM.z1 - 0.02, { cast: false });
}

function glassRoom(R) {
  const P = S.pal;
  const glass = mat('glass', { color: P.glass, transparent: true, opacity: P.glassOp, roughness: 0.05, metalness: 0, depthWrite: false });
  const frame = mat('frame', { color: P.frame, roughness: 0.4, metalness: 0.4 });
  const H = 2.6;
  const wall = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0); if (len < 0.05) return;
    const m = box(z0 === z1 ? len : 0.04, H, z0 === z1 ? 0.04 : len, glass, (x0 + x1) / 2, H / 2, (z0 + z1) / 2, { cast: false, receive: false });
    m.renderOrder = 2;
    box(z0 === z1 ? len : 0.06, 0.06, z0 === z1 ? 0.06 : len, frame, (x0 + x1) / 2, H, (z0 + z1) / 2, { cast: false });
  };
  wall(R.x0, R.z0, R.x0, R.z1); wall(R.x1, R.z0, R.x1, R.z1);
  wall(R.x0, R.z1, R.door[0], R.z1); wall(R.door[1], R.z1, R.x1, R.z1);
  for (const [x, z] of [[R.x0, R.z1], [R.x1, R.z1], [R.door[0], R.z1], [R.door[1], R.z1], [R.x0, R.z0], [R.x1, R.z0]]) box(0.07, H, 0.07, frame, x, H / 2, z, { cast: false });
  wallLine(R.x0, R.z0, R.x0, R.z1); wallLine(R.x1, R.z0, R.x1, R.z1); wallLine(R.x0, R.z1, R.x1, R.z1, R.door);
}

function plant(x, z, h) {
  cyl(0.28, 0.22, 0.45, mat('pot', { color: S.pal.pot, roughness: 0.6 }), x, 0.225, z, 14);
  const leaf = mat('plant', { color: S.pal.plant, roughness: 0.8 });
  const g = geo('leaf', () => new THREE.IcosahedronGeometry(0.34, 0));
  for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(g, leaf); m.position.set(x + Math.sin(i * 2.1) * 0.12, 0.55 + (h - 0.5) * (i / 3) + 0.15, z + Math.cos(i * 2.1) * 0.12); m.scale.setScalar(1 - i * 0.16); m.rotation.set(i, i * 1.3, 0); m.castShadow = true; S.room.add(m); }
  block(x - 0.3, z - 0.3, x + 0.3, z + 0.3, 0.1);
}

// ------- texturas de tela -------
function drawMonitor(desk, info) {
  const key = info ? `${info.anim}|${info.verb}|${info.what}|${info.mode}|${S.pal.dark}` : `off|${S.pal.dark}`;
  if (desk.key === key) return; desk.key = key;
  const { ctx, c, t } = desk.mon; const P = S.pal;
  ctx.fillStyle = '#0b0b0e'; ctx.fillRect(0, 0, c.width, c.height);
  if (info) {
    const amber = info.mode === 'waiting';
    ctx.fillStyle = amber ? '#2a1d07' : info.mode === 'stalled' ? '#1a1a1d' : '#111019'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = amber ? AMBER : info.mode === 'stalled' ? '#8e8e93' : P.neon; ctx.fillRect(0, 0, c.width, 4);
    ctx.font = '600 22px -apple-system, "SF Pro Text", sans-serif'; ctx.fillStyle = '#f5f5f7';
    ctx.fillText(clip(info.verb || '', 18), 14, 40);
    ctx.font = '15px "SF Mono", Menlo, monospace'; ctx.fillStyle = '#a1a1aa';
    const w = clip(info.what || '', 60); ctx.fillText(w.slice(0, 26), 14, 70); if (w.length > 26) ctx.fillText(w.slice(26, 52), 14, 92);
    // "linhas de código" desenhadas (dá vida sem precisar de dado)
    for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#2a2a33' : '#33334a'; ctx.fillRect(14, 106 + i * 8, 40 + ((i * 53 + w.length * 7) % 160), 4); }
  } else {
    ctx.fillStyle = '#16161a'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#2a2a30'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c.width / 2, c.height / 2, 14, 0, Math.PI * 2); ctx.stroke();
  }
  t.needsUpdate = true;
  desk.led.material.emissive.set(info && info.mode !== 'stalled' ? (info.mode === 'waiting' ? AMBER : P.neon) : '#000000');
  desk.led.material.emissiveIntensity = info ? 1.3 : 0;
}

function drawStation(st, task) {
  const key = task ? `${task.what}|${task.pct}|${task.line}` : 'off';
  if (st.key === key) return; st.key = key;
  const { ctx, c, t } = st.tex;
  ctx.fillStyle = '#0b0b0e'; ctx.fillRect(0, 0, c.width, c.height);
  if (task) {
    ctx.font = '600 16px -apple-system, sans-serif'; ctx.fillStyle = '#f5f5f7'; ctx.fillText(clip(task.what || 'tarefa', 18), 10, 26);
    ctx.font = '12px Menlo, monospace'; ctx.fillStyle = '#a1a1aa'; ctx.fillText(clip(task.line || 'em segundo plano', 24), 10, 48);
    rr(ctx, 10, 64, c.width - 20, 12, 6); ctx.fillStyle = '#26262c'; ctx.fill();
    if (task.pct != null) { rr(ctx, 10, 64, Math.max(12, (c.width - 20) * task.pct / 100), 12, 6); ctx.fillStyle = S.pal.neon; ctx.fill(); }
  }
  t.needsUpdate = true;
}

function drawBoard(pend) {
  const list = (pend && pend.items) || []; list.total = (pend && pend.total) || list.length;
  const key = JSON.stringify(list.slice(0, 4)) + list.total + S.pal.dark;
  if (S.boardKey === key) return; S.boardKey = key;
  const { ctx, c, t } = S.board; const P = S.pal;
  ctx.fillStyle = P.dark ? '#1b1b20' : '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = P.neon; ctx.fillRect(0, 0, c.width, 5);
  ctx.font = '700 30px -apple-system, "SF Pro Display", sans-serif'; ctx.fillStyle = P.txt;
  ctx.fillText(list.length ? `Pendências · ${list.total || list.length}` : 'Pendências', 24, 52);
  ctx.font = '22px -apple-system, "SF Pro Text", sans-serif';
  if (!list.length) { ctx.fillStyle = P.sub; ctx.fillText('nada pendente neste projeto', 24, 100); }
  list.slice(0, 3).forEach((it, i) => {
    ctx.fillStyle = P.sub; ctx.beginPath(); ctx.arc(32, 100 + i * 52 - 7, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = P.txt; ctx.fillText(clip(it, 36), 48, 100 + i * 52);
  });
  if (list.length > 3) { ctx.fillStyle = P.sub; ctx.fillText(`+${(list.total || list.length) - 3}`, 48, 100 + 3 * 52); }
  t.needsUpdate = true;
}

function drawClock() {
  const { ctx, c, t } = S.clock; const P = S.pal; const d = new Date();
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = P.dark ? '#1b1b20' : '#ffffff'; ctx.beginPath(); ctx.arc(64, 64, 62, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = P.frame; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = P.sub; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; ctx.fillRect(64 + Math.sin(a) * 50 - 2, 64 - Math.cos(a) * 50 - 2, 4, 4); }
  const hand = (a, len, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(64, 64); ctx.lineTo(64 + Math.sin(a) * len, 64 - Math.cos(a) * len); ctx.stroke(); };
  hand(((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2, 30, 6, P.txt);
  hand(d.getMinutes() / 60 * Math.PI * 2, 44, 4, P.txt);
  ctx.fillStyle = P.neon; ctx.beginPath(); ctx.arc(64, 64, 5, 0, Math.PI * 2); ctx.fill();
  t.needsUpdate = true;
}

function drawMeetScreen(n) {
  const key = `${n}|${S.pal.dark}`; if (S.meetKey === key) return; S.meetKey = key;
  const { ctx, c, t } = S.meetScreen;
  ctx.fillStyle = '#0b0b0e'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = n ? S.pal.neon : '#2a2a30'; ctx.fillRect(0, 0, c.width, 4);
  ctx.font = '600 20px -apple-system, sans-serif'; ctx.fillStyle = n ? '#f5f5f7' : '#55555c';
  ctx.fillText(n ? `${n} agente${n > 1 ? 's' : ''} trabalhando` : 'sala livre', 16, 60);
  t.needsUpdate = true;
}

// ------- luz do dia (só a cor; atualiza a cada 10 min) -------
function dayLight() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const day = Math.max(0, Math.sin((h - 6) / 12 * Math.PI));       // 0 à noite, 1 ao meio-dia
  const warm = new THREE.Color('#ffd9a8'), cool = new THREE.Color('#ffffff'), night = new THREE.Color('#b8c0ff');
  const c = h < 6 || h > 19 ? night : cool.clone().lerp(warm, 1 - day);
  S.sun.color.copy(c); S.sun.intensity = (S.pal.dark ? 2.2 : 2.0) * (0.6 + 0.4 * day);
  S.hemi.intensity = S.pal.dark ? 1.9 : 1.7;
}

// ------- bonecos -------
function makeActor(w) {
  const P = S.pal;
  const g = new THREE.Group(); g.position.set(w.start.x, 0, w.start.z);
  const sc = w.kind === 'agent' ? 0.86 : 1; g.scale.setScalar(sc);
  const bodyM = track(new THREE.MeshStandardMaterial({ color: P.body, roughness: 0.6 }));
  const headM = mat('head', { color: P.head, roughness: 0.5 });
  const badgeM = track(new THREE.MeshStandardMaterial({ color: w.color, emissive: w.color, emissiveIntensity: 0.35, roughness: 0.4 }));
  const torso = new THREE.Group(); torso.position.y = 0.52; g.add(torso);
  const body = new THREE.Mesh(geo('body', () => new THREE.CapsuleGeometry(0.24, 0.42, 4, 12)), bodyM); body.position.y = 0.32; body.castShadow = true; torso.add(body);
  const head = new THREE.Mesh(geo('headg', () => new THREE.SphereGeometry(0.2, 18, 14)), headM); head.position.y = 0.86; head.castShadow = true; torso.add(head);
  const eyeM = mat('eye', { color: '#1d1d1f', roughness: 0.3 });
  const eyes = new THREE.Group(); head.add(eyes);
  for (const sx of [-0.07, 0.07]) { const e = new THREE.Mesh(geo('eyeg', () => new THREE.SphereGeometry(0.028, 8, 6)), eyeM); e.position.set(sx, 0.03, 0.18); eyes.add(e); }
  const badge = new THREE.Mesh(geo('badge', () => new THREE.BoxGeometry(0.16, 0.1, 0.02)), badgeM); badge.position.set(0.08, 0.42, 0.245); torso.add(badge);
  const ring = new THREE.Mesh(geo('ringg', () => new THREE.TorusGeometry(0.2, 0.025, 6, 20)), badgeM); ring.rotation.x = Math.PI / 2; ring.position.y = 1.1; torso.add(ring);
  const limbG = geo('limb', () => new THREE.CapsuleGeometry(0.07, 0.34, 3, 8));
  const arm = (sx) => { const p = new THREE.Group(); p.position.set(sx, 0.56, 0); torso.add(p); const m = new THREE.Mesh(limbG, bodyM); m.position.y = -0.22; m.castShadow = true; p.add(m); return p; };
  const leg = (sx) => { const p = new THREE.Group(); p.position.set(sx, 0.52, 0); g.add(p); const m = new THREE.Mesh(limbG, bodyM); m.position.y = -0.25; m.castShadow = true; p.add(m); return p; };
  const armL = arm(-0.3), armR = arm(0.3), legL = leg(-0.11), legR = leg(0.11);
  // aro âmbar no chão quando espera você
  const halo = new THREE.Mesh(geo('halo', () => new THREE.RingGeometry(0.42, 0.52, 28)), track(new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })));
  halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; g.add(halo);
  for (const m of [body, head]) { m.userData.actorId = w.id; S.pick.push(m); }
  S.actorsGroup.add(g);
  const chip = document.createElement('div'); chip.className = 'o3-chip'; S.labels.appendChild(chip);
  return { ...w, g, torso, head, eyes, armL, armR, legL, legR, halo, bodyM, badgeM, chip, body, path: [], pose: 'stand', anim: 'idle', phase: Math.random() * 10, blinkAt: performance.now() + 2000 + Math.random() * 4000, nextWander: 0, fade: 1, ry: 0 };
}

function disposeActor(a) {
  S.actorsGroup.remove(a.g); a.chip.remove();
  S.pick = S.pick.filter(m => m.userData.actorId !== a.id);
  a.bodyM.dispose(); a.badgeM.dispose(); a.halo.material.dispose();
  S.owned = S.owned.filter(o => o !== a.bodyM && o !== a.badgeM && o !== a.halo.material);
}

const ANIM_BY_VERB = { Editando: 'type', Escrevendo: 'type', Lendo: 'read', Procurando: 'read', Pesquisando: 'search', 'Lendo a web': 'search', Rodando: 'run', Vigiando: 'read', Agente: 'talk', 'Fluxo de agentes': 'talk', 'Organizando tarefas': 'type', 'Usando skill': 'read', 'Carregando ferramentas': 'read' };
const ICON = { type: '⌨', read: '📖', search: '🔎', run: '▶', talk: '💬', think: '…', waiting: '✋', stalled: '?', sofa: '☕', machine: '⏳' };

// alvo de cada boneco (assento/sofá/estação/porta) a partir do modelo vindo do ActivityUI
function assign(list) {
  const want = new Map(list.slice(0, MAX_ACTORS).map(w => [w.id, w]));
  // quem saiu do modelo vai embora pela porta
  for (const a of S.actors.values()) if (!want.has(a.id) && a.mode !== 'leave') { a.mode = 'leave'; a.anim = 'walk'; route(a, DOOR); }
  const usedDesk = new Set(); const usedSeat = new Set(); const usedSofa = new Set();
  for (const a of S.actors.values()) { if (a.desk != null && want.has(a.id)) usedDesk.add(a.desk); if (a.seat != null && want.has(a.id)) usedSeat.add(a.seat); if (a.sofa != null && want.has(a.id)) usedSofa.add(a.sofa); }
  for (const w of want.values()) {
    let a = S.actors.get(w.id);
    if (!a) { a = makeActor({ ...w, start: w.kind === 'agent' || S.started ? { ...DOOR } : { x: 6 + Math.random() * 4, z: 4 + Math.random() * 1.5 } }); S.actors.set(w.id, a); }
    const prevMode = a.mode; Object.assign(a, { name: w.name, mode: w.mode, verb: w.verb, what: w.what, bubble: w.bubble, termId: w.termId, color: w.color, taskIdx: w.taskIdx });
    if (a.badgeM.color.getHexString() !== new THREE.Color(w.color).getHexString()) { a.badgeM.color.set(w.color); a.badgeM.emissive.set(w.color); }
    a.anim = w.mode === 'waiting' ? 'waiting' : w.mode === 'stalled' ? 'stalled' : (ANIM_BY_VERB[w.verb] || (w.mode === 'desk' ? 'think' : 'idle'));
    // destino
    let dest = null; let pose = 'stand'; let face = 0;
    if (w.mode === 'desk' || w.mode === 'stalled' || w.mode === 'waiting') {
      if (w.kind === 'agent') {
        if (a.seat == null) { const k = MEET_SEATS.findIndex((_, i) => !usedSeat.has(i)); if (k >= 0) { a.seat = k; usedSeat.add(k); } }
        if (a.seat != null) { const s = MEET_SEATS[a.seat]; dest = s; pose = 'sit'; face = s.ry === 0 ? Math.PI : 0; }
      }
      if (!dest) {
        if (a.desk == null) { const k = S.desks.findIndex((_, i) => !usedDesk.has(i)); if (k >= 0) { a.desk = k; usedDesk.add(k); } }
        if (a.desk != null) { const d = S.desks[a.desk]; dest = w.mode === 'waiting' ? { x: d.seat.x + 0.75, z: d.seat.z + 0.1 } : d.seat; pose = w.mode === 'waiting' ? 'stand' : 'sit'; face = Math.PI; }
      }
      if (!dest) dest = { x: -6 + (S.actors.size % 6) * 0.8, z: 8 };
      if (a.sofa != null) { usedSofa.delete(a.sofa); a.sofa = null; }
    } else if (w.mode === 'machine') {
      const st = S.stations[Math.min(S.stations.length - 1, Math.max(0, w.taskIdx || 0))]; dest = st.spot; face = Math.PI / 2;
      if (a.sofa != null) { usedSofa.delete(a.sofa); a.sofa = null; }
    } else if (w.mode === 'leave') {
      dest = DOOR;
    } else {   // sofá
      if (a.desk != null && w.kind !== 'claude') { usedDesk.delete(a.desk); a.desk = null; }
      if (a.sofa == null) { const s = sofaSpot(usedSofa); if (s) { a.sofa = s.i; } }
      const s = a.sofa != null ? SOFA_SPOTS[a.sofa] : { x: 6 + Math.random() * 4, z: 3.5 };
      dest = s; pose = a.sofa != null ? 'sofa' : 'stand'; face = a.sofa != null && a.sofa >= 4 ? -Math.PI / 2 : Math.PI;
      if (!a.nextWander) a.nextWander = performance.now() + 30000 + Math.random() * 60000;
    }
    if (w.kind === 'agent' && w.mode !== 'desk' && w.mode !== 'stalled' && w.mode !== 'waiting' && a.seat != null) { usedSeat.delete(a.seat); a.seat = null; }
    a.face = face; a.wantPose = pose;
    if (!a.dest || Math.hypot(a.dest.x - dest.x, a.dest.z - dest.z) > 0.05 || prevMode === 'leave') route(a, dest);
  }
}
function sofaSpot(used) { for (let i = 0; i < SOFA_SPOTS.length; i++) if (!used.has(i)) { used.add(i); return { ...SOFA_SPOTS[i], i }; } return null; }
function route(a, dest) { a.dest = { x: dest.x, z: dest.z }; a.path = findPath({ x: a.g.position.x, z: a.g.position.z }, dest); a.pose = 'stand'; }

// ------- animação de um quadro -------
function animate(a, dt, t) {
  const p = a.g.position;
  let moving = false;
  if (a.path.length) {
    const n = a.path[0]; const dx = n.x - p.x, dz = n.z - p.z; const d = Math.hypot(dx, dz);
    const step = WALK * dt;
    if (d <= step) { p.x = n.x; p.z = n.z; a.path.shift(); } else { p.x += dx / d * step; p.z += dz / d * step; }
    a.ry = Math.atan2(dx, dz); moving = true;
  }
  if (!moving && a.dest && !a.path.length) a.ry = lerpAngle(a.ry, a.face || 0, Math.min(1, dt * 8));
  a.g.rotation.y = a.ry;
  const w = t / 1000 + a.phase;
  // pose base
  const sit = !moving && (a.wantPose === 'sit' || a.wantPose === 'sofa');
  a.torso.position.y += ((sit ? (a.wantPose === 'sofa' ? 0.56 : 0.62) : 0.52) - a.torso.position.y) * Math.min(1, dt * 10);
  a.legL.rotation.x = a.legR.rotation.x = 0; a.armL.rotation.set(0, 0, 0); a.armR.rotation.set(0, 0, 0); a.head.rotation.set(0, 0, 0); a.torso.rotation.set(0, 0, 0);
  if (moving) {
    const s = Math.sin(w * 11); a.legL.rotation.x = s * 0.6; a.legR.rotation.x = -s * 0.6; a.armL.rotation.x = -s * 0.5; a.armR.rotation.x = s * 0.5;
    a.torso.position.y = 0.52 + Math.abs(Math.cos(w * 11)) * 0.04;
  } else if (sit) {
    a.legL.rotation.x = a.legR.rotation.x = -Math.PI / 2;
    if (a.anim === 'type') { a.armL.rotation.x = -1.1 + Math.sin(w * 18) * 0.12; a.armR.rotation.x = -1.1 + Math.sin(w * 18 + 2) * 0.12; a.head.rotation.x = 0.15; }
    else if (a.anim === 'read') { a.armL.rotation.x = a.armR.rotation.x = -0.9; a.head.rotation.x = 0.25 + Math.sin(w * 1.3) * 0.08; a.head.rotation.y = Math.sin(w * 0.7) * 0.15; }
    else if (a.anim === 'search') { a.armL.rotation.x = -1.0; a.armR.rotation.x = -0.4; a.head.rotation.y = Math.sin(w * 0.9) * 0.5; a.torso.rotation.x = -0.08; }
    else if (a.anim === 'run') { a.armL.rotation.x = a.armR.rotation.x = -0.7; a.torso.rotation.y = Math.sin(w * 0.8) * 0.18; if (a.desk != null) S.desks[a.desk].chair.rotation.y = Math.sin(w * 0.8) * 0.18; }
    else if (a.anim === 'talk') { a.armR.rotation.x = -0.8 + Math.sin(w * 4) * 0.3; a.head.rotation.y = Math.sin(w * 1.1) * 0.35; }
    else if (a.anim === 'think') { a.armR.rotation.x = -1.6; a.armR.rotation.z = -0.4; a.head.rotation.z = 0.12; }
    else if (a.anim === 'stalled') { a.head.rotation.x = 0.5; a.torso.rotation.x = 0.15; }
    else if (a.wantPose === 'sofa') { a.armL.rotation.z = 0.25; a.armR.rotation.z = -0.25; a.torso.rotation.x = -0.12; }
  } else if (a.anim === 'waiting') {
    a.armR.rotation.z = -2.7 + Math.sin(w * 5) * 0.25; a.head.rotation.x = -0.1;
  }
  // respirar e piscar (só quando a sala está viva; parado no sofá fica estático = 0 quadros/s)
  a.torso.scale.y = 1 + Math.sin(w * 2.2) * 0.012;
  if (t > a.blinkAt) { a.eyes.scale.y = 0.1; if (t > a.blinkAt + 120) { a.eyes.scale.y = 1; a.blinkAt = t + 2500 + Math.random() * 4000; } }
  // aro âmbar / cinza de sem sinal
  a.halo.material.opacity = a.anim === 'waiting' && !moving ? 0.45 + Math.sin(w * 4) * 0.3 : 0;
  const gray = a.anim === 'stalled';
  if (a.isGray !== gray) { a.isGray = gray; a.bodyM.color.set(gray ? '#8e8e93' : S.pal.body); }
  // saída pela porta: some devagar
  if (a.mode === 'leave' && !a.path.length) { a.fade -= dt * 1.5; a.g.scale.setScalar(Math.max(0.01, a.fade) * (a.kind === 'agent' ? 0.86 : 1)); }
  return moving;
}
function lerpAngle(a, b, k) { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return a + d * k; }
function isLive(a) { return a.path.length > 0 || a.mode === 'leave' || a.anim === 'waiting' || (a.wantPose === 'sit' && a.anim !== 'stalled'); }

// ------- servidores -------
function syncServers(data) {
  S.servers = data;
  const list = (data && data.servers) || [];
  const key = list.map(s => s.id).join(',');
  if (S.rackKey !== key) {
    S.rackKey = key;
    for (const r of S.racks) { S.racksGroup.remove(r.g); r.label.remove(); for (const l of r.leds) l.material.dispose(); }
    S.pick = S.pick.filter(m => m.userData.rackId == null);
    S.racks = list.slice(0, 10).map((s, i) => {
      const row = i < 5 ? 0 : 1; const col = i % 5;
      const x = 9.3 + col * 1.15, z = row ? -3.6 : -7.6;
      const g = new THREE.Group(); g.position.set(x, 0, z); S.racksGroup.add(g);
      const body = rbox(0.86, 2.0, 0.8, 0.06, mat('rackm', { color: S.pal.rack, roughness: 0.35, metalness: 0.3 }), 0, 1.0, 0, { parent: g });
      box(0.86, 0.025, 0.025, mat('neon'), 0, 2.0, 0.39, { parent: g, cast: false });
      body.userData.rackId = s.id; S.pick.push(body);
      for (let k = 0; k < 5; k++) box(0.7, 0.012, 0.01, mat('slot', { color: '#3a3a42' }), 0, 0.35 + k * 0.32, 0.405, { parent: g, cast: false });
      const leds = [];
      block(x - 0.45, z - 0.4, x + 0.45, z + 0.4, 0.1);
      const label = document.createElement('div'); label.className = 'o3-plate'; S.labels.appendChild(label);
      return { id: s.id, g, leds, label, x, z, key: '' };
    });
  }
  S.racks.forEach((r, i) => {
    const s = list[i]; if (!s) return;
    const lights = s.lights.length ? s.lights : [{ st: s.st }];
    const k = lights.map(l => l.st).join(',');
    if (r.leds.length !== lights.length) {
      for (const l of r.leds) { r.g.remove(l); l.material.dispose(); }
      r.leds = lights.map((_, j) => { const m = new THREE.MeshStandardMaterial({ color: '#111', emissive: '#000' }); const led = new THREE.Mesh(geo('led', () => new THREE.BoxGeometry(0.12, 0.05, 0.02)), m); led.position.set(-0.28 + j * 0.14, 1.78, 0.41); r.g.add(led); return led; });
    }
    lights.forEach((l, j) => { const c = ST_COLOR[l.st] || ST_COLOR.esperando; r.leds[j].material.color.set(c); r.leds[j].material.emissive.set(c); r.leds[j].material.emissiveIntensity = l.st === 'sem-rota' || l.st === 'esperando' ? 0.3 : 1.6; r.leds[j].userData.blink = l.st === 'fora'; });
    const ms = lights.map(l => l.ms).filter(v => v != null);
    r.label.textContent = '';
    const b = document.createElement('b'); b.textContent = s.nome; const sp = document.createElement('span');
    sp.textContent = s.st === 'configurar' ? 'configurar' : s.st === 'ok' && ms.length ? `${Math.max(...ms)} ms` : `${ST_TEXT[s.st] || s.st}${ms.length ? ` · ${Math.max(...ms)} ms` : ''}`;
    const dot = document.createElement('i'); dot.style.background = ST_COLOR[s.st] || ST_COLOR.esperando;
    r.label.append(dot, b, sp); r.key = k;
  });
  if (S.card && S.card.rack) openRackCard(S.card.rack);
  kick();
}

// ------- ficha do servidor (sem botão de SSH, porta ou login) -------
function openRackCard(id) {
  const s = ((S.servers && S.servers.servers) || []).find(x => x.id === id); if (!s) return closeCard();
  const el = S.cardEl; el.textContent = ''; el.hidden = false; S.card = { rack: id };
  const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const head = h('div', 'o3-card-head'); head.append(h('b', null, s.nome), h('span', `o3-st st-${s.st}`, ST_TEXT[s.st] || s.st));
  const x = h('button', 'o3-x', '✕'); x.title = 'Fechar'; x.onclick = closeCard; head.append(x);
  el.append(head);
  if (!s.lights.length) el.append(h('p', 'o3-muted', 'Sem endereço para consultar. Use "Editar lista" e coloque o IP ou nome deste servidor (ex.: "ping:meu-servidor.local").'));
  const now = Date.now();
  for (const l of s.lights) {
    const row = h('div', 'o3-light');
    const top = h('div', 'o3-light-top'); const dot = h('i'); dot.style.background = ST_COLOR[l.st] || ST_COLOR.esperando;
    top.append(dot, h('b', null, l.nome), h('span', 'o3-muted', `${{ http: 'HTTP', tcp: 'conexão TCP', ping: 'ping' }[l.tipo] || l.tipo} · ${l.alvo}`));
    row.append(top);
    const info = `${ST_TEXT[l.st] || l.st}${l.ms != null ? ` · ${l.ms} ms` : ''}${l.code ? ` · HTTP ${l.code}` : ''}${l.err ? ` · ${l.err}` : ''}${l.at ? ` · há ${Math.max(0, Math.round((now - l.at) / 1000))} s` : ''}`;
    row.append(h('div', 'o3-muted', info));
    // histórico das últimas 30 consultas (pontos)
    const svgNS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('viewBox', '0 0 300 40'); svg.setAttribute('class', 'o3-spark');
    const vals = l.hist.map(p => p.ms).filter(v => v != null); const max = Math.max(50, ...vals);
    l.hist.forEach((p, i) => { const c = document.createElementNS(svgNS, 'circle'); c.setAttribute('cx', String(5 + i * 10)); c.setAttribute('cy', String(p.ms == null ? 34 : 34 - (p.ms / max) * 28)); c.setAttribute('r', '3'); c.setAttribute('fill', ST_COLOR[p.st] || '#8e8e93'); svg.appendChild(c); });
    row.append(svg);
    el.append(row);
  }
  const foot = h('div', 'o3-card-foot');
  foot.append(h('span', 'o3-muted', `consulta a cada ${Math.round(((S.servers && S.servers.every) || 60000) / 1000)} s, sem login`));
  if (S.api.servers && S.api.servers.edit) { const b = h('button', 'o3-btn', 'Editar lista'); b.onclick = () => S.api.servers.edit(); foot.append(b); }
  if (S.api.servers && S.api.servers.refresh && !S.api.remote) { const b = h('button', 'o3-btn', 'Consultar agora'); b.onclick = () => S.api.servers.refresh(); foot.append(b); }
  el.append(foot);
  if (S.servers && S.servers.errors && S.servers.errors.length) el.append(h('p', 'o3-warn', `servidores.json: ${S.servers.errors.join(' · ')}`));
}
function closeCard() { if (S) { S.card = null; S.cardEl.hidden = true; } }

// ------- laço de desenho sob demanda -------
function kick(ms = 0) { if (!S) return; S.liveUntil = Math.max(S.liveUntil, performance.now() + ms); if (!S.raf) S.raf = requestAnimationFrame(frame); }
function frame(t) {
  if (!S) return;
  S.raf = 0;
  if (!S.stage.isConnected) return;
  if (document.hidden || !S.stage.offsetParent) { S.paused = true; return; }
  if (t - S.lastFrame < FPS_MS - 2) { S.raf = requestAnimationFrame(frame); return; }
  const dt = Math.min(0.1, (t - (S.lastFrame || t)) / 1000); S.lastFrame = t;
  let live = false;
  for (const a of [...S.actors.values()]) {
    if (animate(a, dt, t)) live = true;
    if (isLive(a)) live = true;
    if (a.mode === 'leave' && a.fade <= 0) { disposeActor(a); S.actors.delete(a.id); }
    // passeio até o café (quem está parado no sofá, de vez em quando)
    if (a.wantPose === 'sofa' && !a.path.length && a.nextWander && t > a.nextWander && a.mode === 'sofa') {
      a.nextWander = t + 45000 + Math.random() * 60000; a.coffee = t; const back = a.dest; route(a, COFFEE); a.wantPose = 'stand'; a.face = Math.PI; a.after = back; live = true;
    }
    if (a.coffee && !a.path.length && a.after && t - a.coffee > 9000) { const b = a.after; a.after = null; a.coffee = 0; a.wantPose = 'sofa'; a.face = Math.PI; route(a, b); live = true; }
  }
  for (const r of S.racks) for (const l of r.leds) if (l.userData.blink) { l.material.emissiveIntensity = 0.6 + Math.abs(Math.sin(t / 300)) * 1.4; live = true; }
  if (S.controls.update()) live = true;
  S.renderer.render(S.scene, S.camera);
  placeLabels();
  S.frames++;
  if (live || t < S.liveUntil || S.dragging) S.raf = requestAnimationFrame(frame);
  // sofá parado: acorda sozinho na hora do próximo passeio
  else { const next = Math.min(...[...S.actors.values()].map(a => a.nextWander || Infinity)); if (Number.isFinite(next)) { clearTimeout(S.wake); S.wake = setTimeout(() => kick(), Math.max(200, next - performance.now())); } }
}

const v3 = new THREE.Vector3();
function project(x, y, z) {
  v3.set(x, y, z).project(S.camera);
  return { x: (v3.x + 1) / 2 * S.w, y: (1 - v3.y) / 2 * S.h, vis: v3.z < 1 };
}
function placeLabels() {
  for (const a of S.actors.values()) {
    const p = a.g.position; const q = project(p.x, a.torso.position.y + 1.45 * a.g.scale.y, p.z);
    const txt = a.anim === 'waiting' ? '✋ esperando você' : a.anim === 'stalled' ? '? sem sinal' : a.mode === 'sofa' || a.mode === 'leave' ? '' : `${ICON[a.anim] || '•'} ${clip(a.verb || (a.kind === 'agent' ? a.name : 'pensando'), 18)}`;
    if (a.chip.textContent !== txt) a.chip.textContent = txt;
    a.chip.className = `o3-chip ${a.anim === 'waiting' ? 'amber' : a.anim === 'stalled' ? 'gray' : ''} ${txt ? '' : 'hide'} ${S.hover === a.id ? 'hover' : ''}`;
    a.chip.style.transform = `translate(${Math.round(q.x)}px, ${Math.round(q.y)}px) translate(-50%, -100%)`;
  }
  // placas em degraus (racks lado a lado: as placas não se cobrem)
  for (const [i, r] of S.racks.entries()) { const q = project(r.x, 2.3 + (i % 5) * 0.55, r.z); r.label.style.transform = `translate(${Math.round(q.x)}px, ${Math.round(q.y)}px) translate(-50%, -100%)`; }
}

// ------- ponteiro: passar por cima mostra quem é; clique leva ao terminal ou abre a ficha -------
const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function hit(e) {
  const r = S.renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, S.camera);
  const hits = ray.intersectObjects(S.pick, false);
  return hits.length ? hits[0].object.userData : null;
}
function onMove(e) {
  if (S.dragging) return;
  const u = hit(e);
  const id = u && (u.actorId || (u.rackId && `rack:${u.rackId}`) || (u.board && 'board'));
  S.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
  if (id === S.hover) { if (id) moveTip(e); return; }
  S.hover = id || null;
  if (!id) { S.tip.hidden = true; kick(); return; }
  const a = u.actorId && S.actors.get(u.actorId);
  S.tip.textContent = a ? `${a.name}${a.bubble ? ' — ' + a.bubble : ''}${a.termId ? ' · clique para ir ao terminal' : ''}` : u.rackId ? 'Clique para ver o servidor' : 'Pendências deste projeto (painel Projeto)';
  S.tip.hidden = false; moveTip(e); kick();
}
function moveTip(e) { const r = S.stage.getBoundingClientRect(); S.tip.style.transform = `translate(${Math.round(e.clientX - r.left + 14)}px, ${Math.round(e.clientY - r.top + 14)}px)`; }
function onDown(e) { S.downAt = { x: e.clientX, y: e.clientY }; }
function onUp(e) {
  if (!S.downAt || Math.hypot(e.clientX - S.downAt.x, e.clientY - S.downAt.y) > 5) return;
  const u = hit(e); if (!u) return closeCard();
  if (u.actorId) { const a = S.actors.get(u.actorId); if (a && a.termId) S.api.goTerm(a.termId); }
  else if (u.rackId) openRackCard(u.rackId);
  else if (u.board && S.api.openPending) S.api.openPending();
}

// ------- montar / desmontar -------
function mount(stage, api) {
  unmount();
  const pal = themeColors();
  S = { stage, api, pal, owned: [], mats: {}, geos: {}, pick: [], actors: new Map(), racks: [], rackKey: '', desks: [], stations: [], frames: 0, raf: 0, lastFrame: 0, liveUntil: 0, hover: null, card: null };
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'o3-canvas';
  S.renderer = renderer;
  S.scene = new THREE.Scene(); S.scene.background = new THREE.Color(pal.bg);
  S.room = new THREE.Group(); S.scene.add(S.room);
  S.actorsGroup = new THREE.Group(); S.scene.add(S.actorsGroup);
  S.hemi = new THREE.HemisphereLight('#ffffff', pal.dark ? '#2a2a33' : '#c8c8d2', 1.4); S.scene.add(S.hemi);
  S.sun = new THREE.DirectionalLight('#ffffff', 1.8); S.sun.position.set(-10, 18, 12); S.sun.castShadow = true;
  S.sun.shadow.mapSize.set(2048, 2048); Object.assign(S.sun.shadow.camera, { left: -18, right: 18, top: 14, bottom: -14, near: 1, far: 50 }); S.sun.shadow.bias = -0.0006; S.sun.shadow.normalBias = 0.02;
  S.scene.add(S.sun);
  S.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
  S.camera.position.set(20, 19, 22); S.camera.lookAt(0, 0, 0); S.camera.zoom = 1;
  buildRoom(); dayLight();
  const labels = document.createElement('div'); labels.className = 'o3-labels'; S.labels = labels;
  const tip = document.createElement('div'); tip.className = 'o3-tip'; tip.hidden = true; S.tip = tip;
  const card = document.createElement('div'); card.className = 'o3-card'; card.hidden = true; S.cardEl = card;
  const hint = document.createElement('div'); hint.className = 'o3-hint'; hint.textContent = 'arraste para girar · role para aproximar · clique num boneco para ir ao terminal';
  stage.append(renderer.domElement, labels, tip, card, hint);
  const controls = new OrbitControls(S.camera, renderer.domElement);
  Object.assign(controls, { enablePan: false, enableDamping: true, dampingFactor: 0.12, minPolarAngle: 35 * Math.PI / 180, maxPolarAngle: 65 * Math.PI / 180, minZoom: 0.6, maxZoom: 3.5, zoomSpeed: 0.9, rotateSpeed: 0.7 });
  controls.target.set(0, 0, 0); controls.update(); controls.saveState();
  controls.addEventListener('start', () => { S.dragging = true; S.userCam = true; kick(); });
  controls.addEventListener('end', () => { S.dragging = false; kick(900); });
  controls.addEventListener('change', () => kick(120));
  S.controls = controls;
  const el = renderer.domElement;
  el.addEventListener('pointermove', onMove); el.addEventListener('pointerdown', onDown); el.addEventListener('pointerup', onUp);
  el.addEventListener('pointerleave', () => { S.hover = null; S.tip.hidden = true; kick(); });
  // se o macOS/GPU derrubar o WebGL (tela cinza), recria a sala no mesmo lugar com o mesmo estado — uma vez por queda
  el.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); const st = S && S.stage, ap = S && S.api, model = S && S.model; if (!st) return;
    setTimeout(() => { if (S && S.stage === st && S.renderer.getContext().isContextLost()) { mount(st, ap); if (model) update(model); } }, 800);
  });
  S.ro = new ResizeObserver(() => resize()); S.ro.observe(stage); resize();
  S.onVis = () => { if (!document.hidden && S.paused) { S.paused = false; kick(500); } }; document.addEventListener('visibilitychange', S.onVis);
  // tema claro/escuro: troca as cores sem remontar
  S.mq = window.matchMedia('(prefers-color-scheme: dark)'); S.onTheme = () => retheme(); S.mq.addEventListener('change', S.onTheme);
  S.mo = new MutationObserver(() => retheme()); S.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  // relógio a cada minuto, luz a cada 10 min (só redesenha 1 quadro)
  S.clockTimer = setInterval(() => { drawClock(); if (new Date().getMinutes() % 10 === 0) dayLight(); kick(); }, 60000);
  if (api.servers) { api.servers.list().then(syncServers).catch(() => {}); S.offServers = api.servers.onChanged ? api.servers.onChanged((d) => { if (S) syncServers(d); }) : null; }
  kick(600);
}

function retheme() {
  if (!S) return; const pal = themeColors(); if (pal.dark === S.pal.dark && pal.bg === S.pal.bg) return;
  S.pal = pal; S.scene.background.set(pal.bg);
  const set = (k, c) => { if (S.mats[k]) S.mats[k].color.set(c); };
  set('floor', pal.floor); set('floor2', pal.floor2); set('wall', pal.wall); set('top', pal.top); set('chair', pal.chair); set('frame', pal.frame); set('sofa', pal.sofa); set('cushion', pal.cushion);
  set('plant', pal.plant); set('pot', pal.pot); set('metal', pal.metal); set('bezel', pal.rack); set('rackm', pal.rack); set('head', pal.head); set('grate', pal.metal); set('rug', pal.dark ? '#1f1f26' : '#d3d4dd');
  if (S.mats.glass) { S.mats.glass.color.set(pal.glass); S.mats.glass.opacity = pal.glassOp; }
  S.hemi.groundColor.set(pal.dark ? '#2a2a33' : '#c8c8d2');
  for (const a of S.actors.values()) { a.isGray = null; }
  for (const d of S.desks) d.key = '';
  S.boardKey = ''; S.meetKey = '';
  drawClock(); dayLight(); update(S.model || { actors: [], tasks: [] });
}

function resize() {
  const r = S.stage.getBoundingClientRect(); const w = Math.max(50, r.width | 0), h = Math.max(50, r.height | 0);
  S.w = w; S.h = h; S.renderer.setSize(w, h, false);
  const view = 22; const asp = w / h;
  Object.assign(S.camera, { left: -view * asp / 2, right: view * asp / 2, top: view / 2, bottom: -view / 2 });
  // painel estreito: começa mais longe para caber a sala
  // zoom inicial pelo formato; ao mudar de lugar (painel ⇄ tela cheia) reajusta, a menos que a pessoa tenha mexido na câmera
  const fit = asp < 1 ? 0.62 : asp < 1.4 ? 0.8 : 0.92;
  if (!S.sized || (S.fit !== fit && !S.userCam)) { S.sized = true; S.fit = fit; S.camera.zoom = fit; S.controls.saveState(); }
  S.camera.updateProjectionMatrix(); kick(60);
}

// modelo: { actors: [{ id, termId, kind, name, color, mode, verb, what, bubble, taskIdx }], tasks: [...], pending: [...] }
function update(model) {
  if (!S) return;
  S.model = model;
  assign(model.actors || []);
  // telas das mesas acompanham quem está sentado nelas
  const byDesk = new Map(); for (const a of S.actors.values()) if (a.desk != null && a.mode !== 'leave') byDesk.set(a.desk, a);
  for (const d of S.desks) { const a = byDesk.get(d.i); drawMonitor(d, a && a.mode !== 'sofa' && a.mode !== 'machine' ? { anim: a.anim, verb: a.mode === 'waiting' ? 'Esperando você' : a.anim === 'stalled' ? 'Sem sinal' : (a.verb || 'Pensando'), what: a.what || '', mode: a.mode } : null); }
  S.stations.forEach((st, i) => drawStation(st, (model.tasks || [])[i] || null));
  drawMeetScreen([...S.actors.values()].filter(a => a.kind === 'agent' && a.seat != null && a.mode !== 'leave').length);
  if (model.pending) drawBoard(model.pending);
  S.started = true;
  kick(300);
}

function recenter() { if (!S) return; S.userCam = false; S.controls.reset(); if (S.fit) { S.camera.zoom = S.fit; S.camera.updateProjectionMatrix(); } kick(300); }

function unmount() {
  if (!S) return;
  const s = S;
  if (s.raf) cancelAnimationFrame(s.raf);
  clearTimeout(s.wake); clearInterval(s.clockTimer);
  if (s.ro) s.ro.disconnect(); if (s.mo) s.mo.disconnect();
  document.removeEventListener('visibilitychange', s.onVis);
  if (s.mq) s.mq.removeEventListener('change', s.onTheme);
  if (typeof s.offServers === 'function') s.offServers();
  for (const a of s.actors.values()) disposeActor(a);
  for (const r of s.racks) for (const l of r.leds) l.material.dispose();
  s.controls.dispose();
  for (const o of s.owned) { try { o.dispose(); } catch {} }
  s.renderer.dispose(); try { s.renderer.forceContextLoss(); } catch {}
  s.renderer.domElement.remove(); s.labels.remove(); s.tip.remove(); s.cardEl.remove();
  const hint = s.stage.querySelector('.o3-hint'); if (hint) hint.remove();
  S = null;
}

function stats() { return S ? { frames: S.frames, actors: S.actors.size, racks: S.racks.length, geometries: S.renderer.info.memory.geometries, textures: S.renderer.info.memory.textures, live: !!S.raf } : null; }

window.Office3D = { supported, mount, update, unmount, recenter, stats, isMounted: () => !!S };
window.dispatchEvent(new Event('office3d-ready'));
