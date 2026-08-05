import { generateObject, type LanguageModelV1 } from 'ai';
import { z } from 'zod';

import { getDomainName } from '../internal/getDomainName.js';
import { isMintlifyAppHost } from '../internal/mintlifyAppDomain.js';

export type UniversalSearchRouteDecision = {
  leg: 'mintlify' | 'web';
  confidence: number;
  matchedSite?: string;
  shortcut?: boolean;
};

export type UniversalSearchRoutePlan = {
  decision: Promise<UniversalSearchRouteDecision>;
  matchedSubdomains: string[];
};

export interface UniversalSearchRouter {
  plan(query: string, collectionName: string | null): Promise<UniversalSearchRoutePlan>;
  route(query: string, collectionName: string | null): Promise<UniversalSearchRouteDecision>;
  matchSubdomains?(query: string, collectionName: string | null): Promise<string[]>;
}

export type RouterCatalogEntry = {
  subdomain: string;
  domains: string[];
  chunkCount: number;
  productName: string;
};

const routeResponseSchema = z.object({
  leg: z.enum(['mintlify', 'web']),
  confidence: z.number().min(0).max(1),
  matchedSite: z.string().optional(),
});

const GENERIC_NAME_TOKENS = new Set([
  'docs',
  'api',
  'help',
  'dev',
  'app',
  'base',
  'chain',
  'code',
  'cloud',
  'data',
  'web',
  'get',
  'one',
  'pro',
  'plus',
  'hub',
  'kit',
  'lab',
  'labs',
  'events',
  'send',
  'search',
  'mail',
  'pay',
  'bank',
  'chat',
  'meta',
]);
const RETRIEVAL_HINT_GENERIC_TOKENS = new Set([
  ...GENERIC_NAME_TOKENS,
  'agent',
  'agents',
  'best',
  'compare',
  'comparison',
  'cook',
  'cooking',
  'create',
  'current',
  'developer',
  'developers',
  'development',
  'latest',
  'new',
  'recipe',
  'software',
  'weather',
]);

const SIGNAL_PREFIX_LENGTH = 5;
const ROUTER_MAX_TOKENS = 200;
const MAX_MATCHED_PROMPT_ENTRIES = 10;
const MAX_RETRIEVAL_HINT_SUBDOMAINS = 1;

export type CatalogIndex = {
  names: Map<string, Set<number>>;
  prefixes: Map<string, Set<number>>;
  identities: Map<string, Set<number>>;
};

function buildCatalogIndex(entries: RouterCatalogEntry[]): CatalogIndex {
  const names = new Map<string, Set<number>>();
  const prefixes = new Map<string, Set<number>>();
  const identities = new Map<string, Set<number>>();
  const add = (map: Map<string, Set<number>>, key: string, index: number) => {
    const existing = map.get(key);
    if (existing) existing.add(index);
    else map.set(key, new Set([index]));
  };
  entries.forEach((entry, index) => {
    const candidates = [
      entry.productName,
      entry.subdomain,
      ...entry.domains
        .filter((domain) => !isMintlifyAppHost(domain))
        .map((domain) => getDomainName(domain)),
    ];
    for (const candidate of candidates) {
      for (const token of candidate.toLowerCase().split(/[^a-z0-9]+/)) {
        if (token.length <= 2 || GENERIC_NAME_TOKENS.has(token)) continue;
        add(names, token, index);
        if (token.length >= SIGNAL_PREFIX_LENGTH) {
          add(prefixes, token.slice(0, SIGNAL_PREFIX_LENGTH), index);
        }
      }
    }
    const identity = entry.productName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (identity.length > 2 && !RETRIEVAL_HINT_GENERIC_TOKENS.has(identity)) {
      add(identities, identity, index);
    }
  });
  return { names, prefixes, identities };
}

export function findCatalogSignal(query: string, index: CatalogIndex): Set<number> {
  const matched = new Set<number>();
  const collect = (indices: Set<number> | undefined) => {
    if (indices) for (const value of indices) matched.add(value);
  };
  for (const rawToken of query.toLowerCase().split(/[^a-z0-9.&]+/)) {
    const token = rawToken.replace(/^\.+|\.+$/g, '');
    if (token.length <= 2) continue;
    collect(index.names.get(token));
    if (token.length >= SIGNAL_PREFIX_LENGTH) {
      collect(index.prefixes.get(token.slice(0, SIGNAL_PREFIX_LENGTH)));
    }
    const dottedHead = token.split('.')[0];
    if (dottedHead !== undefined && dottedHead.length > 2) collect(index.names.get(dottedHead));
  }
  return matched;
}

function findCatalogRetrievalHints(query: string, index: CatalogIndex): Set<number> {
  const matched = new Set<number>();
  const collect = (indices: Set<number> | undefined) => {
    if (indices) for (const value of indices) matched.add(value);
  };
  for (const rawToken of query.toLowerCase().split(/[^a-z0-9.&]+/)) {
    const token = rawToken.replace(/[^a-z0-9]+/g, '');
    if (token.length <= 2 || RETRIEVAL_HINT_GENERIC_TOKENS.has(token)) continue;
    collect(index.identities.get(token));
    const dottedHead = rawToken.split('.')[0]?.replace(/[^a-z0-9]+/g, '');
    if (dottedHead && dottedHead !== token) collect(index.identities.get(dottedHead));
  }
  return matched;
}

function catalogLine(entry: RouterCatalogEntry): string {
  return `${entry.productName} | ${entry.subdomain} | ${entry.domains.join(', ')}`;
}

function sortByChunkCountDesc(
  entries: RouterCatalogEntry[]
): { entry: RouterCatalogEntry; index: number }[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.chunkCount - a.entry.chunkCount);
}

export type PreparedRouterCatalog = {
  entries: RouterCatalogEntry[];
  index: CatalogIndex;
  promptTopN: string[];
};

export function prepareRouterCatalog(
  entries: RouterCatalogEntry[],
  topN: number
): PreparedRouterCatalog {
  const promptTopN = sortByChunkCountDesc(entries)
    .slice(0, topN)
    .map((item) => catalogLine(item.entry));
  return { entries, index: buildCatalogIndex(entries), promptTopN };
}

function renderCatalogText(prepared: PreparedRouterCatalog, matchedIndices: Set<number>): string {
  const sorted = sortByChunkCountDesc(prepared.entries);
  const topNIndices = new Set(
    sorted.slice(0, prepared.promptTopN.length).map((item) => item.index)
  );
  const extras = sorted
    .filter((item) => matchedIndices.has(item.index) && !topNIndices.has(item.index))
    .slice(0, MAX_MATCHED_PROMPT_ENTRIES)
    .map((item) => catalogLine(item.entry));
  return [...prepared.promptTopN, ...extras].join('\n');
}

export class LlmUniversalSearchRouter implements UniversalSearchRouter {
  constructor(
    private readonly model: LanguageModelV1,
    private readonly catalogProvider: (collectionName: string) => Promise<PreparedRouterCatalog>,
    private readonly timeoutMs: number
  ) {}

  async plan(query: string, collectionName: string | null): Promise<UniversalSearchRoutePlan> {
    if (collectionName === null) {
      return {
        matchedSubdomains: [],
        decision: Promise.resolve({ leg: 'web', confidence: 0.6, shortcut: true }),
      };
    }
    const prepared = await this.catalogProvider(collectionName);

    const matchedIndices = findCatalogSignal(query, prepared.index);
    if (matchedIndices.size === 0) {
      return {
        matchedSubdomains: [],
        decision: Promise.resolve({ leg: 'web', confidence: 0.6, shortcut: true }),
      };
    }

    const catalogText = renderCatalogText(prepared, matchedIndices);
    const retrievalHintIndices = findCatalogRetrievalHints(query, prepared.index);
    const matchedSubdomains = [...retrievalHintIndices]
      .map((index) => prepared.entries[index])
      .filter((entry): entry is RouterCatalogEntry => entry !== undefined)
      .sort((left, right) => right.chunkCount - left.chunkCount)
      .slice(0, MAX_RETRIEVAL_HINT_SUBDOMAINS)
      .map((entry) => entry.subdomain);
    return {
      matchedSubdomains,
      decision: this.requestDecision(query, catalogText),
    };
  }

  async matchSubdomains(query: string, collectionName: string | null): Promise<string[]> {
    if (collectionName === null) return [];
    const prepared = await this.catalogProvider(collectionName);
    const matchedIndices = findCatalogRetrievalHints(query, prepared.index);
    return [...matchedIndices]
      .map((index) => prepared.entries[index])
      .filter((entry): entry is RouterCatalogEntry => entry !== undefined)
      .sort((left, right) => right.chunkCount - left.chunkCount)
      .slice(0, MAX_RETRIEVAL_HINT_SUBDOMAINS)
      .map((entry) => entry.subdomain);
  }

  async route(query: string, collectionName: string | null): Promise<UniversalSearchRouteDecision> {
    const plan = await this.plan(query, collectionName);
    return plan.decision;
  }

  private async requestDecision(
    query: string,
    catalogText: string
  ): Promise<UniversalSearchRouteDecision> {
    const prompt = `Route a search query. 'mintlify' = the query is about a product whose official docs are hosted on Mintlify (catalog below) and its docs likely answer it. 'web' = anything else: general knowledge, products not in the catalog, current events, opinions/comparisons where the open web is better.

Catalog (product | subdomain | domains):
${catalogText}

Query: ${JSON.stringify(query)}`;
    const { object } = await generateObject({
      model: this.model,
      maxTokens: ROUTER_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      output: 'object',
      schema: routeResponseSchema,
      prompt,
    });
    return object;
  }
}
