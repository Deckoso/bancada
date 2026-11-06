// CP-4: varre o corpus REAL de sessões (só leitura) num banco temporário e mede memória.
// Uso: BANCADA_PROJETOS=<pasta> [BANCADA_MOTOR=<pasta>] ELECTRON_RUN_AS_NODE=1 electron test/corpus/sessions-corpus.js <pasta-temporária>
'use strict';
const path = require('path'); const fs = require('fs'); const os = require('os');
const { open } = require('../../app/main/db');
const { SessionReader } = require('../../app/main/sessions/reader');
const { discoverProjects } = require('../../app/main/discover');

(async () => {
  const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-cp4-'));
  const store = open(path.join(tmp, 'cp4.db'));
  const root = process.env.BANCADA_PROJETOS || path.join(os.homedir(), 'Documents', 'PROJETOS');
  for (const d of discoverProjects(root)) store.createProject({ name: d.name, kind: d.kind, paths: [d.path] });
  if (process.env.BANCADA_MOTOR) store.createProject({ name: path.basename(process.env.BANCADA_MOTOR), paths: [process.env.BANCADA_MOTOR] });
  let peak = 0; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const t0 = Date.now();
  const reader = new SessionReader({ store });
  const r1 = await reader.scan();
  const t1 = Date.now();
  const before = reader.stats.bytesRead;
  await reader.scan();
  const rescanBytes = reader.stats.bytesRead - before;
  clearInterval(iv); peak = Math.max(peak, process.memoryUsage().rss);
  const s = reader.stats;
  const rows = store.db.prepare('SELECT d.source, d.title, d.last_prompt, p.name proj, d.prompts, d.last_at FROM sessions_digest d LEFT JOIN projects p ON p.id=d.project_id ORDER BY d.last_at DESC').all();
  const withPrompts = rows.filter(r => r.prompts > 0);
  const out = {
    files: s.files, mb_read: +(before / 1048576).toFixed(1), seconds: (t1 - t0) / 1000,
    lines: s.linesRead, ignored: s.linesIgnored, ignored_pct: +(100 * s.linesIgnored / Math.max(1, s.linesRead)).toFixed(3), oversized: s.oversized,
    rescan_bytes: rescanBytes, peak_rss_mb: Math.round(peak / 1048576),
    sessions: rows.length, with_prompts: withPrompts.length, classified: withPrompts.filter(r => r.proj).length,
  };
  console.log(JSON.stringify(out, null, 1));
  console.log('--- 25 mais recentes ---');
  for (const r of withPrompts.slice(0, 25)) console.log(`${new Date(r.last_at).toISOString().slice(0, 16)} ${r.source.padEnd(6)} [${(r.proj || '— sem projeto —').padEnd(22)}] ${(r.title || r.last_prompt || '').replace(/\s+/g, ' ').slice(0, 70)}`);
  const ok = out.ignored_pct < 1 && out.peak_rss_mb < 300 && rescanBytes < 5 * 1048576;
  console.log(ok ? 'CP-4 PASS' : 'CP-4 FAIL');
  process.exit(ok ? 0 : 1);
})();
