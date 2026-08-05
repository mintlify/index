import express from 'express';

import { ChromaRepository } from './internal/chromaRepository.js';
import { ExaService } from './internal/exaService.js';
import { UniversalSearchManifestRepository } from './internal/manifestRepository.js';
import { SearchService } from './internal/searchService.js';
import { UniversalSearchMcpController } from './mcp/mcpController.js';
import { createUniversalSearchMcpRouter } from './mcp/mcpRouter.js';
import UniversalSearchService from './retrieval/engine.js';
import { HostedUniversalSearchReranker } from './retrieval/reranker.js';
import { loadUniversalSearchRetrievalConfig } from './retrieval/retrievalConfig.js';
import { ExaWebSearchProvider } from './retrieval/webSearchProvider.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function notImplemented(method: string): never {
  throw new Error(`${method} is backed by the Mintlify platform and is not implemented here.`);
}

const chromaRepository: ChromaRepository = {
  getCollectionByName: () => notImplemented('getCollectionByName'),
  embedDenseQuery: () => notImplemented('embedDenseQuery'),
  get: () => notImplemented('get'),
  getAllRecords: () => notImplemented('getAllRecords'),
  search: () => notImplemented('search'),
};

const manifestRepository: UniversalSearchManifestRepository = {
  getActiveManifest: () => notImplemented('getActiveManifest'),
  getSyncedSiteSubdomains: () => notImplemented('getSyncedSiteSubdomains'),
  getSubdomainsByDomains: () => notImplemented('getSubdomainsByDomains'),
  getSyncedSiteHosts: () => notImplemented('getSyncedSiteHosts'),
};

const searchService: SearchService = {
  search: () => notImplemented('search'),
};

const retrievalConfig = loadUniversalSearchRetrievalConfig();

const reranker = new HostedUniversalSearchReranker({
  apiKey: requireEnv('VOYAGE_API_KEY'),
  endpoint: 'https://api.voyageai.com/v1/rerank',
  model: 'rerank-2.5-lite',
  timeoutMs: retrievalConfig.rerankTimeoutMs,
  candidateCap: retrievalConfig.rerankCandidateCap,
});

const webSearchProvider = new ExaWebSearchProvider(new ExaService());

const universalSearchService = new UniversalSearchService(
  searchService,
  webSearchProvider,
  manifestRepository,
  chromaRepository,
  retrievalConfig,
  reranker
);

const mcpController = new UniversalSearchMcpController(universalSearchService);

const app = express();
app.use(express.json());
app.use('/mcp', createUniversalSearchMcpRouter(mcpController));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.info(`Universal Search MCP server listening on port ${port}`);
});
