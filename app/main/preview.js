// Prévia de localhost (BP-2026-11-05-001 E5): abre http://localhost:<porta> numa janela própria, isolada
// (sandbox, partição separada, sem preload, sem permissões) e que só navega dentro do próprio Mac (loopback).
// Nunca existe no acesso remoto (o localhost é do Mac).
'use strict';
const { BrowserWindow, session, shell } = require('electron');

const previews = new Set();    // webContents das janelas de prévia (o index.js consulta para liberar a navegação)

function isLoopback(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname);
  } catch { return false; }
}
function normalize(url) { const u = new URL(url); if (u.hostname === '0.0.0.0') u.hostname = 'localhost'; return u.toString(); }

let configured = false;
function open(url) {
  if (!isLoopback(url)) { const e = new Error('só endereços do próprio Mac (localhost)'); e.code = 'INVALID'; throw e; }
  const ses = session.fromPartition('bancada-preview');
  if (!configured) {
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.on('will-download', (e) => e.preventDefault());     // a prévia não baixa nada para o Mac
    configured = true;
  }
  const win = new BrowserWindow({ width: 1200, height: 820, title: `Prévia · ${new URL(url).host}`, backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, spellcheck: false } });
  const wc = win.webContents;
  previews.add(wc);
  wc.on('destroyed', () => previews.delete(wc));
  win.loadURL(normalize(url));
  return true;
}

// regras de navegação dentro da prévia (chamadas pelo handler global de web-contents)
function allowNavigate(url) { return isLoopback(url); }
function onWindowOpen(wc, url) {
  if (isLoopback(url)) { wc.loadURL(normalize(url)); return; }
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
}

module.exports = { open, previews, isLoopback, allowNavigate, onWindowOpen };
