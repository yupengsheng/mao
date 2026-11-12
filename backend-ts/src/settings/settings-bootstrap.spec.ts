import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSettingsBootstrap } from './settings-bootstrap.js';
import type { SystemSetting } from './types.js';

function row(key: string, value: string | null): SystemSetting {
  return { id: 1, settingKey: key, value, category: '集成配置', editable: 1 };
}

describe('runSettingsBootstrap', () => {
  const findByKey = vi.fn<(key: string) => Promise<SystemSetting | null>>();
  const updateById = vi.fn<(s: SystemSetting) => Promise<void>>();
  const repo = { findByKey, updateById };

  beforeEach(() => {
    findByKey.mockReset();
    updateById.mockReset();
  });

  it('importsEnvValuesIntoNullRows', async () => {
    findByKey.mockResolvedValue(row('auth.ldap.url', null));
    await runSettingsBootstrap(repo, 'k', { LDAP_URL: 'ldap://h:389' });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(updateById.mock.calls[0][0].value).toBe('ldap://h:389');
  });

  it('skipsRowsAlreadySavedIncludingExplicitlyCleared', async () => {
    findByKey.mockImplementation(async (key: string) => (key === 'upload.storageMode' ? row('upload.storageMode', '') : null));
    await runSettingsBootstrap(repo, 'k', { UPLOAD_STORAGE_MODE: 'oss' });
    expect(updateById).not.toHaveBeenCalled();
  });

  it('skipsWhenEnvMissing', async () => {
    findByKey.mockResolvedValue(row('auth.ldap.url', null));
    await runSettingsBootstrap(repo, 'k', {});
    expect(updateById).not.toHaveBeenCalled();
  });

  it('encryptsSecretValues', async () => {
    findByKey.mockResolvedValue(row('tools.tavilyApiKey', null));
    await runSettingsBootstrap(repo, 'k', { TAVILY_API_KEY: 'tvly-secret' });
    const stored = String(updateById.mock.calls[0][0].value);
    expect(stored).not.toBe('tvly-secret');
    expect(stored).toContain(':');
  });

  it('importsLegacyDingtalkOauthEnvAndEncryptsSecret', async () => {
    findByKey.mockImplementation(async (key: string) => row(key, null));
    await runSettingsBootstrap(repo, 'k', {
      DINGTALK_OAUTH_CLIENT_ID: 'ding-client',
      DINGTALK_OAUTH_SECRET: 'ding-secret',
      DINGTALK_OAUTH_REDIRECT_URI: 'https://mao.example.com/api/v1/dingtalk/oauth/callback',
    });
    const calls = updateById.mock.calls.map(([s]) => s);
    expect(calls.find((s) => s.settingKey === 'dingtalk.oauth.clientId')?.value).toBe('ding-client');
    expect(calls.find((s) => s.settingKey === 'dingtalk.oauth.redirectUri')?.value)
      .toBe('https://mao.example.com/api/v1/dingtalk/oauth/callback');
    const secret = calls.find((s) => s.settingKey === 'dingtalk.oauth.clientSecret');
    expect(secret).toBeDefined();
    expect(String(secret!.value)).not.toBe('ding-secret');
    expect(String(secret!.value)).toContain(':');
  });

  it('skipsSecretsWhenMasterKeyMissing', async () => {
    findByKey.mockResolvedValue(row('tools.tavilyApiKey', null));
    await runSettingsBootstrap(repo, '', { TAVILY_API_KEY: 'tvly-secret' });
    expect(updateById).not.toHaveBeenCalled();
  });

  it('encryptsTinyfishSecretAndImportsProvider', async () => {
    findByKey.mockImplementation(async (key: string) => {
      if (key === 'tools.tinyfishApiKey' || key === 'tools.webSearchProvider') return row(key, null);
      return row('tools.tavilyApiKey', null);
    });
    await runSettingsBootstrap(repo, 'k', { TINYFISH_API_KEY: 'tf-secret', WEB_SEARCH_PROVIDER: 'tinyfish' });
    const calls = updateById.mock.calls;
    const tinyfish = calls.find(([s]) => s.settingKey === 'tools.tinyfishApiKey');
    expect(tinyfish).toBeDefined();
    expect(String(tinyfish![0].value)).not.toBe('tf-secret');
    const provider = calls.find(([s]) => s.settingKey === 'tools.webSearchProvider');
    expect(provider![0].value).toBe('tinyfish');
  });

  it('survivesIndividualImportFailure', async () => {
    findByKey.mockImplementation(async (key: string) => {
      if (key === 'auth.ldap.url') throw new Error('db down');
      return row(key, null);
    });
    await runSettingsBootstrap(repo, 'k', { LDAP_URL: 'ldap://h', UPLOAD_BASE_URL: 'https://f.example' });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(updateById.mock.calls[0][0].settingKey).toBe('upload.baseUrl');
  });
});
