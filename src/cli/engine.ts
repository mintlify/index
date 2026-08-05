import fs from 'fs-extra';
import path from 'path';

import {
  SERVER_NAME,
  type ClientDefinition,
  type ClientName,
  type Scope,
  type SetupContext,
} from './clients.js';
import { resolveConfigPath, upsertTomlServer, writeJsonServerEntry } from './configFile.js';
import { appendRuleSection, writeRuleFile } from './rule.js';

export interface ClientSetupResult {
  client: ClientName;
  displayName: string;
  mcpStatus: 'configured' | 'reconfigured' | 'failed';
  mcpDetail: string;
  ruleStatus: 'installed' | 'updated' | 'failed' | 'none';
  ruleDetail: string;
}

async function writeMcpEntry(
  definition: ClientDefinition,
  scope: Scope,
  ctx: SetupContext
): Promise<{ status: 'configured' | 'reconfigured'; configPath: string }> {
  const projectPaths = definition.projectConfigPaths?.(ctx) ?? [];
  const candidates =
    scope === 'project' && projectPaths.length > 0
      ? projectPaths
      : definition.globalConfigPaths(ctx);
  const configPath = await resolveConfigPath(candidates);
  if (definition.format === 'toml') {
    let existing = '';
    try {
      existing = await fs.readFile(configPath, 'utf-8');
    } catch (error) {
      if (
        !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
    const entry: Record<string, string> = {};
    for (const [key, value] of Object.entries(definition.buildEntry())) {
      if (typeof value === 'string') {
        entry[key] = value;
      }
    }
    const { content, alreadyExists } = upsertTomlServer(existing, SERVER_NAME, entry);
    await fs.mkdirp(path.dirname(configPath));
    await fs.writeFile(configPath, content);
    return { status: alreadyExists ? 'reconfigured' : 'configured', configPath };
  }
  const { status } = await writeJsonServerEntry(
    configPath,
    definition.configKey,
    SERVER_NAME,
    definition.buildEntry()
  );
  return { status, configPath };
}

async function writeRule(
  definition: ClientDefinition,
  scope: Scope,
  ctx: SetupContext
): Promise<{ status: 'installed' | 'updated' | 'none'; rulePath: string }> {
  const rule = definition.rule;
  if (rule === undefined) {
    return { status: 'none', rulePath: '' };
  }
  const projectPath = rule.projectPath?.(ctx);
  const rulePath =
    scope === 'project' && projectPath !== undefined ? projectPath : rule.globalPath(ctx);
  const status =
    rule.kind === 'file'
      ? await writeRuleFile(rulePath, rule.content)
      : await appendRuleSection(rulePath, rule.content);
  return { status, rulePath };
}

export async function setupClient(
  definition: ClientDefinition,
  scope: Scope,
  ctx: SetupContext
): Promise<ClientSetupResult> {
  const result: ClientSetupResult = {
    client: definition.name,
    displayName: definition.displayName,
    mcpStatus: 'failed',
    mcpDetail: '',
    ruleStatus: 'none',
    ruleDetail: '',
  };
  try {
    const { status, configPath } = await writeMcpEntry(definition, scope, ctx);
    result.mcpStatus = status;
    result.mcpDetail = configPath;
  } catch (error) {
    result.mcpDetail = error instanceof Error ? error.message : String(error);
  }
  try {
    const { status, rulePath } = await writeRule(definition, scope, ctx);
    result.ruleStatus = status;
    result.ruleDetail = rulePath;
  } catch (error) {
    result.ruleStatus = 'failed';
    result.ruleDetail = error instanceof Error ? error.message : String(error);
  }
  return result;
}
