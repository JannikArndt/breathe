// tools/live.mjs — does GitHub Pages serve this tree's build?
//   node tools/live.mjs                 answers now (exit 1 if not)
//   node tools/live.mjs --wait          polls every 5 s, up to 10 min
//   node tools/live.mjs --url <base>    another host
// The build id of this app is the VERSION in sw.js. Last line:
// `LIVE: <build>` or `NOT LIVE: want <a>, <url> serves <b>`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'https://jannikarndt.github.io/breathe';
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const base = (arg('--url') || process.env.APP_URL || DEFAULT_URL).replace(/\/$/, '');
const wait = process.argv.includes('--wait');
const versionOf = (text) => (text.match(/VERSION\s*=\s*['"]([^'"]+)/) || [])[1];
const want = versionOf(readFileSync(fileURLToPath(new URL('../sw.js', import.meta.url)), 'utf8'));
const started = Date.now();

async function served() {
  try {
    // The query defeats the CDN's ten-minute cache; no-store the browser's.
    const res = await fetch(`${base}/sw.js?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return `HTTP ${res.status}`;
    return versionOf(await res.text()) || 'no VERSION in sw.js';
  } catch (err) {
    return err.cause?.code || err.name;
  }
}

let last = '';
for (;;) {
  const got = await served();
  if (got === want) { console.log(`LIVE: ${want}`); process.exit(0); }
  const secs = Math.round((Date.now() - started) / 1000);
  if (!wait || secs > 600) { console.log(`NOT LIVE: want ${want}, ${base} serves ${got}`); process.exit(1); }
  if (got !== last) { console.log(`  ${secs} s: ${base} serves ${got}`); last = got; }
  await new Promise((r) => setTimeout(r, 5000));
}
