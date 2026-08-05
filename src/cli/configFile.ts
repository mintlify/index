import fs from 'fs-extra';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import path from 'path';

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function readJsonConfig(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isEnoent(error)) {
      return {};
    }
    throw error;
  }
  if (raw.trim() === '') {
    return {};
  }
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`invalid JSON at ${filePath}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object at ${filePath}`);
  }
  return parsed;
}

export function mergeServerEntry(
  config: Record<string, unknown>,
  configKey: string,
  serverName: string,
  entry: Record<string, unknown>
): { config: Record<string, unknown>; alreadyExists: boolean } {
  const section = config[configKey];
  const servers: Record<string, unknown> = {};
  if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
    Object.assign(servers, section);
  }
  const alreadyExists = serverName in servers;
  servers[serverName] = entry;
  return { config: { ...config, [configKey]: servers }, alreadyExists };
}

export async function writeJsonConfig(
  filePath: string,
  config: Record<string, unknown>
): Promise<void> {
  await fs.mkdirp(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function writeJsonServerEntry(
  filePath: string,
  configKey: string,
  serverName: string,
  entry: Record<string, unknown>
): Promise<{ status: 'configured' | 'reconfigured' }> {
  let raw: string | undefined;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
  if (raw === undefined || raw.trim() === '') {
    const { config } = mergeServerEntry({}, configKey, serverName, entry);
    await writeJsonConfig(filePath, config);
    return { status: 'configured' };
  }
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`unable to parse existing config at ${filePath}`);
  }
  const section = parsed[configKey];
  const sectionIsObject =
    typeof section === 'object' && section !== null && !Array.isArray(section);
  const alreadyExists = sectionIsObject && serverName in section;
  const edits = sectionIsObject
    ? modify(raw, [configKey, serverName], entry, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    : modify(
        raw,
        [configKey],
        { [serverName]: entry },
        {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }
      );
  await fs.mkdirp(path.dirname(filePath));
  await fs.writeFile(filePath, applyEdits(raw, edits));
  return { status: alreadyExists ? 'reconfigured' : 'configured' };
}

export async function resolveConfigPath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }
  const fallback = candidates[0];
  if (fallback === undefined) {
    throw new Error('no config path candidates');
  }
  return fallback;
}

export function upsertTomlServer(
  content: string,
  serverName: string,
  entry: Record<string, string>
): { content: string; alreadyExists: boolean } {
  const header = `[mcp_servers.${serverName}]`;
  const escapedName = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerPattern = new RegExp(
    `^[ \\t]*\\[mcp_servers\\.${escapedName}\\][ \\t]*(?:#.*)?$`,
    'm'
  );
  const lines = Object.entries(entry).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  const block = `${[header, ...lines].join('\n')}\n`;
  const match = headerPattern.exec(content);
  if (match === null) {
    const separator = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return { content: `${content}${separator}${block}`, alreadyExists: false };
  }
  const headerIndex = match.index + match[0].indexOf('[');
  const rest = content.slice(headerIndex + header.length);
  const nextTable = rest.search(/\n\s*\[/);
  const end = nextTable === -1 ? content.length : headerIndex + header.length + nextTable + 1;
  const before = content.slice(0, headerIndex);
  const after = content.slice(end).replace(/^\n+/, '\n');
  return { content: `${before}${block}${after}`, alreadyExists: true };
}
