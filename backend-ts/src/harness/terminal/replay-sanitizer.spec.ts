import { describe, expect, it } from 'vitest';
import { sanitizeReplayData } from './replay-sanitizer.js';

describe('sanitizeReplayData', () => {
  it.each([
    '\x1b]10;?\x07', '\x1b]11;?\x1b\\', '\x1b]12;?\x07',
    '\x1b]4;0;?\x07', '\x1b]4;?;?;?\x1b\\',
    '\x1b[c', '\x1b[0c', '\x1b[>0c', '\x1b[=c',
    '\x1b[5n', '\x1b[6n', '\x1b[?6n', '\x1b[?2$p', '\x1b[2$p',
    '\x1bP$qm\x1b\\', '\x1bP+q1F1E\x1b\\',
    '\x1b[14t', '\x1b[16t', '\x1b[18t',
    '\x1b[?1004h', '\x1b[?9;1000;1002;1003h',
  ])('drops historical queries/reporting modes %j', (query) => {
    expect(sanitizeReplayData(`before${query}after`)).toBe('beforeafter');
  });

  it.each([
    '', '中文 😀\r\nprompt$ ', '\x1b[32mok\x1b[0m',
    '\x1b[2J\x1b[1;1H\x1b[K\x1b[?25l\x1b[?1049h\x1b[?2004h',
    '\x1b]0;my title\x07', '\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\',
    '\x1b]4;0;rgb:0000/0000/0000\x07', '\x1b]10;rgb:ffff/ffff/ffff\x07',
    '\x1b]52;c;SGVsbG8=\x07', '\x1bPq#0;2;0;0;0#0~~\x1b\\',
    '\x1b[?2;2$y', '\x1b[2t\x1b[22;0t\x1b[23;0t',
    '\x1b[?1004l\x1b[?1002l', '\x1b(B',
    '\x1bXtext\x07', '\x1b^text\x1b\\', '\x1b_text\x1b\\',
  ])('preserves text and harmless escape sequences %j', (data) => {
    expect(sanitizeReplayData(data)).toBe(data);
  });

  it('filters the reported C1 CSI/OSC/DCS queries', () => {
    expect(sanitizeReplayData('x\x9b6ny')).toBe('xy');
    expect(sanitizeReplayData('\x9d11;?\x07')).toBe('');
    expect(sanitizeReplayData('\x90$qm\x9c')).toBe('');
  });

  it.each([
    '\x9bc', '\x9b>0c', '\x9b=c', '\x9b5n', '\x9b?6n', '\x9b?2$p', '\x9b2$p',
    '\x9b14t', '\x9b16t', '\x9b18t', '\x9b?1004h', '\x9b?9;1000;1002;1003h',
    '\x9d10;?\x9c', '\x9d12;?\x1b\\', '\x9d4;0;?\x07', '\x9d4;?;?;?\x9c',
    '\x90+q1F1E\x9c', '\x90$qm\x1b\\', '\x1b]11;?\x9c', '\x1bP$qm\x9c',
  ])('drops equivalent C1 queries and mixed ST encodings %j', (query) => {
    expect(sanitizeReplayData(`x${query}y`)).toBe('xy');
  });

  it.each([
    '\x9b32mok\x9b0m', '\x9b2J\x9b1;1H\x9bK\x9b?25l\x9b?1049h\x9b?2004h',
    '\x9d0;my title\x9c', '\x9d8;;https://example.test\x9clink\x9d8;;\x9c',
    '\x9d4;0;rgb:0000/0000/0000\x9c', '\x9d11;rgb:ffff/ffff/ffff\x07',
    '\x90q#0;2;0;0;0#0~~\x9c', '\x9b?2;2$y', '\x9b?1004l\x9b?1002l',
    '\x9b2t\x9b22;0t\x9b23;0t', '\x1b]0;title\x9c', '\x1bPqpayload\x9c',
    '\x98text\x9c\x9etext\x9c\x9ftext\x9c', '\x84\x85\x88\x8d\x9c',
  ])('preserves non-query C1 display controls and original encodings %j', (data) => {
    expect(sanitizeReplayData(`中文${data}😀`)).toBe(`中文${data}😀`);
  });

  it('rewrites mixed private mode sets without losing unrelated modes', () => {
    expect(sanitizeReplayData('\x1b[?1004;1049h')).toBe('\x1b[?1049h');
    expect(sanitizeReplayData('\x1b[?1002;1006h')).toBe('\x1b[?1006h');
    expect(sanitizeReplayData('\x9b?1004;1049h')).toBe('\x9b?1049h');
    expect(sanitizeReplayData('\x9b?1002;1006h')).toBe('\x9b?1006h');
  });

  it.each(['\x1b', '\x1b[6', '\x1b]11;?', '\x1bP$qm', '\x9b', '\x9b6', '\x9d11;?', '\x90$qm'])('drops truncated query tails %j', (tail) => {
    expect(sanitizeReplayData(`text${tail}`)).toBe('text');
  });

  it('re-parses interrupted sequences instead of hiding a subsequent query', () => {
    expect(sanitizeReplayData('a\x1b(\x1bP$qm\x1b\\b')).toBe('ab');
    expect(sanitizeReplayData('a\x1b\x1b]11;?\x07b')).toBe('ab');
    expect(sanitizeReplayData('\x1b]0;title\x1b[6n')).toBe('');
    expect(sanitizeReplayData('\x1b[1\r\nX')).toBe('\r\nX');
    expect(sanitizeReplayData('text\x1b(')).toBe('text\x1b(');
    expect(sanitizeReplayData('a\x1b(\x90$qm\x9cb')).toBe('ab');
    expect(sanitizeReplayData('\x9d0;title\x9b6n')).toBe('');
    expect(sanitizeReplayData('\x1b]0;title\x9b6n')).toBe('');
    expect(sanitizeReplayData('\x9b1\x1b[6n')).toBe('');
    expect(sanitizeReplayData('\x9d0;title\x1b[6n')).toBe('');
  });

  it('handles large mixed history and is idempotent', () => {
    const keep = '中文\r\n\x1b[32mok\x1b[0m'.repeat(500);
    const once = sanitizeReplayData(`${keep}\x1b]11;?\x07\x1b[6n\x9d11;?\x9c\x90$qm\x9c\x9b6n\x1b[?1004;1049h\x9b?1004;1049h`);
    expect(once).toBe(`${keep}\x1b[?1049h\x9b?1049h`);
    expect(sanitizeReplayData(once)).toBe(once);
  });
});
