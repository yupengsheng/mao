import { describe, expect, it } from 'vitest';
import { containerMcpEnv } from './container-mcp-bridge.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';

function envelope(maoBaseUrl: string | null): RuntimeEnvelope {
  return {
    userId: 7,
    sessionId: 11,
    workspace: null,
    home: null,
    runtimeDir: null,
    gitTokens: {},
    maoToken: null,
    maoBaseUrl,
    ecpToken: null,
    larkUat: null,
    depsEnv: {},
    envVars: {},
  };
}

describe('container MCP environment', () => {
  it('passes the envelope site address to the MCP stdio process', () => {
    const env = containerMcpEnv({ MCP_SETTING: 'server-value' }, envelope('https://mao.example.com'));
    expect(env.MAO_BASE_URL).toBe('https://mao.example.com');
    expect(env.MCP_SETTING).toBe('server-value');
  });

  it('does not synthesize MAO_BASE_URL when the site address is absent', () => {
    const env = containerMcpEnv({}, envelope(null));
    expect(env.MAO_BASE_URL).toBeUndefined();
  });
});
