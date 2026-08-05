import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadUniversalSearchRetrievalConfig,
  PRODUCTION_UNIVERSAL_SEARCH_RETRIEVAL_CONFIG,
} from '../../src/retrieval/retrievalConfig.js';

describe('Universal Search retrieval configuration', () => {
  it('preserves the production retrieval values', () => {
    expect(loadUniversalSearchRetrievalConfig({})).toEqual(
      PRODUCTION_UNIVERSAL_SEARCH_RETRIEVAL_CONFIG
    );
    expect(
      loadUniversalSearchRetrievalConfig({
        UNIVERSAL_SEARCH_RETRIEVAL_CONFIG_FILE: path.resolve(
          'evals/universal-search/configs/production.json'
        ),
      })
    ).toEqual({ ...PRODUCTION_UNIVERSAL_SEARCH_RETRIEVAL_CONFIG, engine: 'hybrid' });
  });

  it('applies production defaults for the reranking and cutoff fields', () => {
    expect(loadUniversalSearchRetrievalConfig({})).toMatchObject({
      engine: 'bm25',
      relevanceGateEnabled: false,
      rerankTimeoutMs: 5000,
      cutoffEnabled: true,
      cutoffMinRelevance: 2,
      cutoffMinScore: 0.33,
      cutoffMinKeep: 3,
      routerEnabled: true,
      routerTimeoutMs: 1500,
      routerCatalogTopN: 300,
      webSearchType: 'fast',
      webLivecrawl: 'never',
    });
  });

  it('overrides the reranking and cutoff fields via environment variables', () => {
    const config = loadUniversalSearchRetrievalConfig({
      UNIVERSAL_SEARCH_RELEVANCE_GATE_ENABLED: 'true',
      UNIVERSAL_SEARCH_RERANK_TIMEOUT_MS: '2500',
      UNIVERSAL_SEARCH_CUTOFF_ENABLED: 'false',
      UNIVERSAL_SEARCH_CUTOFF_MIN_RELEVANCE: '3',
      UNIVERSAL_SEARCH_CUTOFF_MIN_SCORE: '0.5',
      UNIVERSAL_SEARCH_CUTOFF_MIN_KEEP: '5',
      UNIVERSAL_SEARCH_ROUTER_ENABLED: 'false',
      UNIVERSAL_SEARCH_ROUTER_TIMEOUT_MS: '4000',
      UNIVERSAL_SEARCH_ROUTER_CATALOG_TOP_N: '150',
      UNIVERSAL_SEARCH_WEB_SEARCH_TYPE: 'auto',
      UNIVERSAL_SEARCH_WEB_LIVECRAWL: 'fallback',
    });

    expect(config).toMatchObject({
      relevanceGateEnabled: true,
      rerankTimeoutMs: 2500,
      cutoffEnabled: false,
      cutoffMinRelevance: 3,
      cutoffMinScore: 0.5,
      cutoffMinKeep: 5,
      routerEnabled: false,
      routerTimeoutMs: 4000,
      routerCatalogTopN: 150,
      webSearchType: 'auto',
      webLivecrawl: 'fallback',
    });
  });

  it('loads a manifest file and applies environment overrides last', () => {
    const config = loadUniversalSearchRetrievalConfig({
      UNIVERSAL_SEARCH_RETRIEVAL_CONFIG_FILE: path.resolve(
        'evals/universal-search/configs/production.json'
      ),
      UNIVERSAL_SEARCH_MINIMUM_CANDIDATE_POOL: '48',
      UNIVERSAL_SEARCH_HYBRID_RRF_K: '75',
    });

    expect(config).toMatchObject({
      candidateMultiplier: 3,
      minimumCandidatePool: 48,
      hybridRrfK: 75,
    });
  });

  it('rejects invalid environment overrides', () => {
    expect(() =>
      loadUniversalSearchRetrievalConfig({ UNIVERSAL_SEARCH_DENSE_PROBE_KNN_LIMIT: 'many' })
    ).toThrow();
  });

  it('rejects an invalid web search type override', () => {
    expect(() =>
      loadUniversalSearchRetrievalConfig({ UNIVERSAL_SEARCH_WEB_SEARCH_TYPE: 'slow' })
    ).toThrow();
  });

  it('rejects a non-positive router catalog top-N override', () => {
    expect(() =>
      loadUniversalSearchRetrievalConfig({ UNIVERSAL_SEARCH_ROUTER_CATALOG_TOP_N: '0' })
    ).toThrow();
  });
});
