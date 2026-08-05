import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALL_CLIENT_NAMES,
  CLIENTS,
  detectClients,
  INDEX_MCP_URL,
  type SetupContext,
} from '../../src/cli/clients.js';

describe('clients', () => {
  let home: string;
  let cwd: string;
  let ctx: SetupContext;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mint-index-home-'));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mint-index-cwd-'));
    ctx = { home, cwd, platform: 'darwin', env: {} };
  });

  afterEach(async () => {
    await fs.remove(home);
    await fs.remove(cwd);
  });

  it('registers all seven clients', () => {
    expect(ALL_CLIENT_NAMES).toEqual([
      'claude',
      'cursor',
      'vscode',
      'codex',
      'opencode',
      'windsurf',
      'zed',
    ]);
  });

  it('every buildEntry points at the index MCP url', () => {
    for (const name of ALL_CLIENT_NAMES) {
      const entry = CLIENTS[name].buildEntry();
      expect(Object.values(entry)).toContain(INDEX_MCP_URL);
    }
  });

  it('claude global config respects CLAUDE_CONFIG_DIR', () => {
    expect(CLIENTS.claude.globalConfigPaths(ctx)).toEqual([path.join(home, '.claude.json')]);
    const custom = { ...ctx, env: { CLAUDE_CONFIG_DIR: '/tmp/claude-alt' } };
    expect(CLIENTS.claude.globalConfigPaths(custom)).toEqual([
      path.join('/tmp/claude-alt', '.claude.json'),
    ]);
  });

  it('vscode paths are platform specific', () => {
    expect(CLIENTS.vscode.globalConfigPaths(ctx)[0]).toBe(
      path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    );
    const linux = { ...ctx, platform: 'linux' as const };
    expect(CLIENTS.vscode.globalConfigPaths(linux)[0]).toBe(
      path.join(home, '.config', 'Code', 'User', 'mcp.json')
    );
  });

  it('zed paths are platform specific', () => {
    expect(CLIENTS.zed.globalConfigPaths(ctx)[0]).toBe(
      path.join(home, '.config', 'zed', 'settings.json')
    );
    const win32 = {
      ...ctx,
      platform: 'win32' as const,
      env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    };
    expect(CLIENTS.zed.globalConfigPaths(win32)[0]).toBe(
      path.join('C:\\Users\\me\\AppData\\Roaming', 'Zed', 'settings.json')
    );
    const win32NoAppData = { ...ctx, platform: 'win32' as const, env: {} };
    expect(CLIENTS.zed.globalConfigPaths(win32NoAppData)[0]).toBe(
      path.join(home, 'AppData', 'Roaming', 'Zed', 'settings.json')
    );
  });

  it('entry shapes match each client protocol', () => {
    expect(CLIENTS.claude.buildEntry()).toEqual({ type: 'http', url: INDEX_MCP_URL });
    expect(CLIENTS.cursor.buildEntry()).toEqual({ url: INDEX_MCP_URL });
    expect(CLIENTS.vscode.buildEntry()).toEqual({ type: 'http', url: INDEX_MCP_URL });
    expect(CLIENTS.codex.buildEntry()).toEqual({ type: 'http', url: INDEX_MCP_URL });
    expect(CLIENTS.opencode.buildEntry()).toEqual({
      type: 'remote',
      url: INDEX_MCP_URL,
      enabled: true,
    });
    expect(CLIENTS.windsurf.buildEntry()).toEqual({ serverUrl: INDEX_MCP_URL });
    expect(CLIENTS.zed.buildEntry()).toEqual({ url: INDEX_MCP_URL });
  });

  it('windsurf has no project config and zed has no rule', () => {
    expect(CLIENTS.windsurf.projectConfigPaths).toBeUndefined();
    expect(CLIENTS.zed.rule).toBeUndefined();
  });

  it('detectClients finds only clients whose dirs exist', async () => {
    await fs.mkdirp(path.join(home, '.cursor'));
    await fs.mkdirp(path.join(home, '.codex'));
    expect(await detectClients(ctx)).toEqual(['cursor', 'codex']);
  });
});
