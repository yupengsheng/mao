import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchScriptProbe } from './script-probe-dispatch.js';

const ENV_KEYS = ['MAO_CONTAINER_USER_ID', 'MAO_WORKSPACE_ROOT', 'MAO_USER_HOME_DIR', 'MAO_DEPS_DIR', 'MAO_CHANNEL_TOKEN'] as const;

describe('dispatchScriptProbe', () => {
  let root: string;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    rmSync(join('/tmp', 'askpass-7'), { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function layout(): { projects: string; home: string; depsBin: string } {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    root = mkdtempSync(join(tmpdir(), 'mao-probe-dispatch-'));
    const projects = join(root, 'workspace', '7', 'projects');
    const home = join(root, 'users', '7');
    const depsBin = join(root, 'deps', '7', 'npm', 'bin');
    mkdirSync(projects, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(depsBin, { recursive: true });
    process.env.MAO_CONTAINER_USER_ID = '7';
    process.env.MAO_WORKSPACE_ROOT = join(root, 'workspace');
    process.env.MAO_USER_HOME_DIR = join(root, 'users');
    process.env.MAO_DEPS_DIR = join(root, 'deps');
    process.env.MAO_CHANNEL_TOKEN = 'channel-secret';
    return { projects, home, depsBin };
  }

  function writeScript(dir: string, name: string, body: string): string {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  }

  // msys sh 的 env 变量跨边界翻译在 Windows 打印非原值：断言的是 Linux 部署语义
  it.skipIf(process.platform === 'win32')('执行本人项目内脚本，stdout 字节原样返回，且不继承通道 token', async () => {
    const { projects, home, depsBin } = layout();
    const script = writeScript(projects, 'check.sh', [
      'printf "PATH=%s\\n" "$PATH"',
      'printf "TOKEN=%s\\n" "${MAO_CHANNEL_TOKEN-unset}"',
      'printf "HOME=%s\\n" "${HOME-unset}"',
      'printf "ID=%s\\n" "$MAO_WATCHER_ID"',
      'printf "NPM=%s\\n" "${NPM_CONFIG_PREFIX-unset}"',
    ].join('\n'));
    const result = await dispatchScriptProbe({
      scriptPath: script,
      timeoutSeconds: 10,
      env: {
        HOME: home,
        TZ: 'Asia/Shanghai',
        MAO_WATCHER_ID: '42',
        MAO_WATCHER_NAME: '磁盘',
        PATH: '/evil',
      } as never,
      deps: {
        NPM_CONFIG_PREFIX: join(root, 'deps', '7', 'npm'),
        PIP_TARGET: join(root, 'deps', '7', 'py'),
        PIP_BREAK_SYSTEM_PACKAGES: '1',
        MAO_DEPS_BIN: depsBin,
      },
    });
    expect(result.failureClass).toBe('script');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
    expect(stdout).toContain('TOKEN=unset');
    expect(stdout).toContain('ID=42');
    expect(stdout).toContain(`HOME=${realpathSync(home)}`);
    expect(stdout).toContain(`NPM=${realpathSync(join(root, 'deps', '7', 'npm'))}`);
    expect(stdout).not.toContain('PATH=/evil');
    expect(stdout.startsWith(`PATH=${realpathSync(depsBin)}:`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('按白名单注入凭据，过滤保留环境变量并写入容器 askpass', async () => {
    const { projects } = layout();
    const script = writeScript(projects, 'credentials.sh', [
      'printf "GIT=%s\\n" "$GIT_TOKEN_github_com"',
      'printf "MAO=%s ECP=%s BASE=%s\\n" "$MAO_TOKEN" "$ECP_TOKEN" "$MAO_BASE_URL"',
      'printf "LARK=%s APP=%s CUSTOM=%s\\n" "$LARKSUITE_CLI_USER_ACCESS_TOKEN" "$LARKSUITE_CLI_APP_ID" "$CUSTOM_ENV"',
      'printf "PATH=%s HOME=%s RESERVED=%s\\n" "$PATH" "${HOME-unset}" "${APP_SECRET-unset}"',
      'test -x "$GIT_ASKPASS"',
    ].join('\n'));
    const result = await dispatchScriptProbe({
      scriptPath: script,
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
      deps: null,
      credentials: {
        gitTokens: { 'github.com': 'ghp-probe' },
        maoToken: 'mao-probe',
        ecpToken: 'ecp-probe',
        maoBaseUrl: 'https://mao.example.test',
        larkUat: { appId: 'app-probe', uat: 'uat-probe' },
        envVars: {
          CUSTOM_ENV: 'custom-probe',
          PATH: '/evil',
          HOME: '/evil',
          APP_SECRET: 'should-be-filtered',
          MAO_TOKEN: 'should-not-override',
        },
      },
    });
    expect(result.ok).toBe(true);
    const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
    expect(stdout).toContain('GIT=ghp-probe');
    expect(stdout).toContain('MAO=mao-probe ECP=ecp-probe BASE=https://mao.example.test');
    expect(stdout).toContain('LARK=uat-probe APP=app-probe CUSTOM=custom-probe');
    expect(stdout).toContain('RESERVED=unset');
    expect(stdout).not.toContain('PATH=/evil');
    expect(stdout).toContain('HOME=unset');
  });

  it('软链逃出项目工作区时判脚本失败，不执行', async () => {
    const { projects } = layout();
    const outside = mkdtempSync(join(tmpdir(), 'mao-probe-outside-'));
    try {
      const target = join(outside, 'evil.sh');
      writeFileSync(target, 'printf pwned\n');
      const link = join(projects, 'check.sh');
      symlinkSync(target, link);
      const result = await dispatchScriptProbe({
        scriptPath: link,
        timeoutSeconds: 10,
        env: { MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
        deps: null,
      });
      expect(result.failureClass).toBe('script');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('越出项目工作区');
      expect(result.stdoutBase64).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // msys sh 的 env 变量跨边界翻译在 Windows 打印非原值：断言的是 Linux 部署语义
  it.skipIf(process.platform === 'win32')('HOME 与 deps 前缀越出本人目录时丢掉，探针仍执行', async () => {
    const { projects } = layout();
    const outside = mkdtempSync(join(tmpdir(), 'mao-probe-home-'));
    try {
      mkdirSync(outside, { recursive: true });
      const script = writeScript(projects, 'check.sh', 'printf "HOME=%s NPM=%s\\n" "${HOME-unset}" "${NPM_CONFIG_PREFIX-unset}"\n');
      const result = await dispatchScriptProbe({
        scriptPath: script,
        timeoutSeconds: 10,
        env: { HOME: outside, MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
        deps: {
          NPM_CONFIG_PREFIX: outside,
          PIP_TARGET: outside,
          PIP_BREAK_SYSTEM_PACKAGES: 'nope',
          MAO_DEPS_BIN: outside,
        },
      });
      expect(result.ok).toBe(true);
      const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
      expect(stdout).toContain('HOME=unset');
      expect(stdout).toContain('NPM=unset');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('注入凭据到子进程环境并过滤保留键，旧帧无凭据仍可执行', async () => {
    const { projects } = layout();
    const script = writeScript(projects, 'credentials.sh', [
      'printf "GIT=%s\\n" "$GIT_TOKEN_git_example_com"',
      'printf "MAO=%s ECP=%s BASE=%s\\n" "$MAO_TOKEN" "$ECP_TOKEN" "$MAO_BASE_URL"',
      'printf "LARK=%s/%s\\n" "$LARKSUITE_CLI_APP_ID" "$LARKSUITE_CLI_USER_ACCESS_TOKEN"',
      'printf "ASKPASS=%s\\n" "$GIT_ASKPASS"',
      'printf "PROMPT=%s\\n" "$GIT_TERMINAL_PROMPT"',
      'printf "OK=%s BADPATH=%s BADMAO=%s\\n" "$WATCHER_EXTRA" "$PATH" "$MAO_TOKEN"',
    ].join('\n'));
    try {
      const result = await dispatchScriptProbe({
        scriptPath: script,
        timeoutSeconds: 10,
        env: { MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
        deps: null,
        credentials: {
          gitTokens: { 'git.example.com': 'git-secret' },
          maoToken: 'mao-secret',
          ecpToken: 'ecp-secret',
          maoBaseUrl: 'https://mao.example.com',
          larkUat: { appId: 'app-id', uat: 'uat-secret' },
          envVars: { WATCHER_EXTRA: 'allowed', PATH: '/evil', MAO_TOKEN: 'override', APP_SECRET: 'blocked' },
        },
      });
      expect(result.ok).toBe(true);
      const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
      expect(stdout).toContain('GIT=git-secret');
      expect(stdout).toContain('MAO=mao-secret ECP=ecp-secret BASE=https://mao.example.com');
      expect(stdout).toContain('LARK=app-id/uat-secret');
      expect(stdout).toContain('PROMPT=0');
      expect(stdout).toContain('OK=allowed');
      expect(stdout).toContain('BADMAO=mao-secret');
      expect(stdout).not.toContain('BADPATH=/evil');
      expect(stdout).toMatch(/ASKPASS=\/tmp\/askpass-7\/watcher-askpass\.sh/);
    } finally {
      rmSync('/tmp/askpass-7', { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('凭据帧注入白名单变量并写入容器私有 askpass', async () => {
    const { projects } = layout();
    const script = writeScript(projects, 'check.sh', [
      'printf "MT=%s\\n" "${MAO_TOKEN-unset}"',
      'printf "ET=%s\\n" "${ECP_TOKEN-unset}"',
      'printf "BU=%s\\n" "${MAO_BASE_URL-unset}"',
      'printf "LU=%s\\n" "${LARKSUITE_CLI_USER_ACCESS_TOKEN-unset}"',
      'printf "GH=%s\\n" "${GIT_TOKEN_github_com-unset}"',
      'printf "CV=%s\\n" "${CUSTOM_VAR-unset}"',
      'printf "TP=%s\\n" "${GIT_TERMINAL_PROMPT-unset}"',
      'printf "AP=%s\\n" "${GIT_ASKPASS-unset}"',
    ].join('\n'));
    const result = await dispatchScriptProbe({
      scriptPath: script,
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '9', MAO_WATCHER_NAME: '磁盘' },
      deps: null,
      credentials: {
        gitTokens: { 'github.com': 'gh-tok' },
        maoToken: 'mao-jwt',
        ecpToken: 'ecp-tok',
        maoBaseUrl: 'https://mao.example.com',
        larkUat: { appId: 'cli_x', uat: 'uat-1' },
        envVars: { CUSTOM_VAR: 'v1', PATH: '/evil', MAO_TOKEN: 'hack' },
      },
    });
    expect(result.ok).toBe(true);
    const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
    expect(stdout).toContain('MT=mao-jwt');
    expect(stdout).toContain('ET=ecp-tok');
    expect(stdout).toContain('BU=https://mao.example.com');
    expect(stdout).toContain('LU=uat-1');
    expect(stdout).toContain('GH=gh-tok');
    expect(stdout).toContain('CV=v1');
    expect(stdout).toContain('TP=0');
    const askpassPath = stdout.split('\n').find((line) => line.startsWith('AP='))!.slice(3);
    expect(askpassPath).toContain('/tmp/askpass-7/');
    expect(statSync(askpassPath).mode & 0o777).toBe(0o700);
    expect(readFileSync(askpassPath, 'utf8')).toContain('GIT_TOKEN_');
    expect(stdout).not.toContain('PATH=/evil');
    expect(stdout).not.toContain('MT=hack');
    rmSync('/tmp/askpass-7', { recursive: true, force: true });
  });

  it('credentials 缺省时按旧帧降级，探针仍执行', async () => {
    const { projects } = layout();
    const script = writeScript(projects, 'legacy.sh', 'printf "MT=%s AP=%s ID=%s\\n" "${MAO_TOKEN-unset}" "${GIT_ASKPASS-unset}" "$MAO_WATCHER_ID"\n');
    const result = await dispatchScriptProbe({
      scriptPath: script,
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '9', MAO_WATCHER_NAME: '磁盘' },
      deps: null,
    });
    expect(result.ok).toBe(true);
    const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
    expect(stdout).toContain('MT=unset');
    expect(stdout).toContain('AP=unset');
    expect(stdout).toContain('ID=9');
  });

  it('缺少容器身份或哨兵标识时不执行，记基础设施失败', async () => {
    layout();
    delete process.env.MAO_CONTAINER_USER_ID;
    const missingUser = await dispatchScriptProbe({
      scriptPath: '/tmp/nope.sh',
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
      deps: null,
    });
    expect(missingUser).toMatchObject({ failureClass: 'infrastructure', error: '容器身份缺失' });
    process.env.MAO_CONTAINER_USER_ID = '7';
    const missingName = await dispatchScriptProbe({
      scriptPath: '/tmp/nope.sh',
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '1' },
      deps: null,
    });
    expect(missingName).toMatchObject({ failureClass: 'infrastructure', error: '探针参数不完整' });
  });
});
