#!/usr/bin/env node
/**
 * desktop prebuild：校验已提交的 Embed SDK 产物，不从源码隐式重建。
 *
 * 发布流程：sdk/embed 构建后提交 desktop/public/embed/mao-chat.js 与当前版本副本。
 * 桌面构建只消费这两份产物；CI 会在重建 SDK 后用 --strict 比对哈希，防止源码与产物漂移。
 */
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..', '..');

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function inspectEmbedArtifacts(repoRoot = root, { strict = false } = {}) {
  const sdkDir = join(repoRoot, 'sdk', 'embed');
  const packageFile = join(sdkDir, 'package.json');
  const publicDir = join(repoRoot, 'desktop', 'public', 'embed');
  const latestFile = join(publicDir, 'mao-chat.js');
  const distFile = join(sdkDir, 'dist', 'mao-chat.js');
  const errors = [];
  const warnings = [];

  if (!existsSync(packageFile)) {
    errors.push(`缺少 ${packageFile}，无法确定 Embed SDK 版本`);
    return { ok: false, version: null, hashes: {}, errors, warnings, distStatus: 'absent' };
  }

  let version;
  try {
    version = JSON.parse(readFileSync(packageFile, 'utf8')).version;
  } catch (error) {
    errors.push(`无法读取 ${packageFile}: ${error.message}`);
    return { ok: false, version: null, hashes: {}, errors, warnings, distStatus: 'absent' };
  }

  const versionedFile = join(publicDir, `mao-chat.v${version}.js`);
  const files = [
    { label: 'latest', path: latestFile },
    { label: `v${version}`, path: versionedFile },
  ];
  const hashes = {};

  for (const file of files) {
    if (!existsSync(file.path)) {
      errors.push(`缺少已提交产物 ${file.path}（请在 sdk/embed 构建后提交 desktop/public/embed/*.js）`);
      continue;
    }
    hashes[file.label] = hashFile(file.path);
  }

  if (hashes.latest && hashes[`v${version}`] && hashes.latest !== hashes[`v${version}`]) {
    errors.push(`mao-chat.js 与 mao-chat.v${version}.js 内容不一致`);
  }

  let distStatus = 'absent';
  if (existsSync(distFile)) {
    const distHash = hashFile(distFile);
    if (hashes.latest && distHash !== hashes.latest) {
      distStatus = 'drift';
      const message = `本地 sdk/embed/dist 与已提交产物不一致（${distHash.slice(0, 12)} != ${hashes.latest.slice(0, 12)}）；请重新构建并提交 desktop/public/embed/*.js`;
      if (strict) errors.push(message);
      else warnings.push(`${message}；桌面构建继续使用已提交产物`);
    } else {
      distStatus = 'match';
    }
  }

  return { ok: errors.length === 0, version, hashes, errors, warnings, distStatus };
}

function main() {
  const strict = process.argv.includes('--strict') || process.env.EMBED_SDK_STRICT === '1';
  const result = inspectEmbedArtifacts(root, { strict });

  for (const warning of result.warnings) console.warn(`[verify-embed-sdk] ${warning}`);
  for (const error of result.errors) console.error(`[verify-embed-sdk] ${error}`);

  if (!result.ok) process.exit(1);

  console.info(`[verify-embed-sdk] v${result.version} 已提交产物一致 ✓ sha256=${result.hashes.latest.slice(0, 12)}…`);
}

if (require.main === module) main();

module.exports = { inspectEmbedArtifacts };
