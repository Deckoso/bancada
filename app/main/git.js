// git só leitura por projeto (branch, mudanças pendentes, último commit). Nunca escreve no repositório.
'use strict';
const { execFile } = require('child_process');

function run(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 4000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function status(dir) {
  const st = await run(dir, ['status', '--porcelain=v1', '-b']);
  if (st == null) return null;
  const lines = st.split('\n').filter(Boolean);
  const head = lines.shift() || '';
  const branch = (/^## No commits yet on (\S+)/.exec(head) || /^## ([^.\s]+)/.exec(head) || [])[1] || null;
  const log = await run(dir, ['log', '-1', '--format=%h%x1f%s%x1f%ct']);
  let last = null;
  if (log) { const [hash, subject, ct] = log.trim().split('\x1f'); last = { hash, subject, at: Number(ct) * 1000 }; }
  return { branch, changed: lines.length, files: lines.slice(0, 8).map(l => l.slice(3)), last };
}

module.exports = { status };
