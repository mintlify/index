import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Request, Response } from 'express';
import { z } from 'zod';

import UniversalSearchService from '../retrieval/engine.js';
import { runUniversalSearchContext } from '../retrieval/operations.js';
import type { UniversalSearchOperationResult } from '../retrieval/operations.js';
import type { UniversalSearchContextResponse } from '../api/types.js';
import { getLogger } from '../internal/logger.js';
import {
  UNIVERSAL_SEARCH_CONTEXT_DEFAULT_TOKEN_BUDGET,
  UNIVERSAL_SEARCH_CONTEXT_MAX_TOKEN_BUDGET,
  universalSearchContextBodySchema,
} from '../api/validator.js';

const MCP_SERVER_INFO = {
  name: 'mintlify-universal-search',
  version: '1.0.0',
};

const MCP_SERVER_INSTRUCTIONS =
  'Research implementation questions across primary developer documentation and the web. The context tool returns a compact cited answer in one call.';

const nonEmptyString = z.string().trim().min(1);
const contextInputSchema = {
  query: nonEmptyString.describe('Implementation question to research.'),
  product: nonEmptyString
    .optional()
    .describe('Optional product or company name used to focus retrieval.'),
  includeDomains: z.array(nonEmptyString).min(1).optional(),
  excludeDomains: z.array(nonEmptyString).min(1).optional(),
  tokenBudget: z
    .number()
    .int()
    .positive()
    .max(UNIVERSAL_SEARCH_CONTEXT_MAX_TOKEN_BUDGET)
    .default(UNIVERSAL_SEARCH_CONTEXT_DEFAULT_TOKEN_BUDGET)
    .describe(
      'Maximum response tokens. Use the 3000 default for focused questions and up to 6000 for complex multi-part implementation tasks.'
    ),
};

function textContent(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

export class UniversalSearchMcpController {
  constructor(private readonly universalSearchService: UniversalSearchService) {}

  async handleRequest(req: Request, res: Response) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({
        error: {
          code: 'method_not_allowed',
          message: 'Stateless MCP server only accepts POST requests',
        },
      });
    }

    if (Array.isArray(req.body)) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'JSON-RPC batching is not supported. Send one request per POST.',
        },
      });
    }

    const server = this.buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.once('close', () => {
      transport
        .close()
        .catch((err) => getLogger().error(err, 'Universal Search MCP transport close failed'));
      server
        .close()
        .catch((err) => getLogger().error(err, 'Universal Search MCP server close failed'));
    });

    try {
      await server.connect(transport);
      res.setHeader('Content-Type', 'application/json');
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      getLogger().error(err, 'Universal Search MCP protocol request failed');
      if (!res.headersSent) {
        res.status(500).json({
          error: { code: 'internal_error', message: 'Internal error' },
        });
      }
    }
  }

  private buildServer(): McpServer {
    const server = new McpServer(MCP_SERVER_INFO, { instructions: MCP_SERVER_INSTRUCTIONS });

    server.registerTool(
      'context',
      {
        description:
          'Research an implementation task and return a compact answer with primary-source citations.',
        inputSchema: contextInputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => {
        return this.invokeTool(() =>
          runUniversalSearchContext(
            this.universalSearchService,
            universalSearchContextBodySchema.parse({ ...args, format: 'txt' })
          )
        );
      }
    );

    return server;
  }

  private async invokeTool(
    operation: () => Promise<UniversalSearchOperationResult<UniversalSearchContextResponse>>
  ) {
    try {
      const result = await operation();
      return { content: [textContent(result.response.response)] };
    } catch (err) {
      getLogger().error({ err, tool: 'context' }, 'Universal Search MCP tool failed');
      const detail = err instanceof Error ? err.message : 'unknown error';
      const isError = true;
      return {
        isError,
        content: [textContent(`Universal Search context failed: ${detail}`)],
      };
    }
  }
}
