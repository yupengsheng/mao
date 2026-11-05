import { createHash } from 'node:crypto';

/** 等待摘要只保存脱敏投影，落库前统一限制在 2KB 以内。 */
export const WAIT_SUMMARY_MAX_BYTES = 2 * 1024;

const MASK = '******';
const FALLBACK_SUMMARY = JSON.stringify({ summary: '等待请求（参数已隐藏）', truncated: true });
const SENSITIVE_KEY = /(token|password|passwd|secret|authorization|cookie|private[_-]?key|api[_-]?key|access[_-]?key|credential)/i;

export interface TaskWaitPayload {
  payloadSummary: string;
  payloadDigest: string;
}

type JsonObject = Record<string, unknown>;

/**
 * 审批等待摘要：只保留工具名、目标与参数预览。
 * 原始参数仅用于生成摘要哈希，不落库、不写日志。
 */
export function approvalWaitPayload(
  toolName: string,
  argumentsJson: string,
  dangerReason: string | null,
): TaskWaitPayload {
  let parsed: unknown = argumentsJson;
  let parseable = false;
  if (argumentsJson.trim() !== '') {
    try {
      parsed = JSON.parse(argumentsJson);
      parseable = true;
    } catch {
      parsed = argumentsJson;
    }
  } else {
    parsed = {};
    parseable = true;
  }

  const target = extractTarget(toolName, parseable ? parsed : null);
  const argumentPreview = typeof parsed === 'string'
    ? maskInlineSecrets(parsed)
    : stableStringify(maskValue(parsed));
  const summary = summarize({ toolName, target, argumentPreview });

  return {
    payloadSummary: summary,
    payloadDigest: digestJson({ toolName, arguments: parsed, dangerReason }),
  };
}

/** 提问等待摘要：只保留问题白名单字段，metadata、默认值与答案一律丢弃。 */
export function questionWaitPayload(
  questions: Array<Record<string, unknown>>,
  metadata: Record<string, unknown> | null,
): TaskWaitPayload {
  const projection = questions.map((question) => {
    const options = Array.isArray(question.options)
      ? question.options.map((option) => {
        const node = asObject(option);
        return node == null ? null : withoutUndefined({
          label: text(node.label),
          description: text(node.description),
        });
      }).filter((option): option is JsonObject => option != null)
      : undefined;
    return withoutUndefined({
      id: text(question.id),
      header: text(question.header),
      question: text(question.question),
      options,
    });
  });

  return {
    payloadSummary: summarize({ questionCount: questions.length, questions: projection }),
    // metadata 不进入摘要；哈希仍覆盖完整请求，便于同请求幂等与诊断。
    payloadDigest: digestJson({ questions, metadata }),
  };
}

/** 无摘要场景（旧调用方/测试桩）的安全兜底。 */
export function hiddenWaitPayload(): TaskWaitPayload {
  return { payloadSummary: FALLBACK_SUMMARY, payloadDigest: digestJson(null) };
}

export function digestJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** 递归掩码敏感字段与常见内联凭据，供测试与摘要生成共用。 */
export function maskValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[层级过深]';
  if (typeof value === 'string') return maskInlineSecrets(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => maskValue(item, depth + 1));
  }
  const node = asObject(value);
  if (node == null) return value;
  const result: JsonObject = {};
  let count = 0;
  for (const [key, item] of Object.entries(node)) {
    if (count >= 100) {
      result._truncated = true;
      break;
    }
    count += 1;
    result[key] = SENSITIVE_KEY.test(key) ? MASK : maskValue(item, depth + 1);
  }
  return result;
}

function summarize(value: unknown): string {
  const json = stableStringify(value);
  return Buffer.byteLength(json, 'utf8') <= WAIT_SUMMARY_MAX_BYTES ? json : FALLBACK_SUMMARY;
}

function extractTarget(toolName: string, parsed: unknown): string | null {
  const node = asObject(parsed);
  if (node == null) return null;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = node[key];
      if (typeof value === 'string' && value.trim() !== '') return maskInlineSecrets(value);
    }
    return null;
  };
  switch (toolName.toLowerCase()) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return pick('path', 'filePath', 'file');
    case 'shell':
      return pick('command');
    case 'glob':
    case 'list':
      return pick('pattern');
    case 'http_call':
      return pick('tool');
    default:
      return pick('path', 'target', 'url', 'name');
  }
}

function maskInlineSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[私钥已隐藏]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, MASK)
    .replace(
      /\b(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b(\s*[:=]\s*)(["']?)[^\s"',;}]+/gi,
      `$1$2$3${MASK}`,
    );
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  const node = asObject(value);
  if (node == null) return value;
  const result: JsonObject = {};
  for (const key of Object.keys(node).sort()) {
    const item = normalize(node[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
