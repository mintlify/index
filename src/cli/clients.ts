import fs from 'fs-extra';
import path from 'path';

import { CURSOR_RULE, RULE_BODY, VSCODE_RULE } from './rule.js';

export const INDEX_MCP_URL = 'https://index.mintlify.com/mcp';
export const SERVER_NAME = 'mintlify-index';

export type ClientName = 'claude' | 'cursor' | 'vscode' | 'codex' | 'opencode' | 'windsurf' | 'zed';

export type Scope = 'global' | 'project';

export interface SetupContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export interface RuleSpec {
  kind: 'file' | 'append';
  content: string;
  globalPath: (ctx: SetupContext) => string;
  projectPath?: (ctx: SetupContext) => string;
}

export interface ClientDefinition {
  name: ClientName;
  displayName: string;
  format: 'json' | 'toml';
  configKey: string;
  globalConfigPaths: (ctx: SetupContext) => string[];
  projectConfigPaths?: (ctx: SetupContext) => string[];
  buildEntry: () => Record<string, unknown>;
  rule?: RuleSpec;
  detectPaths: (ctx: SetupContext) => string[];
}

function claudeConfigDir(ctx: SetupContext): string {
  const override = ctx.env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override !== '' ? override : path.join(ctx.home, '.claude');
}

function claudeGlobalConfigPath(ctx: SetupContext): string {
  const override = ctx.env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override !== ''
    ? path.join(override, '.claude.json')
    : path.join(ctx.home, '.claude.json');
}

function zedUserDir(ctx: SetupContext): string {
  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA;
    const base =
      appData !== undefined && appData !== '' ? appData : path.join(ctx.home, 'AppData', 'Roaming');
    return path.join(base, 'Zed');
  }
  return path.join(ctx.home, '.config', 'zed');
}

function vscodeUserDir(ctx: SetupContext): string {
  if (ctx.platform === 'darwin') {
    return path.join(ctx.home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA;
    const base =
      appData !== undefined && appData !== '' ? appData : path.join(ctx.home, 'AppData', 'Roaming');
    return path.join(base, 'Code', 'User');
  }
  return path.join(ctx.home, '.config', 'Code', 'User');
}

export const CLIENTS: Record<ClientName, ClientDefinition> = {
  claude: {
    name: 'claude',
    displayName: 'Claude Code',
    format: 'json',
    configKey: 'mcpServers',
    globalConfigPaths: (ctx) => [claudeGlobalConfigPath(ctx)],
    projectConfigPaths: (ctx) => [path.join(ctx.cwd, '.mcp.json')],
    buildEntry: () => ({ type: 'http', url: INDEX_MCP_URL }),
    rule: {
      kind: 'file',
      content: RULE_BODY,
      globalPath: (ctx) => path.join(claudeConfigDir(ctx), 'rules', 'mintlify-index.md'),
      projectPath: (ctx) => path.join(ctx.cwd, '.claude', 'rules', 'mintlify-index.md'),
    },
    detectPaths: (ctx) => [claudeConfigDir(ctx)],
  },
  cursor: {
    name: 'cursor',
    displayName: 'Cursor',
    format: 'json',
    configKey: 'mcpServers',
    globalConfigPaths: (ctx) => [path.join(ctx.home, '.cursor', 'mcp.json')],
    projectConfigPaths: (ctx) => [path.join(ctx.cwd, '.cursor', 'mcp.json')],
    buildEntry: () => ({ url: INDEX_MCP_URL }),
    rule: {
      kind: 'file',
      content: CURSOR_RULE,
      globalPath: (ctx) => path.join(ctx.home, '.cursor', 'rules', 'mintlify-index.mdc'),
      projectPath: (ctx) => path.join(ctx.cwd, '.cursor', 'rules', 'mintlify-index.mdc'),
    },
    detectPaths: (ctx) => [path.join(ctx.home, '.cursor')],
  },
  vscode: {
    name: 'vscode',
    displayName: 'VS Code',
    format: 'json',
    configKey: 'servers',
    globalConfigPaths: (ctx) => [path.join(vscodeUserDir(ctx), 'mcp.json')],
    projectConfigPaths: (ctx) => [path.join(ctx.cwd, '.vscode', 'mcp.json')],
    buildEntry: () => ({ type: 'http', url: INDEX_MCP_URL }),
    rule: {
      kind: 'file',
      content: VSCODE_RULE,
      globalPath: (ctx) =>
        path.join(vscodeUserDir(ctx), 'prompts', 'mintlify-index.instructions.md'),
      projectPath: (ctx) =>
        path.join(ctx.cwd, '.github', 'instructions', 'mintlify-index.instructions.md'),
    },
    detectPaths: (ctx) => [vscodeUserDir(ctx)],
  },
  codex: {
    name: 'codex',
    displayName: 'Codex',
    format: 'toml',
    configKey: 'mcp_servers',
    globalConfigPaths: (ctx) => [path.join(ctx.home, '.codex', 'config.toml')],
    projectConfigPaths: (ctx) => [path.join(ctx.cwd, '.codex', 'config.toml')],
    buildEntry: () => ({ type: 'http', url: INDEX_MCP_URL }),
    rule: {
      kind: 'append',
      content: RULE_BODY,
      globalPath: (ctx) => path.join(ctx.home, '.codex', 'AGENTS.md'),
      projectPath: (ctx) => path.join(ctx.cwd, 'AGENTS.md'),
    },
    detectPaths: (ctx) => [path.join(ctx.home, '.codex')],
  },
  opencode: {
    name: 'opencode',
    displayName: 'OpenCode',
    format: 'json',
    configKey: 'mcp',
    globalConfigPaths: (ctx) => [path.join(ctx.home, '.config', 'opencode', 'opencode.json')],
    projectConfigPaths: (ctx) => [path.join(ctx.cwd, 'opencode.json')],
    buildEntry: () => ({ type: 'remote', url: INDEX_MCP_URL, enabled: true }),
    rule: {
      kind: 'append',
      content: RULE_BODY,
      globalPath: (ctx) => path.join(ctx.home, '.config', 'opencode', 'AGENTS.md'),
      projectPath: (ctx) => path.join(ctx.cwd, 'AGENTS.md'),
    },
    detectPaths: (ctx) => [path.join(ctx.home, '.config', 'opencode')],
  },
  windsurf: {
    name: 'windsurf',
    displayName: 'Windsurf',
    format: 'json',
    configKey: 'mcpServers',
    globalConfigPaths: (ctx) => [path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json')],
    buildEntry: () => ({ serverUrl: INDEX_MCP_URL }),
    rule: {
      kind: 'append',
      content: RULE_BODY,
      globalPath: (ctx) =>
        path.join(ctx.home, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
      projectPath: (ctx) => path.join(ctx.cwd, '.windsurf', 'rules', 'mintlify-index.md'),
    },
    detectPaths: (ctx) => [path.join(ctx.home, '.codeium', 'windsurf')],
  },
  zed: {
    name: 'zed',
    displayName: 'Zed',
    format: 'json',
    configKey: 'context_servers',
    globalConfigPaths: (ctx) => [path.join(zedUserDir(ctx), 'settings.json')],
    projectConfigPaths: (ctx) => [path.join(ctx.cwd, '.zed', 'settings.json')],
    buildEntry: () => ({ url: INDEX_MCP_URL }),
    detectPaths: (ctx) => [zedUserDir(ctx)],
  },
};

export const ALL_CLIENT_NAMES: ClientName[] = [
  'claude',
  'cursor',
  'vscode',
  'codex',
  'opencode',
  'windsurf',
  'zed',
];

export async function detectClients(ctx: SetupContext): Promise<ClientName[]> {
  const detected: ClientName[] = [];
  for (const name of ALL_CLIENT_NAMES) {
    for (const candidate of CLIENTS[name].detectPaths(ctx)) {
      if (await fs.pathExists(candidate)) {
        detected.push(name);
        break;
      }
    }
  }
  return detected;
}
