import {
  ExperienceIndexStore,
  EXPERIENCE_INDEX_FILE,
  EXPERIENCE_MAX_DOC_BYTES,
  EXPERIENCE_ROOT_SUBDIR,
  indexTmpPath,
  isValidExperienceFileName,
} from '../shared/experience-index-store.js';
import { parseExperienceFrontmatter, type ExperienceFrontmatter } from './experience-frontmatter.js';

/** 工作区内挂载点名（符号链接名）：固定常量，不做配置。 */
export const EXPERIENCE_MOUNT_NAME = '团队经验';

export { EXPERIENCE_INDEX_FILE, EXPERIENCE_MAX_DOC_BYTES, EXPERIENCE_ROOT_SUBDIR, indexTmpPath, isValidExperienceFileName };

export interface ExperienceDocMeta extends ExperienceFrontmatter {
  fileName: string;
  sizeBytes: number;
  /** 文件 mtime 的 ISO 串（admin 列表展示「更新时间」）。 */
  updatedAt: string;
}

/**
 * 团队经验库索引服务（技术方案 2026-10-24 §3.5）。
 *
 * 文件系统实现下沉到 `harness/shared/experience-index-store`：宿主使用完整 YAML
 * frontmatter 解析，容器执行器使用同目录下无第三方依赖的轻量解析。两者共用索引格式、
 * 陈旧判定与原子写，避免行为漂移；本类保持宿主侧公开 API 不变。
 */
export class ExperienceIndexService extends ExperienceIndexStore {
  /** @param experienceRoot 经验根绝对路径（<shareDir>/agent-experience）。 */
  constructor(experienceRoot: string) {
    super(experienceRoot, parseExperienceFrontmatter);
  }
}
