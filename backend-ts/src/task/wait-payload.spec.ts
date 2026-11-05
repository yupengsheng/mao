import { describe, expect, it } from 'vitest';
import {
  approvalWaitPayload,
  digestJson,
  hiddenWaitPayload,
  questionWaitPayload,
  stableStringify,
  WAIT_SUMMARY_MAX_BYTES,
} from './wait-payload.js';

describe('wait payload summaries', () => {
  it('masks sensitive keys and inline credentials in approval arguments', () => {
    const payload = approvalWaitPayload('shell', JSON.stringify({
      command: 'curl -H "Authorization: Bearer super-secret-token" -d sk-abcdefgh12345678',
      password: 'hunter2',
      nested: { cookie: 'session=abc', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----' },
    }), 'danger');
    const summary = JSON.parse(payload.payloadSummary) as {
      toolName: string;
      target: string;
      argumentPreview: string;
    };

    expect(summary.toolName).toBe('shell');
    expect(summary.argumentPreview).not.toContain('hunter2');
    expect(summary.argumentPreview).not.toContain('session=abc');
    expect(summary.argumentPreview).not.toContain('secret\\n');
    expect(summary.argumentPreview).toContain('******');
    expect(summary.target).not.toContain('super-secret-token');
    expect(summary.target).not.toContain('sk-abcdefgh12345678');
    expect(payload.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redacts unparseable argument text and falls back when the summary exceeds 2KB', () => {
    const redacted = approvalWaitPayload('shell', 'Authorization: Bearer abc.def.ghi', null);
    expect(JSON.parse(redacted.payloadSummary).argumentPreview).not.toContain('abc.def.ghi');

    const oversized = approvalWaitPayload('write_file', JSON.stringify({
      path: 'large.txt',
      content: 'x'.repeat(WAIT_SUMMARY_MAX_BYTES + 1),
    }), null);
    expect(JSON.parse(oversized.payloadSummary)).toEqual({ summary: '等待请求（参数已隐藏）', truncated: true });
    expect(oversized.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps only whitelisted question fields and drops metadata and answers', () => {
    const payload = questionWaitPayload([{
      id: 'q1',
      header: '方案',
      question: '选择方案',
      options: [{ label: 'A', description: '第一个', defaultValue: 'A', answer: 'A' }],
      defaultValue: 'A',
      answer: 'A',
      context: '模型上下文',
    }], { token: 'metadata-secret', userId: 7 });
    const summary = JSON.parse(payload.payloadSummary);
    expect(summary).toEqual({
      questionCount: 1,
      questions: [{
        id: 'q1',
        header: '方案',
        question: '选择方案',
        options: [{ label: 'A', description: '第一个' }],
      }],
    });
    expect(payload.payloadSummary).not.toContain('metadata-secret');
    expect(payload.payloadSummary).not.toContain('模型上下文');
    expect(payload.payloadSummary).not.toContain('defaultValue');
    expect(payload.payloadSummary).not.toContain('"answer"');
  });

  it('normalizes digests independently of object key order', () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(digestJson({ b: 2, a: 1 })).toBe(digestJson({ a: 1, b: 2 }));
    expect(digestJson({ a: 1 })).not.toBe(digestJson({ a: 2 }));
  });

  it('provides a safe fallback for legacy callers', () => {
    const payload = hiddenWaitPayload();
    expect(JSON.parse(payload.payloadSummary)).toEqual({ summary: '等待请求（参数已隐藏）', truncated: true });
    expect(payload.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
