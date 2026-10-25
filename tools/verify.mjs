// tools/verify.mjs — exactly what CI runs, with only what needs reading
// printed. There is no package.json here (CLAUDE.md §2), so this is the
// `npm run verify` of the app.
//   node tools/verify.mjs              all steps
//   node tools/verify.mjs smoke dsp    some of them
// Every step runs even when an earlier one fails, so one call says
// everything. The last line is `VERIFY: PASS` or `VERIFY: FAIL (<steps>)`.
// CI's test job calls this file; never copy its steps into the workflow.
import { spawnSync } from 'node:child_process';

const REC = 'recordings/breathe-20260830T223632.json';
const STEPS = {
  dsp: ['tools/dsp-harness.mjs'],
  smoke: ['tools/smoke.mjs'],
  android: ['tools/smoke.mjs', '--android'],
  onset: ['tools/onset.mjs', REC],
  // The plot, not just the header: replay.mjs threw on its last line for
  // weeks because reading the top of its output looks like it working.
  replay: ['tools/replay.mjs', REC],
  'analyze-good': ['tools/analyze.mjs', 'recordings/breathe-20260831-0853.json'],
  'analyze-bogus': ['tools/analyze.mjs', 'recordings/breathe-20260829T115717-bogus.json'],
  // Workflows pinned and bounded, the docs naming the dev loop.
  contract: ['--test', 'tools/deploy-contract.test.mjs'],
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(STEPS);
const unknown = wanted.filter((s) => !STEPS[s]);
if (unknown.length) { console.log(`unknown step: ${unknown.join(' ')} (have: ${Object.keys(STEPS).join(' ')})`); console.log('VERIFY: FAIL (usage)'); process.exit(2); }

const failed = [];
for (const step of wanted) {
  const started = Date.now();
  const r = spawnSync(process.execPath, STEPS[step], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === 0) { console.log(`ok   ${step} (${secs} s)`); continue; }
  failed.push(step);
  console.log(`FAIL ${step} (${secs} s)`);
  const out = `${r.stdout}\n${r.stderr}`.split('\n');
  const notOk = out.flatMap((l, i) => (/^\s*not ok /.test(l) ? out.slice(i, i + 25) : []));
  console.log((notOk.length ? notOk : out.slice(-40)).join('\n').trim());
}
console.log(failed.length ? `VERIFY: FAIL (${failed.join(' ')})` : 'VERIFY: PASS');
process.exit(failed.length ? 1 : 0);
