import { describe, expect, it } from 'vitest';
import { parseExperienceFrontmatterLite } from './experience-frontmatter-lite.js';

const EMPTY = { title: '', keywords: '', summary: '', applicable: '', lastVerified: '' };

describe('parseExperienceFrontmatterLite', () => {
  it('parses the fields used by the experience index without third-party YAML', () => {
    const parsed = parseExperienceFrontmatterLite(`---
title: "MySQL 死锁排查实录"
keywords: [mysql, 死锁, innodb]
summary: >
  三步定位法
  先看锁等待
applicable: 'MySQL 8'
last_verified: 2026-10-24 # 最近一次验证
---

正文`);

    expect(parsed).toEqual({
      title: 'MySQL 死锁排查实录',
      keywords: 'mysql, 死锁, innodb',
      summary: '三步定位法 先看锁等待',
      applicable: 'MySQL 8',
      lastVerified: '2026-10-24',
    });
  });

  it('supports block lists, lastVerified alias and inline hash characters', () => {
    const parsed = parseExperienceFrontmatterLite(`---
title: C# 项目排障
keywords:
  - csharp
  - dotnet
lastVerified: 2026-11-01
summary: "处理 # 号参数"
---`);

    expect(parsed.keywords).toBe('csharp, dotnet');
    expect(parsed.lastVerified).toBe('2026-11-01');
    expect(parsed.summary).toBe('处理 # 号参数');
  });

  it('treats missing, malformed and non-object frontmatter as empty', () => {
    expect(parseExperienceFrontmatterLite('no frontmatter')).toEqual(EMPTY);
    expect(parseExperienceFrontmatterLite('---\n{{{broken\n---\nbody')).toEqual(EMPTY);
    expect(parseExperienceFrontmatterLite('---\n- a\n- b\n---\nbody')).toEqual(EMPTY);
    expect(parseExperienceFrontmatterLite('---\ntitle: no closing fence')).toEqual(EMPTY);
    expect(parseExperienceFrontmatterLite('---\ntitle: A\ntitle: B\n---')).toEqual(EMPTY);
  });

  it('does not cut the block on an inline --- or normalize quoted nulls', () => {
    expect(parseExperienceFrontmatterLite('---\ntitle: 步骤 --- 详细\n---\nbody').title).toBe('步骤 --- 详细');
    expect(parseExperienceFrontmatterLite('---\ntitle: "null"\nsummary: null\n---')).toMatchObject({
      title: 'null',
      summary: '',
    });
  });
});
