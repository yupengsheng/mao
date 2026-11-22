import Fastify from 'fastify';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { registerAgentExperienceLibraryRoutes } from './agent-experience-library.routes.js';
import { ExperienceIndexService } from '../harness/experience/experience-index.service.js';

const AGENT = { id: 1, name: 'A', systemPrompt: 'p', experienceLibraryEnabled: 1 };

function makeApp(hasPermission: boolean, agent = AGENT) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    req.userId = 7;
    done();
  });
  const agentService = {
    getAgent: vi.fn(async () => agent),
    listAgents: vi.fn(async () => [agent]),
    setExperienceLibraryEnabled: vi.fn(async (id: number, enabled: boolean) => ({
      ...agent, id, experienceLibraryEnabled: enabled ? 1 : 0,
    })),
  };
  const agentRepository = {
    findByIds: vi.fn(async () => [agent]),
  };
  const permissionService = { hasPermission: vi.fn(async () => hasPermission) };
  const experienceIndexService = new ExperienceIndexService(join(useTmpDir('exp-routes-'), 'agent-experience'));
  registerAgentExperienceLibraryRoutes(fastify, {
    agentService: agentService as never,
    agentRepository,
    experienceIndexService,
    permissionService,
  });
  return { app: fastify, agentService, agentRepository, permissionService, experienceIndexService };
}

describe('agent experience library routes', () => {
  it('read endpoints require agent:read and write endpoints require agent:write', async () => {
    const { app, permissionService } = makeApp(false);
    try {
      for (const url of [
        '/v1/agents/1/experience-library/docs',
        '/v1/agents/1/experience-library/index',
        '/v1/agents/1/experience-library/docs/content?file=a.md',
      ]) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
      }
      for (const [method, url] of [
        ['PUT', '/v1/agents/1/experience-library/docs/content'],
        ['DELETE', '/v1/agents/1/experience-library/docs?file=a.md'],
        ['POST', '/v1/agents/1/experience-library/index/rebuild'],
        ['PATCH', '/v1/agents/1/experience-library'],
      ] as const) {
        expect((await app.inject({ method, url })).statusCode).toBe(403);
      }
      expect(permissionService.hasPermission).toHaveBeenCalledWith(7, 'agent:read');
      expect(permissionService.hasPermission).toHaveBeenCalledWith(7, 'agent:write');
    } finally {
      await app.close();
    }
  });

  it('read endpoints succeed with agent:read while preserving the legacy list response', async () => {
    const { app, experienceIndexService } = makeApp(true);
    experienceIndexService.writeDoc(
      experienceIndexService.dirFor(1), 'readable.md', '---\ntitle: Readable\n---\nbody',
    );
    try {
      const list = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs' });
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toMatchObject({ enabled: true, indexContent: expect.any(String) });
      expect(list.json().data.docs).toEqual([expect.objectContaining({ fileName: 'readable.md' })]);

      const index = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/index' });
      expect(index.statusCode).toBe(200);
      expect(index.json().data).toMatchObject({ fileName: 'INDEX.md', docCount: 1 });

      const content = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs/content?file=readable.md' });
      expect(content.statusCode).toBe(200);
      expect(content.json().data.content).toContain('body');
    } finally {
      await app.close();
    }
  });

  it('toggles enabled via PATCH', async () => {
    const { app } = makeApp(true);
    try {
      const res = await app.inject({
        method: 'PATCH', url: '/v1/agents/1/experience-library', payload: { enabled: false },
      });
      expect(res.json().data).toEqual({ enabled: false });
      const invalid = await app.inject({ method: 'PATCH', url: '/v1/agents/1/experience-library', payload: { enabled: 'yes' } });
      expect(invalid.json().code).not.toBe(0);
    } finally {
      await app.close();
    }
  });

  it('lists docs with index content, reads/writes/deletes a doc and rebuilds index', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      const put = await app.inject({
        method: 'PUT', url: '/v1/agents/1/experience-library/docs/content',
        payload: { fileName: '2026-10-24-t.md', content: '---\ntitle: T\nkeywords: k\n---\nbody' },
      });
      expect(put.json().code).toBe(0);

      const list = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs' });
      const data = list.json().data;
      expect(data.enabled).toBe(true);
      expect(data.docs).toHaveLength(1);
      expect(data.docs[0]).toMatchObject({ fileName: '2026-10-24-t.md', title: 'T', keywords: 'k' });
      expect(data.indexContent).toContain('2026-10-24-t.md');

      const read = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs/content?file=2026-10-24-t.md' });
      expect(read.json().data.content).toContain('body');
      expect((await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs/content?file=nope.md' })).json().code).not.toBe(0);

      const rebuild = await app.inject({ method: 'POST', url: '/v1/agents/1/experience-library/index/rebuild' });
      expect(rebuild.json().code).toBe(0);

      const del = await app.inject({ method: 'DELETE', url: '/v1/agents/1/experience-library/docs?file=2026-10-24-t.md' });
      expect(del.json().code).toBe(0);
      expect(experienceIndexService.listDocs(experienceIndexService.dirFor(1))).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('returns overview with agent libraries, orphan libraries and the index protocol', async () => {
    const { app, agentRepository, experienceIndexService } = makeApp(true);
    try {
      await app.inject({
        method: 'PUT', url: '/v1/agents/1/experience-library/docs/content',
        payload: { fileName: '2026-11-overview.md', content: '---\ntitle: Overview\n---\nbody' },
      });
      experienceIndexService.writeDoc(
        experienceIndexService.dirFor(99), 'orphan.md', '---\ntitle: Orphan\n---\nbody',
      );
      const overview = await app.inject({ method: 'GET', url: '/v1/agents/experience-library/overview' });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().data.libraries).toEqual([
        expect.objectContaining({ agentId: 1, agentName: 'A', enabled: true, docCount: 1 }),
      ]);
      expect(overview.json().data.orphans).toEqual([
        expect.objectContaining({ agentId: 99, docCount: 1, totalBytes: expect.any(Number) }),
      ]);
      expect(agentRepository.findByIds).toHaveBeenCalledWith([1, 99]);

      const index = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/index' });
      expect(index.json().data).toMatchObject({ fileName: 'INDEX.md', docCount: 1 });
      expect(index.json().data.content).toContain('2026-11-overview.md');
    } finally {
      await app.close();
    }
  });

  it('supports filtered pagination, group counts and full-library keyword facets', async () => {
    const { app } = makeApp(true);
    try {
      const documents = [
        ['2026-01-alpha.md', 'Alpha', 'alpha, beta', '2026-01-10'],
        ['2026-02-beta.md', 'Beta', 'beta', '2026-02-10'],
        ['legacy.md', null, '', ''],
      ] as const;
      for (const [fileName, title, keywords, verified] of documents) {
        const frontmatter = title == null ? 'plain legacy body' : `---\ntitle: ${title}\nkeywords: ${keywords}\nlast_verified: ${verified}\n---\nbody`;
        expect((await app.inject({
          method: 'PUT', url: '/v1/agents/1/experience-library/docs/content', payload: { fileName, content: frontmatter },
        })).json().code).toBe(0);
      }

      const filtered = await app.inject({
        method: 'GET',
        url: '/v1/agents/1/experience-library/docs?page=1&size=1&tag=beta&groupBy=keyword&sort=title&order=asc',
      });
      const data = filtered.json().data;
      expect(data).toMatchObject({ enabled: true, total: 2, page: 1, size: 1 });
      expect(data.docs).toHaveLength(1);
      expect(data.docs[0]).toMatchObject({ fileName: '2026-01-alpha.md', title: 'Alpha' });
      expect(data.groupCounts).toEqual([
        { key: 'alpha', count: 1 },
        { key: 'beta', count: 1 },
      ]);
      expect(data.keywords).toEqual([
        { tag: 'beta', count: 2 },
        { tag: 'alpha', count: 1 },
      ]);
      expect(data.keywordsTotal).toBe(2);

      const tagSearch = await app.inject({
        method: 'GET',
        url: '/v1/agents/1/experience-library/docs?page=1&size=20&tagSearch=ALP',
      });
      expect(tagSearch.json().data).toMatchObject({ total: 3, keywordsTotal: 1 });
      expect(tagSearch.json().data.keywords).toEqual([{ tag: 'alpha', count: 1 }]);
      expect(tagSearch.json().data.docs).toHaveLength(3);

      const abnormal = await app.inject({
        method: 'GET', url: '/v1/agents/1/experience-library/docs?page=1&size=20&abnormal=no-frontmatter',
      });
      expect(abnormal.json().data.docs).toEqual([expect.objectContaining({ fileName: 'legacy.md' })]);

      for (const query of ['page=0', 'size=101', 'sort=unknown', 'order=sideways', 'verifiedFrom=2026-2-1', 'abnormal=unknown', `tagSearch=${'k'.repeat(61)}`]) {
        const response = await app.inject({ method: 'GET', url: `/v1/agents/1/experience-library/docs?${query}` });
        expect(response.json().code).not.toBe(0);
      }
    } finally {
      await app.close();
    }
  });

  it('requires agent:read for the cross-library overview', async () => {
    const { app, permissionService } = makeApp(false);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/agents/experience-library/overview' });
      expect(response.statusCode).toBe(403);
      expect(permissionService.hasPermission).toHaveBeenCalledWith(7, 'agent:read');
    } finally {
      await app.close();
    }
  });

  it('rejects traversal, non-md names and INDEX.md writes', async () => {
    const { app } = makeApp(true);
    try {
      for (const file of ['../escape.md', 'a/b.md', 'notes.txt', 'INDEX.md', 'index.md', 'INDEX.MD']) {
        const res = await app.inject({
          method: 'PUT', url: '/v1/agents/1/experience-library/docs/content',
          payload: { fileName: file, content: 'x' },
        });
        expect(res.json().code).not.toBe(0);
      }
      for (const file of ['INDEX.md', 'index.md']) {
        expect((await app.inject({ method: 'DELETE', url: `/v1/agents/1/experience-library/docs?file=${encodeURIComponent(file)}` })).json().code).not.toBe(0);
      }
    } finally {
      await app.close();
    }
  });

  it('returns 404-shaped business error for missing agent', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    const notFound = { getAgent: vi.fn(async () => { throw new BusinessException(ErrorCode.AGENT_NOT_FOUND); }) };
    registerAgentExperienceLibraryRoutes(fastify, {
      agentService: notFound as never,
      agentRepository: { findByIds: vi.fn(async () => []) },
      experienceIndexService: new ExperienceIndexService(join(useTmpDir('exp-routes-'), 'agent-experience')),
      permissionService: { hasPermission: vi.fn(async () => true) },
    });
    const res = await fastify.inject({ method: 'GET', url: '/v1/agents/99/experience-library/docs' });
    expect(res.json().code).not.toBe(0);
    await fastify.close();
  });
});
