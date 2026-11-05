import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { depsHashOfLockfile } from './deps-hash.js';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(backendDir, '..');

/** 假 docker：记录每次调用，并按环境变量模拟 inspect / build / run / image ls。 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG}"
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  if [[ "\${FAKE_DOCKER_LATEST_EXISTS:-1}" == "1" ]]; then
    cat "\${FAKE_DOCKER_LABEL_FILE}" 2>/dev/null || true
    exit 0
  fi
  echo "Error: No such image" >&2
  exit 1
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "ls" ]]; then
  cat "\${FAKE_DOCKER_TAGS_FILE}" 2>/dev/null || true
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  [[ "\${FAKE_DOCKER_BUILD_FAIL:-0}" == "1" ]] && { echo "build failed" >&2; exit 1; }
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  [[ "\${FAKE_DOCKER_SMOKE_FAIL:-0}" == "1" ]] && { echo "smoke failed" >&2; exit 1; }
  exit 0
fi
exit 0
`;

interface RunOptions {
  label?: string;
  latestExists?: boolean;
  buildFail?: boolean;
  smokeFail?: boolean;
  tags?: string[];
  args?: string[];
}

function makeRepo(lockContent = '{"lockfileVersion":3}\n'): { root: string; lockfile: string } {
  const root = useTmpDir('mao-align-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'backend-ts', 'dist', 'harness', 'container'), { recursive: true });
  for (const name of ['build-runtime-image.sh', 'align-runtime-image.sh']) {
    copyFileSync(join(repoRoot, 'scripts', name), join(root, 'scripts', name));
    chmodSync(join(root, 'scripts', name), 0o755);
  }
  const lockfile = join(root, 'backend-ts', 'package-lock.json');
  writeFileSync(lockfile, lockContent);
  writeFileSync(join(root, 'backend-ts', 'dist', 'harness', 'container', 'runtime-agent.js'), 'export {};\n');
  return { root, lockfile };
}

function runScript(root: string, script: string, opts: RunOptions = {}) {
  const log = join(root, 'docker.log');
  const labelFile = join(root, 'label.txt');
  const tagsFile = join(root, 'tags.txt');
  writeFileSync(labelFile, opts.label ?? '');
  writeFileSync(tagsFile, (opts.tags ?? []).join('\n'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'docker');
  writeFileSync(fake, FAKE_DOCKER);
  chmodSync(fake, 0o755);

  const result = spawnSync('bash', [join(root, 'scripts', script), ...(opts.args ?? [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_LABEL_FILE: labelFile,
      FAKE_DOCKER_TAGS_FILE: tagsFile,
      FAKE_DOCKER_LATEST_EXISTS: opts.latestExists === false ? '0' : '1',
      FAKE_DOCKER_BUILD_FAIL: opts.buildFail ? '1' : '0',
      FAKE_DOCKER_SMOKE_FAIL: opts.smokeFail ? '1' : '0',
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { result, calls };
}

describe('align runtime image script', () => {
  it('exits without rebuilding when the label matches the current lockfile', () => {
    const { root, lockfile } = makeRepo();
    const hash = depsHashOfLockfile(lockfile);
    const { result, calls } = runScript(root, 'align-runtime-image.sh', { label: hash });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`运行时镜像已对齐：mao-runtime:latest（deps-hash=${hash}）`);
    expect(calls.filter((line) => line.startsWith('build '))).toHaveLength(0);
    expect(calls.filter((line) => line.startsWith('tag '))).toHaveLength(0);
    expect(calls.filter((line) => line.startsWith('run '))).toHaveLength(0);
  });

  it('builds a temp tag, smoke tests it, then promotes latest', () => {
    const { root } = makeRepo();
    const { result, calls } = runScript(root, 'align-runtime-image.sh', {
      label: '0000000000000000',
      tags: ['2026-11-01-aaa', '2026-11-02-bbb', '2026-11-03-ccc'],
    });

    expect(result.status, result.stderr).toBe(0);
    const build = calls.find((line) => line.startsWith('build '));
    expect(build).toContain('org.mao.runtime.deps-hash=');
    expect(build).toMatch(/-t mao-runtime:build-[0-9A-Za-z]+-\d{14}/);

    const runIndex = calls.findIndex((line) => line.startsWith('run '));
    expect(runIndex, calls.join('\n')).toBeGreaterThan(-1);
    expect(calls[runIndex]).toContain('mao-runtime:build-');
    expect(calls[runIndex]).toContain('import(\'sharp\')');
    expect(calls[runIndex]).toContain('import(\'node-pty\')');

    const latestTagIndex = calls.findIndex((line) => line.startsWith('tag ') && line.endsWith('mao-runtime:latest'));
    expect(latestTagIndex, calls.join('\n')).toBeGreaterThan(runIndex);
    expect(calls.some((line) => /^tag mao-runtime:build-[0-9A-Za-z]+-\d{14} mao-runtime:\d{4}-\d{2}-\d{2}-[0-9A-Za-z]+$/.test(line))).toBe(true);
    expect(calls.some((line) => line === 'rmi mao-runtime:2026-11-01-aaa')).toBe(true);
  });

  it('does not move latest when smoke fails, and removes the temp tag', () => {
    const { root } = makeRepo();
    const { result, calls } = runScript(root, 'align-runtime-image.sh', {
      label: '0000000000000000',
      smokeFail: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('对齐失败');
    expect(calls.some((line) => line.startsWith('tag ') && line.endsWith('mao-runtime:latest'))).toBe(false);
    expect(calls.some((line) => line.startsWith('rmi mao-runtime:build-'))).toBe(true);
  });

  it('does not move latest when the build fails', () => {
    const { root } = makeRepo();
    const { result, calls } = runScript(root, 'align-runtime-image.sh', {
      label: '0000000000000000',
      buildFail: true,
    });

    expect(result.status).not.toBe(0);
    expect(calls.filter((line) => line.startsWith('run '))).toHaveLength(0);
    expect(calls.some((line) => line.startsWith('tag '))).toBe(false);
  });

  it('builds when latest is missing or has no label', () => {
    for (const opts of [{ latestExists: false }, { label: '<no value>' }]) {
      const { root } = makeRepo();
      const { result, calls } = runScript(root, 'align-runtime-image.sh', opts);
      expect(result.status, result.stderr).toBe(0);
      expect(calls.some((line) => line.startsWith('build '))).toBe(true);
      expect(calls.some((line) => line.startsWith('tag ') && line.endsWith('mao-runtime:latest'))).toBe(true);
    }
  });

  it('force rebuilds even when the label already matches', () => {
    const { root, lockfile } = makeRepo();
    const hash = depsHashOfLockfile(lockfile);
    const { result, calls } = runScript(root, 'align-runtime-image.sh', {
      label: hash,
      args: ['--force'],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(calls.some((line) => line.startsWith('build '))).toBe(true);
    expect(calls.some((line) => line.startsWith('tag ') && line.endsWith('mao-runtime:latest'))).toBe(true);
  });

  it('fails before building when the current dist is missing', () => {
    const { root } = makeRepo();
    const distEntry = join(root, 'backend-ts', 'dist', 'harness', 'container', 'runtime-agent.js');
    // 删除刚写好的入口，模拟未构建后端
    rmSync(distEntry);
    const { result, calls } = runScript(root, 'align-runtime-image.sh', { label: '0000000000000000' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('请先构建后端');
    expect(calls.filter((line) => line.startsWith('build '))).toHaveLength(0);
  });

  it('build script with a custom tag does not touch latest without --tag-latest', () => {
    const { root } = makeRepo();
    const first = runScript(root, 'build-runtime-image.sh', { args: ['candidate'] });
    expect(first.result.status, first.result.stderr).toBe(0);
    expect(first.calls.some((line) => line.startsWith('tag '))).toBe(false);

    const second = runScript(root, 'build-runtime-image.sh', { args: ['candidate', '--tag-latest'] });
    expect(second.result.status, second.result.stderr).toBe(0);
    expect(second.calls).toContain('tag mao-runtime:candidate mao-runtime:latest');
  });
});
