import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { normalizeAndValidateGitDomain } from '../common/git-domain.js';
import { decryptAesCbc, encryptAesCbc } from '../crypto/aes-cbc.js';
import { harnessLog } from '../harness/log.js';
import type { Db } from '../db/db.js';

/** 系统默认 Git 凭据行；accessToken 只在服务内部解密，不作为列表 VO 返回。 */
export interface SystemGitCredential {
  id?: number;
  domain: string;
  accessToken: string;
  description?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 管理员按域名维护的默认 Git 凭据，使用与用户凭据相同的应用密钥加密。 */
export class SystemGitCredentialService {
  constructor(
    private readonly db: Db,
    private readonly secretKey: string,
  ) {}

  /** 只返回加密行；路由层再次固定脱敏，避免把明文带出管理接口。 */
  async list(): Promise<SystemGitCredential[]> {
    return this.db.query<SystemGitCredential>(
      'SELECT * FROM system_git_credential ORDER BY domain ASC',
      [],
    );
  }

  async create(domain: string, accessToken: string, description?: string | null): Promise<SystemGitCredential> {
    const normalizedDomain = normalizeAndValidateGitDomain(domain);
    if (!hasText(accessToken)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Access Token 不能为空');
    }
    if (await this.findByDomain(normalizedDomain)) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE);
    }
    const row: SystemGitCredential = {
      domain: normalizedDomain,
      accessToken: encryptAesCbc(accessToken.trim(), this.secretKey),
      description: description != null && description.trim() !== '' ? description.trim() : null,
    };
    const id = await this.db.insert('system_git_credential', row);
    row.id = id;
    return row;
  }

  /** Token 留空表示不修改；备注缺省不改、空串显式清除。 */
  async update(id: number, accessToken?: string | null, description?: string | null): Promise<SystemGitCredential> {
    const credential = await this.getById(id);
    if (!credential) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
    }
    if (hasText(accessToken ?? undefined)) {
      credential.accessToken = encryptAesCbc(accessToken!.trim(), this.secretKey);
    }
    if (description != null) {
      credential.description = description.trim() === '' ? null : description.trim();
    }
    await this.db.updateById('system_git_credential', id, {
      accessToken: credential.accessToken,
      description: credential.description,
    });
    return credential;
  }

  async delete(id: number): Promise<void> {
    const credential = await this.getById(id);
    if (!credential) {
      throw new BusinessException(ErrorCode.GIT_CREDENTIAL_NOT_FOUND);
    }
    await this.db.execute('DELETE FROM system_git_credential WHERE id = ?', [id]);
  }

  /** 宽松无白名单路径读取全量默认凭据；单行解密失败只跳过该行。 */
  async getTokenMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const credential of await this.list()) {
      try {
        map.set(credential.domain, decryptAesCbc(credential.accessToken, this.secretKey));
      } catch (error) {
        harnessLog(
          'warn',
          `[git-scope] default credential decrypt failed, skipped domain=${credential.domain}: ${(error as Error).message}`,
        );
      }
    }
    return map;
  }

  /** 只查询并解密白名单域；空数组直接短路，防止生成非法 IN ()。 */
  async getTokenMapFiltered(domains: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (domains.length === 0) return map;
    const placeholders = domains.map(() => '?').join(', ');
    const rows = await this.db.query<SystemGitCredential>(
      `SELECT * FROM system_git_credential WHERE domain IN (${placeholders})`,
      domains,
    );
    for (const credential of rows) {
      try {
        map.set(credential.domain, decryptAesCbc(credential.accessToken, this.secretKey));
      } catch (error) {
        harnessLog(
          'warn',
          `[git-scope] default credential decrypt failed, skipped domain=${credential.domain}: ${(error as Error).message}`,
        );
      }
    }
    return map;
  }

  /** 全站域枚举只返回域名，供 Agent 白名单候选使用。 */
  async listDomains(): Promise<string[]> {
    const rows = await this.db.query<{ domain: string }>(
      'SELECT domain FROM system_git_credential ORDER BY domain ASC',
      [],
    );
    return rows.map((row) => row.domain);
  }

  private async getById(id: number): Promise<SystemGitCredential | null> {
    return this.db.queryOne<SystemGitCredential>('SELECT * FROM system_git_credential WHERE id = ?', [id]);
  }

  private async findByDomain(domain: string): Promise<SystemGitCredential | null> {
    return this.db.queryOne<SystemGitCredential>('SELECT * FROM system_git_credential WHERE domain = ?', [domain]);
  }
}
