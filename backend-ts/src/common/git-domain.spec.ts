import { describe, expect, it } from 'vitest';
import {
  assertGitDomainValid,
  normalizeAndValidateGitDomain,
  normalizeGitDomain,
} from './git-domain.js';

describe('git-domain', () => {
  it('规范化协议前缀、路径与大小写', () => {
    expect(normalizeGitDomain(' HTTPS://GitHub.COM/owner/repo ')).toBe('github.com');
    expect(normalizeGitDomain('http://git.acg.team/a/b')).toBe('git.acg.team');
    expect(normalizeGitDomain('gitlab.example.com')).toBe('gitlab.example.com');
  });

  it('空值与非法格式给出独立文案', () => {
    expect(() => normalizeGitDomain('   ')).toThrow('域名不能为空');
    expect(() => assertGitDomainValid('not a domain')).toThrow('域名格式无效，示例: github.com');
    expect(() => normalizeAndValidateGitDomain('https://bad_domain.com/x')).toThrow('域名格式无效，示例: github.com');
  });

  it('接受常见域与子域', () => {
    expect(normalizeAndValidateGitDomain('https://git.acg.team/x')).toBe('git.acg.team');
    expect(normalizeAndValidateGitDomain('github.com')).toBe('github.com');
    expect(normalizeAndValidateGitDomain('a-b.c1.example.io')).toBe('a-b.c1.example.io');
  });
});
