import fs from 'fs-extra';
import path from 'path';

export const RULE_MARKER = '<!-- mintlify-index -->';

export const RULE_BODY = `Use the Mintlify index \`context\` tool whenever you research how to use a library, framework, SDK, API, or CLI tool, including syntax, configuration, migration, and setup questions. Use it even for well-known libraries, since training data may be stale, and prefer it over web search for developer documentation. Do not use it for general programming concepts or for debugging business logic.
`;

export const CURSOR_RULE = `---
alwaysApply: true
---

${RULE_BODY}`;

export const VSCODE_RULE = `---
applyTo: '**'
---

${RULE_BODY}`;

export async function writeRuleFile(
  filePath: string,
  content: string
): Promise<'installed' | 'updated'> {
  const exists = await fs.pathExists(filePath);
  await fs.mkdirp(path.dirname(filePath));
  await fs.writeFile(filePath, content);
  return exists ? 'updated' : 'installed';
}

export async function appendRuleSection(
  filePath: string,
  content: string
): Promise<'installed' | 'updated'> {
  const section = `${RULE_MARKER}\n${content}${RULE_MARKER}`;
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error;
    }
  }
  const escaped = RULE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\n[\\s\\S]*?${escaped}`);
  if (pattern.test(existing)) {
    await fs.writeFile(filePath, existing.replace(pattern, section));
    return 'updated';
  }
  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  await fs.mkdirp(path.dirname(filePath));
  await fs.writeFile(filePath, `${existing}${separator}${section}\n`);
  return 'installed';
}
