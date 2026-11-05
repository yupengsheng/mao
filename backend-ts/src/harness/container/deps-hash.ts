import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** 镜像依赖指纹 label：构建脚本写入，宿主 precheck 读取比对（技术方案 §4.3）。 */
export const RUNTIME_DEPS_HASH_LABEL = 'org.mao.runtime.deps-hash';
export const RUNTIME_DEPS_HASH_LENGTH = 16;

/**
 * backend-ts/package-lock.json 的 sha256 十六进制前 16 位。
 *
 * 与 `scripts/build-runtime-image.sh --print-deps-hash` 必须保持同一口径：
 * 文件字节哈希（不是规范化 JSON），因此构建脚本与后端拿到的是同一个值。
 */
export function depsHashOfLockfile(lockfilePath: string): string {
  const content = readFileSync(lockfilePath);
  return createHash('sha256').update(content).digest('hex').slice(0, RUNTIME_DEPS_HASH_LENGTH);
}
