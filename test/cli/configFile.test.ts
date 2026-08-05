import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  mergeServerEntry,
  readJsonConfig,
  resolveConfigPath,
  writeJsonConfig,
  writeJsonServerEntry,
} from '../../src/cli/configFile.js';

describe('configFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mint-index-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  it('readJsonConfig returns empty object for missing file', async () => {
    expect(await readJsonConfig(path.join(dir, 'missing.json'))).toEqual({});
  });

  it('readJsonConfig returns empty object for empty file', async () => {
    const file = path.join(dir, 'empty.json');
    await fs.writeFile(file, '  \n');
    expect(await readJsonConfig(file)).toEqual({});
  });

  it('readJsonConfig parses existing config', async () => {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ mcpServers: { other: { url: 'x' } } }));
    expect(await readJsonConfig(file)).toEqual({ mcpServers: { other: { url: 'x' } } });
  });

  it('readJsonConfig throws on invalid JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{ not json');
    await expect(readJsonConfig(file)).rejects.toThrow();
  });

  it('readJsonConfig throws on non-object root', async () => {
    const file = path.join(dir, 'array.json');
    await fs.writeFile(file, '[1, 2]');
    await expect(readJsonConfig(file)).rejects.toThrow();
  });

  it('mergeServerEntry adds entry to empty config', () => {
    const { config, alreadyExists } = mergeServerEntry({}, 'mcpServers', 'mintlify-index', {
      url: 'https://index.mintlify.com/mcp',
    });
    expect(alreadyExists).toBe(false);
    expect(config).toEqual({
      mcpServers: { 'mintlify-index': { url: 'https://index.mintlify.com/mcp' } },
    });
  });

  it('mergeServerEntry preserves sibling servers and unrelated keys', () => {
    const existing = {
      theme: 'dark',
      mcpServers: { other: { url: 'x' } },
    };
    const { config, alreadyExists } = mergeServerEntry(existing, 'mcpServers', 'mintlify-index', {
      url: 'y',
    });
    expect(alreadyExists).toBe(false);
    expect(config).toEqual({
      theme: 'dark',
      mcpServers: { other: { url: 'x' }, 'mintlify-index': { url: 'y' } },
    });
  });

  it('mergeServerEntry replaces existing entry and reports alreadyExists', () => {
    const existing = { mcpServers: { 'mintlify-index': { url: 'old' } } };
    const { config, alreadyExists } = mergeServerEntry(existing, 'mcpServers', 'mintlify-index', {
      url: 'new',
    });
    expect(alreadyExists).toBe(true);
    expect(config).toEqual({ mcpServers: { 'mintlify-index': { url: 'new' } } });
  });

  it('mergeServerEntry recovers when config key holds a non-object', () => {
    const { config } = mergeServerEntry({ mcpServers: 'oops' }, 'mcpServers', 'mintlify-index', {
      url: 'y',
    });
    expect(config).toEqual({ mcpServers: { 'mintlify-index': { url: 'y' } } });
  });

  it('writeJsonConfig creates parent dirs and ends with newline', async () => {
    const file = path.join(dir, 'nested', 'deep', 'config.json');
    await writeJsonConfig(file, { a: 1 });
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toBe('{\n  "a": 1\n}\n');
  });

  it('resolveConfigPath returns first existing candidate', async () => {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    await fs.writeFile(b, '{}');
    expect(await resolveConfigPath([a, b])).toBe(b);
  });

  it('resolveConfigPath falls back to first candidate when none exist', async () => {
    const a = path.join(dir, 'a.json');
    expect(await resolveConfigPath([a, path.join(dir, 'b.json')])).toBe(a);
  });

  it('writeJsonServerEntry creates a fresh file when missing', async () => {
    const file = path.join(dir, 'missing.json');
    const { status } = await writeJsonServerEntry(file, 'mcpServers', 'mintlify-index', {
      url: 'x',
    });
    expect(status).toBe('configured');
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toBe(
      '{\n  "mcpServers": {\n    "mintlify-index": {\n      "url": "x"\n    }\n  }\n}\n'
    );
  });

  it('writeJsonServerEntry preserves comments and trailing commas in JSONC', async () => {
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, '// top comment\n{\n  "theme": "dark", // inline comment\n}\n');
    const { status } = await writeJsonServerEntry(file, 'context_servers', 'mintlify-index', {
      url: 'x',
    });
    expect(status).toBe('configured');
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toContain('// top comment');
    expect(raw).toContain('// inline comment');
    expect(raw).toContain('"theme": "dark"');
    const parsed = await readJsonConfig(file);
    expect(parsed).toMatchObject({
      theme: 'dark',
      context_servers: { 'mintlify-index': { url: 'x' } },
    });
  });

  it('writeJsonServerEntry reports reconfigured on rerun', async () => {
    const file = path.join(dir, 'settings.json');
    await writeJsonServerEntry(file, 'mcpServers', 'mintlify-index', { url: 'x' });
    const second = await writeJsonServerEntry(file, 'mcpServers', 'mintlify-index', { url: 'y' });
    expect(second.status).toBe('reconfigured');
  });

  it('writeJsonServerEntry recovers when the config key holds a non-object value', async () => {
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, '// comment\n{\n  "mcpServers": "oops",\n}\n');
    const { status } = await writeJsonServerEntry(file, 'mcpServers', 'mintlify-index', {
      url: 'x',
    });
    expect(status).toBe('configured');
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toContain('// comment');
    const parsed = await readJsonConfig(file);
    expect(parsed).toEqual({ mcpServers: { 'mintlify-index': { url: 'x' } } });
  });

  it('writeJsonServerEntry fails without touching the file on invalid JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{ not json');
    await expect(
      writeJsonServerEntry(file, 'mcpServers', 'mintlify-index', { url: 'x' })
    ).rejects.toThrow();
    expect(await fs.readFile(file, 'utf-8')).toBe('{ not json');
  });
});
