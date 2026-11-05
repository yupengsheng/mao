import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 容器运行时依赖闭包契约（技术方案 2026-10-30 §4.2 D2）。
 *
 * runtime-agent 在容器内运行，代码来自宿主机只读挂载的 dist，第三方包只能来自运行时镜像。
 * 镜像由 backend-ts/package.json + package-lock.json 的 `npm ci --omit=dev` 构建，因此：
 * 1. 闭包中的运行时 bare import 必须是 dependencies（devDependencies 不会进镜像）；
 * 2. 不得出现非字面量动态 import（静态扫描无法证明它落在镜像内）；
 * 3. 相对 import 必须逐层递归，注释 / 模板串里的示例文本不算真实依赖。
 *
 * `import type` / `export type` 在 tsc 后会被擦除，不要求运行时包存在；这也是
 * `@mao/contracts` 虽在 devDependencies 却可以出现在容器源码中的原因。
 */
const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const srcDir = join(backendDir, 'src');
const entry = join(srcDir, 'harness', 'container', 'runtime-agent.ts');
const BUILTINS = new Set(builtinModules);

interface ClosureScan {
  files: string[];
  runtimeBareImports: Map<string, Set<string>>;
  typeBareImports: Map<string, Set<string>>;
  nonLiteralDynamicImports: Array<{ file: string; snippet: string }>;
}

/**
 * 去注释，并把模板串整体清空：模板串里的 `import ... from '...'` 示例不是真实依赖。
 * 单 / 双引号字符串保留（静态 import 的说明符就在其中）。
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '`') {
      out += '``';
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '`') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 把单 / 双引号字符串内容替换为空（保留引号），避免字符串里的 import( 被当成动态导入。 */
function maskStringContents(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === ch) { out += ch; i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = base.endsWith('.js')
    ? [`${base.slice(0, -3)}.ts`]
    : base.endsWith('.ts')
      ? [base]
      : [base, `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function packageRoot(specifier: string): string {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
}

/** `import type {...}` / `export type {...}` / 全成员带 type 前缀的命名导入。 */
function isTypeOnlyImport(keyword: string, clause: string): boolean {
  if (keyword === 'type') return true;
  const body = clause.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return false;
  const members = body.slice(1, -1).split(',').map((member) => member.trim()).filter(Boolean);
  return members.length > 0 && members.every((member) => /^type\s+/.test(member));
}

function scanClosure(): ClosureScan {
  const files = new Set<string>();
  const runtimeBareImports = new Map<string, Set<string>>();
  const typeBareImports = new Map<string, Set<string>>();
  const nonLiteralDynamicImports: ClosureScan['nonLiteralDynamicImports'] = [];
  const pending = [resolve(entry)];

  const addBare = (target: Map<string, Set<string>>, specifier: string, importer: string) => {
    const pkg = packageRoot(specifier);
    if (!target.has(pkg)) target.set(pkg, new Set());
    target.get(pkg)!.add(resolve(importer).slice(srcDir.length + 1));
  };

  const addRelative = (importer: string, specifier: string) => {
    const resolved = resolveRelative(importer, specifier);
    if (resolved == null) throw new Error(`unresolved import '${specifier}' from ${importer}`);
    pending.push(resolved);
  };

  while (pending.length > 0) {
    const file = resolve(pending.pop()!);
    if (files.has(file)) continue;
    files.add(file);
    const source = stripComments(readFileSync(file, 'utf8'));

    // `import ... from 'x'` / `export ... from 'x'`：只在行首匹配，避免把模板串 / 普通文本中的
    // 示例语句当成依赖（真实 import 语句在 tsc 源码里都从行首开始）。
    const staticFrom = /(?:^|\n)[ \t]*(import|export)\s+(type\s+)?([\s\S]*?)\sfrom\s+['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(staticFrom)) {
      const keyword = match[1]!;
      const typePrefix = match[2];
      const clause = match[3] ?? '';
      const specifier = match[4]!;
      if (specifier.startsWith('.')) {
        addRelative(file, specifier);
      } else if (!specifier.startsWith('node:') && !BUILTINS.has(specifier)) {
        const typeOnly = typePrefix != null || isTypeOnlyImport(keyword, clause);
        addBare(typeOnly ? typeBareImports : runtimeBareImports, specifier, file);
      }
    }

    // `import 'x'`（副作用导入）
    for (const match of source.matchAll(/(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('.')) addRelative(file, specifier);
      else if (!specifier.startsWith('node:') && !BUILTINS.has(specifier)) addBare(runtimeBareImports, specifier, file);
    }

    // 字面量动态 import：继续纳入闭包
    for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('.')) addRelative(file, specifier);
      else if (!specifier.startsWith('node:') && !BUILTINS.has(specifier)) addBare(runtimeBareImports, specifier, file);
    }

    // 非字面量动态 import：字符串内容已清空，因此 import('x') 仍能看到引号，import(变量) 不能。
    for (const match of maskStringContents(source).matchAll(/\bimport\s*\(\s*(?!['"])/g)) {
      nonLiteralDynamicImports.push({
        file: file.slice(srcDir.length + 1),
        snippet: source.slice(match.index ?? 0, (match.index ?? 0) + 100).replace(/\s+/g, ' '),
      });
    }
  }

  return {
    files: [...files].map((file) => file.slice(srcDir.length + 1)).sort(),
    runtimeBareImports,
    typeBareImports,
    nonLiteralDynamicImports,
  };
}

describe('container runtime dependency closure', () => {
  it('runtime imports stay within production dependencies', () => {
    const scan = scanClosure();
    const pkg = JSON.parse(readFileSync(join(backendDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const production = new Set(Object.keys(pkg.dependencies ?? {}));
    const devOnly = new Set(Object.keys(pkg.devDependencies ?? {}));

    const missing = [...scan.runtimeBareImports.keys()].filter((name) => !production.has(name)).sort();
    const detail = [
      `runtime closure (${scan.files.length} files):`,
      ...scan.files.map((file) => `  ${file}`),
      '',
      'runtime bare imports:',
      ...[...scan.runtimeBareImports.entries()].sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([name, importers]) => [
          `  ${name}${production.has(name) ? '' : devOnly.has(name) ? ' [devDependencies]' : ' [missing]'}`,
          ...[...importers].sort().map((file) => `    <- ${file}`),
        ]),
      ...(scan.typeBareImports.size > 0
        ? ['', 'type-only imports (erased by tsc, not required at runtime):',
          ...[...scan.typeBareImports.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([name, importers]) => `  ${name} <- ${[...importers].sort().join(', ')}`)]
        : []),
    ].join('\n');

    expect(scan.files).toContain('harness/container/runtime-agent.ts');
    expect(missing, detail).toEqual([]);
  });

  it('does not use non-literal dynamic imports in the container closure', () => {
    const scan = scanClosure();
    expect(
      scan.nonLiteralDynamicImports,
      scan.nonLiteralDynamicImports.map((entry) => `${entry.file}: ${entry.snippet}`).join('\n'),
    ).toEqual([]);
  });
});
