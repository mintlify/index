import { describe, expect, it } from 'vitest';

import { upsertTomlServer } from '../../src/cli/configFile.js';

describe('upsertTomlServer', () => {
  const entry = { type: 'http', url: 'https://index.mintlify.com/mcp' };
  const block =
    '[mcp_servers.mintlify-index]\ntype = "http"\nurl = "https://index.mintlify.com/mcp"\n';

  it('appends to empty content', () => {
    const result = upsertTomlServer('', 'mintlify-index', entry);
    expect(result.alreadyExists).toBe(false);
    expect(result.content).toBe(block);
  });

  it('appends after existing content with a blank line', () => {
    const existing = 'model = "o3"\n';
    const result = upsertTomlServer(existing, 'mintlify-index', entry);
    expect(result.alreadyExists).toBe(false);
    expect(result.content).toBe(`model = "o3"\n\n${block}`);
  });

  it('replaces an existing table without touching neighbors', () => {
    const existing = `model = "o3"\n\n[mcp_servers.mintlify-index]\nurl = "old"\n\n[mcp_servers.other]\ncommand = "npx"\n`;
    const result = upsertTomlServer(existing, 'mintlify-index', entry);
    expect(result.alreadyExists).toBe(true);
    expect(result.content).toContain(block);
    expect(result.content).toContain('[mcp_servers.other]\ncommand = "npx"');
    expect(result.content).not.toContain('url = "old"');
  });

  it('replaces a table that sits at the end of the file', () => {
    const existing = `model = "o3"\n\n[mcp_servers.mintlify-index]\nurl = "old"\n`;
    const result = upsertTomlServer(existing, 'mintlify-index', entry);
    expect(result.alreadyExists).toBe(true);
    expect(result.content).toBe(`model = "o3"\n\n${block}`);
  });

  it('ignores a header that appears inside a comment', () => {
    const existing = `# [mcp_servers.mintlify-index]\nmodel = "o3"\n\n[mcp_servers.mintlify-index]\nurl = "old"\n\n[mcp_servers.other]\ncommand = "npx"\n`;
    const result = upsertTomlServer(existing, 'mintlify-index', entry);
    expect(result.alreadyExists).toBe(true);
    expect(result.content).toContain('# [mcp_servers.mintlify-index]');
    expect(result.content).toContain(block);
    expect(result.content).toContain('[mcp_servers.other]\ncommand = "npx"');
    expect(result.content).not.toContain('url = "old"');
  });

  it('replaces an indented header without corrupting the split', () => {
    const existing = `model = "o3"\n\n  [mcp_servers.mintlify-index]\n  url = "old"\n\n[mcp_servers.other]\ncommand = "npx"\n`;
    const result = upsertTomlServer(existing, 'mintlify-index', entry);
    expect(result.alreadyExists).toBe(true);
    expect(result.content).toContain(block);
    expect(result.content).toContain('[mcp_servers.other]\ncommand = "npx"');
    expect(result.content).not.toContain('url = "old"');
  });

  it('replaces a table whose header line carries a trailing comment', () => {
    const existing = `model = "o3"\n\n[mcp_servers.mintlify-index] # managed by mint\nurl = "old"\n\n[mcp_servers.other]\ncommand = "npx"\n`;
    const result = upsertTomlServer(existing, 'mintlify-index', entry);
    expect(result.alreadyExists).toBe(true);
    expect(result.content).toContain(block);
    expect(result.content).toContain('[mcp_servers.other]\ncommand = "npx"');
    expect(result.content).not.toContain('url = "old"');
    const occurrences = result.content.split('[mcp_servers.mintlify-index]').length - 1;
    expect(occurrences).toBe(1);
  });

  it('is idempotent across reruns', () => {
    const once = upsertTomlServer('', 'mintlify-index', entry);
    const twice = upsertTomlServer(once.content, 'mintlify-index', entry);
    expect(twice.content).toBe(once.content);
    expect(twice.alreadyExists).toBe(true);
  });
});
