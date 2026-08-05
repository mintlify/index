import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendRuleSection,
  CURSOR_RULE,
  RULE_BODY,
  RULE_MARKER,
  VSCODE_RULE,
  writeRuleFile,
} from '../../src/cli/rule.js';

describe('rule', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mint-index-rule-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  it('frontmatter variants wrap the shared body', () => {
    expect(CURSOR_RULE).toContain('alwaysApply: true');
    expect(CURSOR_RULE).toContain(RULE_BODY);
    expect(VSCODE_RULE).toContain("applyTo: '**'");
    expect(VSCODE_RULE).toContain(RULE_BODY);
  });

  it('writeRuleFile creates dirs and reports installed then updated', async () => {
    const file = path.join(dir, 'rules', 'mintlify-index.md');
    expect(await writeRuleFile(file, RULE_BODY)).toBe('installed');
    expect(await writeRuleFile(file, RULE_BODY)).toBe('updated');
    expect(await fs.readFile(file, 'utf-8')).toBe(RULE_BODY);
  });

  it('appendRuleSection appends to a fresh file with markers', async () => {
    const file = path.join(dir, 'AGENTS.md');
    expect(await appendRuleSection(file, RULE_BODY)).toBe('installed');
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw.startsWith(RULE_MARKER)).toBe(true);
    expect(raw).toContain(RULE_BODY);
    expect(raw.trimEnd().endsWith(RULE_MARKER)).toBe(true);
  });

  it('appendRuleSection preserves existing user content', async () => {
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, '# My rules\n\nBe nice.\n');
    await appendRuleSection(file, RULE_BODY);
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw.startsWith('# My rules\n\nBe nice.\n')).toBe(true);
    expect(raw).toContain(RULE_MARKER);
  });

  it('appendRuleSection replaces its own section on rerun', async () => {
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, `before\n${RULE_MARKER}\nstale content\n${RULE_MARKER}\nafter\n`);
    expect(await appendRuleSection(file, RULE_BODY)).toBe('updated');
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).not.toContain('stale content');
    expect(raw).toContain(RULE_BODY);
    expect(raw.startsWith('before\n')).toBe(true);
    expect(raw.trimEnd().endsWith('after')).toBe(true);
  });

  it('appendRuleSection appends a full section when only a stray marker exists', async () => {
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, `before\n${RULE_MARKER}\nafter\n`);
    expect(await appendRuleSection(file, RULE_BODY)).toBe('installed');
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toContain(`before\n${RULE_MARKER}\nafter\n`);
    expect(raw).toContain(RULE_BODY);
    const markerCount = raw.split(RULE_MARKER).length - 1;
    expect(markerCount).toBe(3);
  });

  it('appendRuleSection is idempotent', async () => {
    const file = path.join(dir, 'AGENTS.md');
    await appendRuleSection(file, RULE_BODY);
    const first = await fs.readFile(file, 'utf-8');
    await appendRuleSection(file, RULE_BODY);
    expect(await fs.readFile(file, 'utf-8')).toBe(first);
  });
});
