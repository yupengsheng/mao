const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { inspectEmbedArtifacts } = require('./verify-embed-sdk.cjs');

function fixture({ version = '9.9.9', latest = 'latest', versioned = latest, dist = 'latest' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mao-embed-sdk-'));
  const sdkDir = join(root, 'sdk', 'embed');
  const publicDir = join(root, 'desktop', 'public', 'embed');
  mkdirSync(sdkDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ version }));
  if (latest !== null) writeFileSync(join(publicDir, 'mao-chat.js'), latest);
  if (versioned !== null) writeFileSync(join(publicDir, `mao-chat.v${version}.js`), versioned);
  if (dist !== null) {
    mkdirSync(join(sdkDir, 'dist'), { recursive: true });
    writeFileSync(join(sdkDir, 'dist', 'mao-chat.js'), dist);
  }
  return root;
}

test('已提交产物与本地构建一致时通过', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = inspectEmbedArtifacts(root, { strict: true });

  assert.equal(result.ok, true);
  assert.equal(result.distStatus, 'match');
  assert.deepEqual(result.errors, []);
});

test('缺少 latest 或当前版本副本时失败', (t) => {
  const missingLatest = fixture({ latest: null });
  const missingVersioned = fixture({ versioned: null });
  t.after(() => rmSync(missingLatest, { recursive: true, force: true }));
  t.after(() => rmSync(missingVersioned, { recursive: true, force: true }));

  assert.equal(inspectEmbedArtifacts(missingLatest).ok, false);
  assert.equal(inspectEmbedArtifacts(missingVersioned).ok, false);
});

test('latest 与当前版本副本内容不一致时失败', (t) => {
  const root = fixture({ versioned: 'old' });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = inspectEmbedArtifacts(root);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /内容不一致/);
});

test('本地 dist 漂移在普通构建中告警，严格模式下失败', (t) => {
  const root = fixture({ dist: 'rebuilt' });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const normal = inspectEmbedArtifacts(root);
  const strict = inspectEmbedArtifacts(root, { strict: true });

  assert.equal(normal.ok, true);
  assert.equal(normal.distStatus, 'drift');
  assert.match(normal.warnings.join('\n'), /dist 与已提交产物不一致/);
  assert.equal(strict.ok, false);
  assert.match(strict.errors.join('\n'), /dist 与已提交产物不一致/);
});
