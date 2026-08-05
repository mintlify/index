import { checkbox } from '@inquirer/prompts';
import { addLog, ErrorLog, WarningLog } from '@mintlify/previewing';
import { Text } from 'ink';
import os from 'os';
import React from 'react';

import {
  ALL_CLIENT_NAMES,
  CLIENTS,
  detectClients,
  type ClientName,
  type Scope,
  type SetupContext,
} from './clients.js';
import { setupClient, type ClientSetupResult } from './engine.js';

export interface IndexSetupOptions extends Partial<Record<ClientName, boolean>> {
  project?: boolean;
  yes?: boolean;
}

export function resolveExplicitClients(options: IndexSetupOptions): ClientName[] {
  return ALL_CLIENT_NAMES.filter((name) => options[name] === true);
}

async function promptClients(detected: ClientName[]): Promise<ClientName[] | undefined> {
  try {
    return await checkbox({
      message: 'Which coding agents do you want to set up?',
      loop: false,
      choices: ALL_CLIENT_NAMES.map((name) => ({
        name: CLIENTS[name].displayName,
        value: name,
        checked: detected.includes(name),
      })),
    });
  } catch {
    return undefined;
  }
}

function logResult(result: ClientSetupResult): void {
  addLog(<Text bold>{result.displayName}</Text>);
  if (result.mcpStatus === 'failed') {
    addLog(<ErrorLog message={`  MCP server failed: ${result.mcpDetail}`} />);
  } else {
    addLog(
      <Text>
        {'  '}MCP server {result.mcpStatus} <Text dimColor>{result.mcpDetail}</Text>
      </Text>
    );
  }
  if (result.ruleStatus === 'failed') {
    addLog(<ErrorLog message={`  Rule failed: ${result.ruleDetail}`} />);
  } else if (result.ruleStatus !== 'none') {
    addLog(
      <Text>
        {'  '}Rule {result.ruleStatus} <Text dimColor>{result.ruleDetail}</Text>
      </Text>
    );
  }
}

export async function runIndexSetup(options: IndexSetupOptions): Promise<number> {
  const ctx: SetupContext = {
    home: os.homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
  };
  const scope: Scope = options.project === true ? 'project' : 'global';
  let selected = resolveExplicitClients(options);
  if (selected.length === 0) {
    const detected = await detectClients(ctx);
    if (options.yes === true) {
      if (detected.length === 0) {
        addLog(
          <ErrorLog message="no coding agents detected; pass flags like --claude or --cursor" />
        );
        return 1;
      }
      selected = detected;
    } else {
      const picked = await promptClients(detected);
      if (picked === undefined || picked.length === 0) {
        addLog(<WarningLog message="setup cancelled" />);
        return 1;
      }
      selected = picked;
    }
  }
  const results: ClientSetupResult[] = [];
  for (const name of selected) {
    results.push(await setupClient(CLIENTS[name], scope, ctx));
  }
  for (const result of results) {
    logResult(result);
  }
  const succeeded = results.filter((result) => result.mcpStatus !== 'failed');
  addLog(
    <Text>
      Mintlify index MCP set up for {succeeded.length}/{results.length} agents
    </Text>
  );
  return succeeded.length > 0 ? 0 : 1;
}
