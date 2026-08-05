import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const positiveInteger = z.number().int().positive();
const positiveNumber = z.number().positive().finite();

export const universalSearchRetrievalConfigSchema = z
  .object({
    engine: z.enum(['hybrid', 'bm25']),
    candidateMultiplier: positiveNumber,
    minimumCandidatePool: positiveInteger,
    relevanceGateEnabled: z.boolean().default(false),
    denseLegKillDistance: positiveNumber,
    denseResultDistance: positiveNumber,
    denseProbeKnnLimit: positiveInteger,
    denseProbeGroupLimit: positiveInteger,
    hybridKnnLimit: positiveInteger,
    hybridRrfK: positiveNumber,
    sourceBlendRrfK: positiveNumber,
    rerankTimeoutMs: positiveInteger.default(5000),
    rerankCandidateCap: positiveInteger.default(12),
    cutoffEnabled: z.boolean().default(true),
    cutoffMinRelevance: z.number().int().min(0).max(4).default(2),
    cutoffMinScore: z.number().finite().min(0).max(1).default(0.33),
    cutoffMinKeep: positiveInteger.default(3),
    routerEnabled: z.boolean().default(true),
    routerTimeoutMs: positiveInteger.default(1500),
    routerCatalogTopN: positiveInteger.default(300),
    webSearchType: z.enum(['auto', 'fast']).default('fast'),
    webLivecrawl: z.enum(['fallback', 'never']).default('never'),
  })
  .strict();

export type UniversalSearchRetrievalConfig = z.infer<typeof universalSearchRetrievalConfigSchema>;

export const PRODUCTION_UNIVERSAL_SEARCH_RETRIEVAL_CONFIG = Object.freeze({
  engine: 'bm25',
  candidateMultiplier: 3,
  minimumCandidatePool: 20,
  relevanceGateEnabled: false,
  denseLegKillDistance: 0.43,
  denseResultDistance: 0.5,
  denseProbeKnnLimit: 100,
  denseProbeGroupLimit: 60,
  hybridKnnLimit: 100,
  hybridRrfK: 60,
  sourceBlendRrfK: 60,
  rerankTimeoutMs: 5000,
  rerankCandidateCap: 12,
  cutoffEnabled: true,
  cutoffMinRelevance: 2,
  cutoffMinScore: 0.33,
  cutoffMinKeep: 3,
  routerEnabled: true,
  routerTimeoutMs: 1500,
  routerCatalogTopN: 300,
  webSearchType: 'fast',
  webLivecrawl: 'never',
} satisfies UniversalSearchRetrievalConfig);

const retrievalManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    config: universalSearchRetrievalConfigSchema.partial().strict(),
  })
  .strict();

const ENV_FIELDS = {
  engine: 'UNIVERSAL_SEARCH_RETRIEVAL_ENGINE',
  candidateMultiplier: 'UNIVERSAL_SEARCH_CANDIDATE_MULTIPLIER',
  minimumCandidatePool: 'UNIVERSAL_SEARCH_MINIMUM_CANDIDATE_POOL',
  relevanceGateEnabled: 'UNIVERSAL_SEARCH_RELEVANCE_GATE_ENABLED',
  denseLegKillDistance: 'UNIVERSAL_SEARCH_DENSE_LEG_KILL_DISTANCE',
  denseResultDistance: 'UNIVERSAL_SEARCH_DENSE_RESULT_DISTANCE',
  denseProbeKnnLimit: 'UNIVERSAL_SEARCH_DENSE_PROBE_KNN_LIMIT',
  denseProbeGroupLimit: 'UNIVERSAL_SEARCH_DENSE_PROBE_GROUP_LIMIT',
  hybridKnnLimit: 'UNIVERSAL_SEARCH_HYBRID_KNN_LIMIT',
  hybridRrfK: 'UNIVERSAL_SEARCH_HYBRID_RRF_K',
  sourceBlendRrfK: 'UNIVERSAL_SEARCH_SOURCE_BLEND_RRF_K',
  rerankTimeoutMs: 'UNIVERSAL_SEARCH_RERANK_TIMEOUT_MS',
  rerankCandidateCap: 'UNIVERSAL_SEARCH_RERANK_CANDIDATE_CAP',
  cutoffEnabled: 'UNIVERSAL_SEARCH_CUTOFF_ENABLED',
  cutoffMinRelevance: 'UNIVERSAL_SEARCH_CUTOFF_MIN_RELEVANCE',
  cutoffMinScore: 'UNIVERSAL_SEARCH_CUTOFF_MIN_SCORE',
  cutoffMinKeep: 'UNIVERSAL_SEARCH_CUTOFF_MIN_KEEP',
  routerEnabled: 'UNIVERSAL_SEARCH_ROUTER_ENABLED',
  routerTimeoutMs: 'UNIVERSAL_SEARCH_ROUTER_TIMEOUT_MS',
  routerCatalogTopN: 'UNIVERSAL_SEARCH_ROUTER_CATALOG_TOP_N',
  webSearchType: 'UNIVERSAL_SEARCH_WEB_SEARCH_TYPE',
  webLivecrawl: 'UNIVERSAL_SEARCH_WEB_LIVECRAWL',
} as const satisfies Record<keyof UniversalSearchRetrievalConfig, string>;

const BOOLEAN_FIELDS = new Set(['relevanceGateEnabled', 'cutoffEnabled', 'routerEnabled']);
const STRING_FIELDS = new Set(['engine', 'webSearchType', 'webLivecrawl']);

function loadFileOverrides(filePath: string): Partial<UniversalSearchRetrievalConfig> {
  const resolvedPath = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to load Universal Search retrieval config ${resolvedPath}.`, {
      cause: err,
    });
  }
  const manifest = retrievalManifestSchema.safeParse(raw);
  if (manifest.success) return manifest.data.config;
  const config = universalSearchRetrievalConfigSchema.partial().strict().safeParse(raw);
  if (!config.success) {
    throw new Error(
      `Invalid Universal Search retrieval config ${resolvedPath}: ${config.error.message}`
    );
  }
  return config.data;
}

function loadEnvironmentOverrides(env: NodeJS.ProcessEnv): Partial<UniversalSearchRetrievalConfig> {
  const overrides: Record<string, string | number | boolean> = {};
  for (const [field, variable] of Object.entries(ENV_FIELDS)) {
    const value = env[variable];
    if (value === undefined) continue;
    if (STRING_FIELDS.has(field)) {
      overrides[field] = value;
    } else if (BOOLEAN_FIELDS.has(field)) {
      overrides[field] = value === 'true';
    } else {
      overrides[field] = Number(value);
    }
  }
  return universalSearchRetrievalConfigSchema.partial().strict().parse(overrides);
}

export function loadUniversalSearchRetrievalConfig(
  env: NodeJS.ProcessEnv = process.env
): UniversalSearchRetrievalConfig {
  const fileOverrides = env.UNIVERSAL_SEARCH_RETRIEVAL_CONFIG_FILE
    ? loadFileOverrides(env.UNIVERSAL_SEARCH_RETRIEVAL_CONFIG_FILE)
    : {};
  return universalSearchRetrievalConfigSchema.parse({
    ...PRODUCTION_UNIVERSAL_SEARCH_RETRIEVAL_CONFIG,
    ...fileOverrides,
    ...loadEnvironmentOverrides(env),
  });
}
