import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { opendir } from 'node:fs/promises';
import { GlobSearchTool } from './glob-search-tool.js';
import { PathSandbox } from '../../safety/path-sandbox.js';

vi.mock('node:fs/promises', () => ({ opendir: vi.fn() }));

const mockedOpendir = vi.mocked(opendir);

type Entry = { name: string; isDirectory: () => boolean; isFile: () => boolean };

function makeDirectory(entries: Entry[]): unknown {
  return {
    async *[Symbol.asyncIterator]() {
      yield* entries;
    },
  };
}

function file(name: string): Entry {
  return { name, isDirectory: () => false, isFile: () => true };
}

function child(name: string): Entry {
  return { name, isDirectory: () => true, isFile: () => false };
}

function error(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GlobSearchTool 局部目录故障', () => {
  it('跳过不可访问的子目录并继续返回其他文件', async () => {
    const root = path.join(tmpdir(), 'glob-search-eacces');
    const blocked = path.join(root, 'blocked');
    mockedOpendir.mockImplementation(async (directory) => {
      const current = String(directory);
      if (current === root) return makeDirectory([child('blocked'), file('visible.txt')]) as never;
      if (current === blocked) throw error('EACCES', 'permission denied') as never;
      throw error('ENOENT', current) as never;
    });

    const result = JSON.parse(await new GlobSearchTool(new PathSandbox(root)).execute(JSON.stringify({ pattern: '**/*.txt' })));

    expect(result.error).toBeUndefined();
    expect(result.files).toEqual(['visible.txt']);
  });

  it('子目录在递归期间消失时容错，不把局部故障变成整体失败', async () => {
    const root = path.join(tmpdir(), 'glob-search-enoent');
    const vanished = path.join(root, 'vanished');
    mockedOpendir.mockImplementation(async (directory) => {
      const current = String(directory);
      if (current === root) return makeDirectory([child('vanished'), file('still-here.txt')]) as never;
      if (current === vanished) throw error('ENOENT', 'directory disappeared') as never;
      throw error('ENOENT', current) as never;
    });

    const result = JSON.parse(await new GlobSearchTool(new PathSandbox(root)).execute(JSON.stringify({ pattern: '**/*.txt' })));

    expect(result.error).toBeUndefined();
    expect(result.files).toEqual(['still-here.txt']);
  });

  it('根目录错误必须作为整体错误返回', async () => {
    const root = path.join(tmpdir(), 'glob-search-root-error');
    mockedOpendir.mockRejectedValue(error('EACCES', 'root permission denied'));

    const result = JSON.parse(await new GlobSearchTool(new PathSandbox(root)).execute(JSON.stringify({ pattern: '**/*' })));

    expect(result.files).toEqual([]);
    expect(result.error).toContain('root permission denied');
  });

  it('子目录的非预期错误不吞掉', async () => {
    const root = path.join(tmpdir(), 'glob-search-unexpected');
    const broken = path.join(root, 'broken');
    mockedOpendir.mockImplementation(async (directory) => {
      const current = String(directory);
      if (current === root) return makeDirectory([child('broken')]) as never;
      if (current === broken) throw error('EIO', 'unexpected I/O failure') as never;
      throw error('ENOENT', current) as never;
    });

    const result = JSON.parse(await new GlobSearchTool(new PathSandbox(root)).execute(JSON.stringify({ pattern: '**/*' })));

    expect(result.files).toEqual([]);
    expect(result.error).toContain('unexpected I/O failure');
  });
});
