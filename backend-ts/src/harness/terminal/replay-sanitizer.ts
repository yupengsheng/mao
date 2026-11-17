/**
 * 仅历史回放过滤：旧终端查询会触发 xterm 自动应答，经 input 回到 PTY 后被 shell 当命令执行。
 * 实时程序仍需要应答，因此实时输出绝不能经过此过滤器。
 */
const ESC = '\u001b';
const BEL = '\u0007';
const ST = '\u009c';
/** C1 单字节形式与 ESC 引导形式共用分类，不改写无害控制序列的原始字节。 */
const C1_ESCAPE_TYPES: Readonly<Record<string, string>> = {
  '\u0090': 'P', '\u0098': 'X', '\u009b': '[', '\u009d': ']', '\u009e': '^', '\u009f': '_',
};
const OSC_COLOR_QUERY_IDS = new Set([4, 10, 11, 12]);
const REPORTING_MODES = new Set([9, 1000, 1002, 1003, 1004]);
const XTWINOPS_QUERY_OPS = new Set([14, 16, 18]);

type Decision = { end: number; replacement?: string };
interface StringSpan { contentEnd: number; end: number; unterminated: boolean }

/** 保留可见文本、SGR、光标、标题/链接；移除会应答的查询及上报模式开启。 */
export function sanitizeReplayData(data: string): string {
  const parts: string[] = [];
  let copied = 0;
  let i = 0;
  while (i < data.length) {
    if (data[i] !== ESC && C1_ESCAPE_TYPES[data[i]] === undefined) { i += 1; continue; }
    const decision = classifyEscape(data, i);
    if (decision.replacement !== undefined) {
      parts.push(data.slice(copied, i), decision.replacement);
      copied = decision.end;
    }
    i = decision.end;
  }
  parts.push(data.slice(copied));
  return parts.join('');
}

function classifyEscape(data: string, i: number): Decision {
  const c1Type = C1_ESCAPE_TYPES[data[i]];
  const next = c1Type ?? data[i + 1];
  const contentStart = i + (c1Type === undefined ? 2 : 1);
  if (next === undefined) return { end: data.length, replacement: '' };
  if (next === '[') return classifyCsi(data, i, contentStart);
  if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
    const span = scanStringSpan(data, contentStart);
    if (!span) {
      // 与上游一致：OSC/DCS 未闭合尾部丢弃，其余字符串型序列无应答语义。
      return { end: data.length, ...(next === ']' || next === 'P' ? { replacement: '' } : {}) };
    }
    if (span.unterminated) return { end: span.end, replacement: '' };
    const payload = data.slice(contentStart, span.contentEnd);
    if (next === ']') {
      const separator = payload.indexOf(';');
      if (separator > 0 && OSC_COLOR_QUERY_IDS.has(Number(payload.slice(0, separator)))
        && payload.slice(separator + 1).split(';').includes('?')) {
        return { end: span.end, replacement: '' };
      }
    } else if (next === 'P' && (payload.startsWith('$q') || payload.startsWith('+q'))) {
      return { end: span.end, replacement: '' };
    }
    return { end: span.end };
  }
  // 普通 ESC：中间字节 + 终字节；被 ESC/C0 中止时交回外层，不能漏掉后续查询。
  let p = i + 1;
  while (p < data.length && data.charCodeAt(p) >= 0x20 && data.charCodeAt(p) <= 0x2f) p += 1;
  if (p === data.length) return { end: p };
  const code = data.charCodeAt(p);
  return code >= 0x30 && code <= 0x7e ? { end: p + 1 } : { end: p, replacement: '' };
}

function classifyCsi(data: string, i: number, contentStart: number): Decision {
  let p = contentStart;
  const paramStart = p;
  while (p < data.length && data.charCodeAt(p) >= 0x30 && data.charCodeAt(p) <= 0x3f) p += 1;
  const params = data.slice(paramStart, p);
  const intermediateStart = p;
  while (p < data.length && data.charCodeAt(p) >= 0x20 && data.charCodeAt(p) <= 0x2f) p += 1;
  const intermediates = data.slice(intermediateStart, p);
  if (p === data.length || data.charCodeAt(p) < 0x20 || data.charCodeAt(p) > 0x7e) {
    return { end: p, replacement: '' };
  }
  const final = data[p];
  const end = p + 1;
  if ((intermediates === '$' && final === 'p') || final === 'c' || final === 'n') {
    return { end, replacement: '' };
  }
  if (final === 't' && XTWINOPS_QUERY_OPS.has(numericParams(params)[0])) {
    return { end, replacement: '' };
  }
  if (final === 'h' && params.startsWith('?')) {
    const modes = numericParams(params.slice(1));
    const kept = modes.filter((mode) => !REPORTING_MODES.has(mode));
    if (kept.length === 0) return { end, replacement: '' };
    if (kept.length !== modes.length) return { end, replacement: `${data.slice(i, contentStart)}?${kept.join(';')}h` };
  }
  return { end };
}

/** 字符串型序列以 BEL 或 ST（ESC \ / C1 ST）结束；新引导符中止后重新扫描。 */
function scanStringSpan(data: string, from: number): StringSpan | null {
  for (let p = from; p < data.length; p += 1) {
    if (data[p] === BEL || data[p] === ST) return { contentEnd: p, end: p + 1, unterminated: false };
    if (C1_ESCAPE_TYPES[data[p]] !== undefined) return { contentEnd: p, end: p, unterminated: true };
    if (data[p] === ESC) {
      return data[p + 1] === '\\'
        ? { contentEnd: p, end: p + 2, unterminated: false }
        : { contentEnd: p, end: p, unterminated: true };
    }
  }
  return null;
}

function numericParams(params: string): number[] {
  return params.replace(/^[<=>?]/, '').split(';')
    .filter((raw) => raw !== '').map(Number).filter(Number.isFinite);
}
