import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fail } from '../common/result.js';
import type { SkillLoader } from '../harness/skill/skill-loader.js';
import { isValidSkillName, parseSkillMdContent, validateSkillMd } from '../harness/skill/skill-md.js';
import type { SkillDocDetailVO, SkillDocVO, SkillResult, UploadedSkillFile } from './user-skill.service.js';
import { isHiddenRelativePath } from './read-skill-files.js';
import { uploadFileMode } from './upload-file-mode.js';

export interface SkillUploadFailure {
  folder: string;
  reason: string;
}

export interface SkillUploadResult {
  imported: string[];
  failed: SkillUploadFailure[];
}

export class SkillDocService {
  constructor(private readonly skillLoader: SkillLoader) {}

  listSkillDocs(): SkillDocVO[] {
    return this.skillLoader.getAllDocuments().map((doc) => ({
      name: doc.name,
      description: doc.description,
      folderPath: doc.folderPath ?? '',
      filePath: doc.filePath ?? '',
    }));
  }

  getSkillDoc(name: string): SkillResult<SkillDocDetailVO> {
    const doc = this.skillLoader.getAllDocuments().find((d) => d.name === name);
    if (doc == null) {
      return fail(404, `Skill not found: ${name}`);
    }
    return {
      code: 0,
      message: 'success',
      data: {
        name: doc.name,
        description: doc.description,
        body: doc.body,
        folderPath: doc.folderPath ?? '',
        filePath: doc.filePath ?? '',
      },
    };
  }

  uploadSkill(files: UploadedSkillFile[] | null | undefined): SkillResult<SkillUploadResult> {
    if (files == null || files.length === 0) {
      return fail(400, 'No files provided');
    }
    const skillsDir = this.skillLoader.getSkillsDir();
    try {
      mkdirSync(skillsDir, { recursive: true });
    } catch (e) {
      return fail(500, `Failed to create skills directory: ${(e as Error).message}`);
    }
    const grouped = groupSkillFiles(files);
    if (grouped.size === 0) {
      return fail(400, 'No valid skill folders found. Each skill must be in a subdirectory.');
    }

    const imported: string[] = [];
    const failed: SkillUploadFailure[] = [];
    for (const [skillName, group] of grouped) {
      const writeError = installSkillGroup(skillsDir, skillName, group);
      if (writeError != null) {
        failed.push({ folder: skillName, reason: writeError });
      } else {
        imported.push(skillName);
      }
    }
    if (imported.length > 0) {
      this.skillLoader.invalidateCache();
    }
    console.info(`Uploaded ${imported.length} skills: ${imported}; failed ${failed.length}: ${failed.map((item) => item.folder).join(', ')}`);
    return { code: 0, message: 'success', data: { imported, failed } };
  }

  deleteSkill(name: string): SkillResult<null> {
    const skillFolder = this.skillLoader.getSkillFolder(name);
    if (skillFolder == null) {
      return fail(404, `Skill not found: ${name}`);
    }
    try {
      if (existsSync(skillFolder) && statSync(skillFolder).isDirectory()) {
        rmSync(skillFolder, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Failed to delete skill folder ${skillFolder}: ${(e as Error).message}`);
      return fail(500, `Failed to delete skill: ${(e as Error).message}`);
    }
    this.skillLoader.invalidateCache();
    console.info(`Deleted skill: ${name}`);
    return { code: 0, message: 'success' };
  }
}

function groupSkillFiles(files: UploadedSkillFile[]): Map<string, UploadedSkillFile[]> {
  const grouped = new Map<string, UploadedSkillFile[]>();
  for (const file of files) {
    const originalName = file.originalFilename;
    if (originalName == null || originalName.trim().length === 0) continue;
    const normalized = originalName.replace(/\\/g, '/');
    const slashIdx = normalized.indexOf('/');
    if (slashIdx <= 0) continue;
    const skillName = normalized.slice(0, slashIdx);
    if (skillName.startsWith('.')) continue;
    const list = grouped.get(skillName) ?? [];
    list.push(file);
    grouped.set(skillName, list);
  }
  return grouped;
}

/**
 * 逐包安装：先完整写入 `skillsDir/.staging/<token>/<name>`，校验与写盘全部通过后再与目标目录交换。
 * 单个包失败只回滚自己的暂存内容，不影响同批其他包；目标已存在时先备份再覆盖，rename 失败会恢复原技能。
 */
function installSkillGroup(skillsDir: string, skillName: string, group: UploadedSkillFile[]): string | null {
  if (!isValidSkillName(skillName)) {
    return `技能目录名不合法：${skillName}`;
  }
  let skillMdFile: UploadedSkillFile | undefined;
  for (const file of group) {
    if (relativeAfterSkill(file.originalFilename) === 'SKILL.md') skillMdFile = file;
  }
  if (skillMdFile == null) {
    return `Skill '${skillName}' is missing SKILL.md file`;
  }
  const skillMd = skillMdFile.buffer.toString('utf8');
  const mdError = validateSkillMd(skillMd, skillName);
  if (mdError != null) {
    return `SKILL.md 校验失败：${mdError}`;
  }
  const frontName = parseSkillMdContent(skillMd)?.name?.trim();
  if (frontName !== skillName) {
    return `SKILL.md frontmatter name（${frontName ?? '缺失'}）与技能目录名（${skillName}）不一致`;
  }

  const stagingBase = join(skillsDir, '.staging');
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const stageRoot = join(stagingBase, token);
  const stagedFolder = join(stageRoot, skillName);
  const backupRoot = join(stagingBase, `${token}-bak`);
  const backupFolder = join(backupRoot, skillName);
  const finalFolder = join(skillsDir, skillName);
  let cleanupBackup = true;
  try {
    mkdirSync(stagedFolder, { recursive: true });
    for (const file of group) {
      const relativePath = relativeAfterSkill(file.originalFilename);
      if (relativePath.length === 0 || isHiddenRelativePath(relativePath)) continue;
      // 与个人技能写入 / 导出读取同口径：非法穿越段跳过，不因单个坏文件使整个包失败。
      if (relativePath.split('/').some((segment) => segment === '..' || segment.length === 0)) continue;
      const targetFile = join(stagedFolder, relativePath);
      const resolvedTarget = resolve(targetFile);
      const resolvedFolder = resolve(stagedFolder);
      if (resolvedTarget !== resolvedFolder && !resolvedTarget.startsWith(resolvedFolder + sep)) continue;
      mkdirSync(dirname(targetFile), { recursive: true });
      writeFileSync(targetFile, file.buffer, { mode: uploadFileMode(relativePath, file.buffer) });
    }

    let backedUp = false;
    try {
      if (existsSync(finalFolder)) {
        mkdirSync(backupRoot, { recursive: true });
        renameSync(finalFolder, backupFolder);
        backedUp = true;
        console.info(`Overwriting existing system skill: ${skillName}`);
      }
      renameSync(stagedFolder, finalFolder);
    } catch (e) {
      if (backedUp) {
        try {
          renameSync(backupFolder, finalFolder);
        } catch (restoreErr) {
          cleanupBackup = false;
          return `写入失败：${(e as Error).message}；原技能恢复失败：${(restoreErr as Error).message}`;
        }
      }
      throw e;
    }
    return null;
  } catch (e) {
    console.error(`Failed to write skill ${skillName}: ${(e as Error).message}`);
    return `写入失败：${(e as Error).message}`;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
    if (cleanupBackup) rmSync(backupRoot, { recursive: true, force: true });
    try {
      rmdirSync(stagingBase);
    } catch {
      // .staging 仍有其他并发上传时保留
    }
  }
}

function relativeAfterSkill(originalName: string | null | undefined): string {
  if (originalName == null) return '';
  const relativePath = originalName.replace(/\\/g, '/');
  const slashIdx = relativePath.indexOf('/');
  return slashIdx > 0 ? relativePath.slice(slashIdx + 1) : '';
}
