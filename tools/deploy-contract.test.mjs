// tools/deploy-contract.test.mjs — the shipping conventions, as tests.
// Fails when a workflow action floats, a workflow runs without permissions
// or a job without a timeout, or the docs stop naming the dev loop. Runs as
// the `contract` step of tools/verify.mjs. (Adapted from the app-conventions
// template; there is no Dockerfile on GitHub Pages, so no image checks.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const has = (p) => existsSync(join(ROOT, p));
const workflows = has('.github/workflows') ? readdirSync(join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)) : [];

test('every action is pinned to a commit SHA with its version as a comment', () => {
  for (const f of workflows) {
    for (const [line, ref] of read(`.github/workflows/${f}`).matchAll(/uses:\s*(\S+)(.*)$/gm)) {
      if (ref.startsWith('./')) continue;
      assert.match(line, /@[0-9a-f]{40}\s+#\s*v\d/, `${f}: ${ref.trim()} is not pinned to a SHA with a # vX comment`);
    }
  }
});

test('every workflow declares permissions and every job a timeout', () => {
  for (const f of workflows) {
    const y = read(`.github/workflows/${f}`);
    assert.match(y, /^permissions:/m, `${f} has no top-level permissions`);
    const jobs = y.split(/^jobs:\s*$/m)[1] || '';
    const names = [...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);
    assert.ok(names.length, `${f} has no jobs`);
    for (const name of names) {
      const body = jobs.split(new RegExp(`^ {2}${name}:\\s*$`, 'm'))[1].split(/^ {2}[\w-]+:\s*$/m)[0];
      assert.match(body, /timeout-minutes:/, `${f}: job ${name} has no timeout-minutes`);
    }
  }
});

test('every workflow runs on Node 24', () => {
  for (const f of workflows) {
    for (const [, v] of read(`.github/workflows/${f}`).matchAll(/node-version:\s*['"]?(\S+?)['"]?\s*$/gm)) assert.equal(v, '24', `${f}: Node ${v}`);
  }
});

test('CI runs tools/verify.mjs and confirms the commit is live', () => {
  const y = read('.github/workflows/test.yml');
  assert.match(y, /node tools\/verify\.mjs/, 'test.yml does not call tools/verify.mjs');
  assert.match(y, /node tools\/live\.mjs --wait/, 'test.yml has no live check');
  assert.match(y, /package\.json/, 'test.yml lost the no-package.json guard');
});

test('Dependabot watches the actions and merges its own pull requests', () => {
  assert.match(read('.github/dependabot.yml'), /package-ecosystem: github-actions/);
  assert.ok(has('.github/workflows/dependabot-merge.yml'), 'dependabot-merge.yml is missing');
});

test('CLAUDE.md names the dev-loop commands', () => {
  const claude = read('CLAUDE.md');
  for (const cmd of ['node tools/verify.mjs', 'node tools/live.mjs']) assert.ok(claude.includes(cmd), `CLAUDE.md does not mention ${cmd}`);
});
