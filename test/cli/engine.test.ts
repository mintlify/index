import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENTS, INDEX_MCP_URL, type SetupContext } from '../../src/cli/clients.js';
import { readJsonConfig } from '../../src/cli/configFile.js';
import { setupClient } from '../../src/cli/engine.js';
import { RULE_MARKER } from '../../src/cli/rule.js';

describe('setupClient', () => {
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

  it('configures claude globally with entry and rule file', async () => {
    const result = await setupClient(CLIENTS.claude, 'global', ctx);
    expect(result.mcpStatus).toBe('configured');
    const config = await readJsonConfig(path.join(home, '.claude.json'));
    expect(config).toEqual({
      mcpServers: { 'mintlify-index': { type: 'http', url: INDEX_MCP_URL } },
    });
    expect(result.ruleStatus).toBe('installed');
    expect(await fs.pathExists(path.join(home, '.claude', 'rules', 'mintlify-index.md'))).toBe(
      true
    );
  });

  it('preserves unrelated keys in an existing claude config', async () => {
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ theme: 'dark', mcpServers: { other: { url: 'x' } } })
    );
    await setupClient(CLIENTS.claude, 'global', ctx);
    const config = await readJsonConfig(path.join(home, '.claude.json'));
    expect(config.theme).toBe('dark');
    const servers = config.mcpServers;
    expect(servers).toMatchObject({ other: { url: 'x' } });
  });

  it('rerun reports reconfigured and updated', async () => {
    await setupClient(CLIENTS.claude, 'global', ctx);
    const second = await setupClient(CLIENTS.claude, 'global', ctx);
    expect(second.mcpStatus).toBe('reconfigured');
    expect(second.ruleStatus).toBe('updated');
  });

  it('writes codex toml and appends AGENTS.md with markers', async () => {
    const result = await setupClient(CLIENTS.codex, 'global', ctx);
    expect(result.mcpStatus).toBe('configured');
    const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.mintlify-index]');
    expect(toml).toContain(`url = "${INDEX_MCP_URL}"`);
    const agentsMd = await fs.readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain(RULE_MARKER);
  });

  it('project scope writes into cwd for clients that support it', async () => {
    const result = await setupClient(CLIENTS.cursor, 'project', ctx);
    expect(result.mcpStatus).toBe('configured');
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'mcp.json'))).toBe(true);
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'rules', 'mintlify-index.mdc'))).toBe(
      true
    );
  });

  it('project scope falls back to global for windsurf mcp config', async () => {
    const result = await setupClient(CLIENTS.windsurf, 'project', ctx);
    expect(result.mcpStatus).toBe('configured');
    expect(result.mcpDetail).toBe(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'));
  });

  it('zed gets an entry under context_servers and no rule', async () => {
    const result = await setupClient(CLIENTS.zed, 'global', ctx);
    const config = await readJsonConfig(path.join(home, '.config', 'zed', 'settings.json'));
    expect(config).toEqual({ context_servers: { 'mintlify-index': { url: INDEX_MCP_URL } } });
    expect(result.ruleStatus).toBe('none');
  });

  it('unparseable config fails that client and leaves the file untouched', async () => {
    await fs.mkdirp(path.join(home, '.cursor'));
    await fs.writeFile(path.join(home, '.cursor', 'mcp.json'), '{ broken');
    const result = await setupClient(CLIENTS.cursor, 'global', ctx);
    expect(result.mcpStatus).toBe('failed');
    expect(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf-8')).toBe('{ broken');
    expect(result.ruleStatus).toBe('installed');
  });

  it('a non-ENOENT read error fails the client instead of overwriting the config', async () => {
    await fs.mkdirp(path.join(home, '.cursor', 'mcp.json'));
    const result = await setupClient(CLIENTS.cursor, 'global', ctx);
    expect(result.mcpStatus).toBe('failed');
    expect(await fs.pathExists(path.join(home, '.cursor', 'mcp.json'))).toBe(true);
    expect((await fs.stat(path.join(home, '.cursor', 'mcp.json'))).isDirectory()).toBe(true);
    expect(result.ruleStatus).toBe('installed');
  });
});
