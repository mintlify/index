import { describe, expect, it } from 'vitest';

import { resolveExplicitClients } from '../../src/cli/setup.js';

describe('resolveExplicitClients', () => {
  it('returns empty for no flags', () => {
    expect(resolveExplicitClients({})).toEqual([]);
  });

  it('returns flagged clients in registry order', () => {
    expect(resolveExplicitClients({ zed: true, claude: true, vscode: true })).toEqual([
      'claude',
      'vscode',
      'zed',
    ]);
  });

  it('ignores scope and confirmation flags', () => {
    expect(resolveExplicitClients({ project: true, yes: true })).toEqual([]);
  });
});
