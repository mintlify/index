import type { Argv } from 'yargs';

import { runIndexSetup } from './setup.js';

export interface IndexCommandArgv {
  claude?: boolean;
  cursor?: boolean;
  vscode?: boolean;
  codex?: boolean;
  opencode?: boolean;
  windsurf?: boolean;
  zed?: boolean;
  project?: boolean;
  yes?: boolean;
}

export function registerIndexCommand<T>(yargs: Argv<T>): Argv<T> {
  return yargs.command(
    'index',
    'Install the Mintlify index MCP server into your coding agents',
    (yargs) =>
      yargs
        .option('claude', { type: 'boolean', description: 'Set up Claude Code' })
        .option('cursor', { type: 'boolean', description: 'Set up Cursor' })
        .option('vscode', { type: 'boolean', description: 'Set up VS Code' })
        .option('codex', { type: 'boolean', description: 'Set up Codex' })
        .option('opencode', { type: 'boolean', description: 'Set up OpenCode' })
        .option('windsurf', { type: 'boolean', description: 'Set up Windsurf' })
        .option('zed', { type: 'boolean', description: 'Set up Zed' })
        .option('project', {
          type: 'boolean',
          description: 'Write project-level config instead of global',
        })
        .option('yes', {
          alias: 'y',
          type: 'boolean',
          description: 'Skip prompts and set up all detected agents',
        })
        .usage('usage: mintlify index [options]')
        .example('mintlify index', 'interactive picker')
        .example('mintlify index --claude --cursor', 'set up specific agents'),
    async (argv: IndexCommandArgv) => {
      const code = await runIndexSetup(argv);
      process.exit(code);
    }
  );
}
