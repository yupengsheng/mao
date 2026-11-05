import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { depsHashOfLockfile, RUNTIME_DEPS_HASH_LENGTH } from './deps-hash.js';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lockfile = join(backendDir, 'package-lock.json');
const buildScript = resolve(backendDir, '..', 'scripts', 'build-runtime-image.sh');

describe('runtime dependency fingerprint', () => {
  it('hashes the lockfile bytes to a stable short fingerprint', () => {
    const hash = depsHashOfLockfile(lockfile);
    expect(hash).toMatch(new RegExp(`^[0-9a-f]{${RUNTIME_DEPS_HASH_LENGTH}}$`));
    expect(depsHashOfLockfile(lockfile)).toBe(hash);
  });

  it('matches the shell build script hash', () => {
    // 两端口径对拍：脚本写入 label，后端读 label 比对；算法分叉会导致永远不匹配
    const result = spawnSync('bash', [buildScript, '--print-deps-hash'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(depsHashOfLockfile(lockfile));
  });

  it('throws when the lockfile is missing', () => {
    expect(() => depsHashOfLockfile(join(backendDir, 'missing-package-lock.json'))).toThrow();
  });
});
