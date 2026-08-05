import { randomUUID } from 'node:crypto';

import type {
  UniversalSearchContentsResponse,
  UniversalSearchContextResponse,
  UniversalSearchResult,
  UniversalSearchSearchResponse,
} from '../api/types.js';
import { getLogger } from '../internal/logger.js';
import type {
  UniversalSearchContentsBody,
  UniversalSearchContextBody,
  UniversalSearchSearchBody,
} from '../api/validator.js';
import UniversalSearchService, {
  UniversalSearchResponse,
  UniversalSearchResultItem,
} from './engine.js';
import {
  assembleContext,
  assembleContextItems,
  ContextSnippet,
  sanitizeContextMarkdown,
  selectRelevantWindow,
  truncateMarkdownToCharacters,
} from './contextAssembly.js';

const CONTEXT_NUM_RESULTS = 8;
const CONTEXT_MAX_CHARACTERS_PER_RESULT = 6_000;
const CONTEXT_WEB_FETCH_CHARACTERS_PER_RESULT = 12_000;
const CONTEXT_LATENCY_BUDGET_MS = 2_500;
const CONTEXT_HYDRATION_TIMEOUT_MS = 500;
const CONTEXT_HYDRATED_PAGE_LIMIT = 2;
const CONTEXT_MAX_QUERIES = 3;
const CONTEXT_CANDIDATE_LIMIT = 20;
const CONTEXT_PRIMARY_TOKEN_SHARE = 0.8;
const VERSION_SENSITIVE_QUERY = /\b(?:current|latest|modern|recommended|supported)\b/i;
const SDK_SETUP_QUERY = /\bsdk setup\b/i;

export type UniversalSearchUsageMetrics = {
  legsUsed: string[];
  legLatenciesMs: Record<string, number>;
  counts: Record<string, number>;
  format?: 'txt' | 'json';
  hasProduct?: boolean;
  maxCharactersApplied?: boolean;
  outputTokens?: number;
  textRequested?: boolean;
};

export type UniversalSearchOperationResult<T> = {
  response: T;
  usage: UniversalSearchUsageMetrics;
};

function searchUsageMetrics(
  searchResponse: UniversalSearchResponse,
  returned: number
): Pick<UniversalSearchUsageMetrics, 'legsUsed' | 'legLatenciesMs' | 'counts'> {
  return {
    legsUsed: (['mintlify', 'web'] as const).filter((leg) => searchResponse.legs[leg].contributed),
    legLatenciesMs: {
      mintlify: searchResponse.legs.mintlify.latencyMs,
      web: searchResponse.legs.web.latencyMs,
    },
    counts: {
      mintlify: searchResponse.legs.mintlify.count,
      web: searchResponse.legs.web.count,
      returned,
    },
  };
}

function toContextSnippets(
  results: UniversalSearchResultItem[],
  queries: Map<string, string>,
  hydratedItems: Set<UniversalSearchResultItem>
): ContextSnippet[] {
  const snippets: ContextSnippet[] = [];
  for (const item of results) {
    const query = queries.get(resultIdentity(item)) ?? '';
    if (item.source === 'web') {
      if (item.result.text.trim() === '') continue;
      const markdown = sanitizeContextMarkdown(item.result.text);
      snippets.push({
        url: item.result.url,
        title: item.result.title,
        markdown: selectRelevantWindow(markdown, query, CONTEXT_MAX_CHARACTERS_PER_RESULT),
      });
      continue;
    }

    const url = item.result.metadata.url;
    const available =
      hydratedItems.has(item) &&
      item.result.markdown !== undefined &&
      item.result.markdown.trim() !== ''
        ? item.result.markdown
        : item.result.content;
    const markdown = selectRelevantWindow(
      sanitizeContextMarkdown(available),
      query,
      CONTEXT_MAX_CHARACTERS_PER_RESULT
    );
    if (!url || markdown.trim() === '') continue;
    snippets.push({ url, title: item.result.metadata.title, markdown });
  }
  return snippets;
}

function withProduct(query: string, product?: string): string {
  const normalizedProduct = product?.trim();
  if (
    normalizedProduct === undefined ||
    normalizedProduct === '' ||
    query.toLowerCase().includes(normalizedProduct.toLowerCase())
  ) {
    return query;
  }
  return `${normalizedProduct} ${query}`;
}

function contextScopePrefix(query: string): string {
  const colonIndex = query.indexOf(':');
  if (colonIndex <= 0) return '';
  const prefix = query
    .slice(0, colonIndex)
    .trim()
    .replace(/\b(?:covering|including)\s*$/i, '')
    .trim();
  const wordCount = prefix.match(/[a-z0-9_$.-]+/gi)?.length ?? 0;
  return wordCount <= 20 ? prefix : '';
}

function buildContextQueries(query: string, product?: string): string[] {
  const scopePrefix = contextScopePrefix(query);
  const scopeInstruction = /\bapi\b/i.test(scopePrefix)
    ? 'Use only the named API; exclude other APIs from the same provider.'
    : '';
  const fullQuery = withProduct(
    [query.trim(), scopeInstruction].filter(Boolean).join(' '),
    product
  );
  const clauses = query
    .split(/\s*(?:[,;]\s*(?:and\s+|then\s+)?|\band then\b|\bthen\b|(?<!\$)\band\b)\s*/i)
    .map((clause) => clause.trim().replace(/[.?!]+$/, ''))
    .filter((clause) => (clause.match(/[a-z0-9_$.-]+/gi)?.length ?? 0) >= 2);
  const focused = clauses.slice(1);
  const groupSize = Math.ceil(focused.length / (CONTEXT_MAX_QUERIES - 1));
  const grouped: string[] = [];
  for (let index = 0; index < focused.length; index += groupSize) {
    grouped.push(
      withProduct(
        [scopePrefix, focused.slice(index, index + groupSize).join(' '), scopeInstruction]
          .filter(Boolean)
          .join(' '),
        product
      )
    );
  }
  return Array.from(new Set([fullQuery, ...grouped])).slice(0, CONTEXT_MAX_QUERIES);
}

function resultIdentity(item: UniversalSearchResultItem): string {
  if (item.source === 'web') {
    return `web:${item.result.url}:${item.result.text}`;
  }
  const chunkIdentity = item.result.metadata.chunkId ?? item.result.content;
  return `mintlify:${item.result.page}:${chunkIdentity}`;
}

function canonicalResultUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname !== '/') {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return url.split('#')[0]?.replace(/\/+$/, '') ?? url;
  }
}

function resultUrl(item: UniversalSearchResultItem): string | undefined {
  return item.source === 'web' ? item.result.url : item.result.metadata.url;
}

function requestedApiFamily(query: string): string | undefined {
  const matches = Array.from(contextScopePrefix(query).matchAll(/\b([a-z0-9-]+)\s+api\b/gi));
  return matches.at(-1)?.[1]?.toLowerCase();
}

function urlApiFamily(url: string): string | undefined {
  try {
    return /\/api\/([^/]+)(?:\/|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function mergeContextSearchResponses(
  searches: { query: string; response: UniversalSearchResponse }[]
): {
  response: UniversalSearchResponse;
  queries: Map<string, string>;
} {
  const results: UniversalSearchResultItem[] = [];
  const queries = new Map<string, string>();
  const identities = new Set<string>();
  const indexedUrls = new Set<string>();
  const webUrls = new Set<string>();
  const apiFamily = searches[0] ? requestedApiFamily(searches[0].query) : undefined;
  const candidateApiFamilies = new Set<string>();
  for (const search of searches) {
    for (const item of search.response.results) {
      const url = resultUrl(item);
      if (url !== undefined) {
        const family = urlApiFamily(url);
        if (family !== undefined) candidateApiFamilies.add(family);
      }
      if (item.source === 'mintlify' && item.result.metadata.url) {
        indexedUrls.add(canonicalResultUrl(item.result.metadata.url));
      }
    }
  }
  const add = (item: UniversalSearchResultItem | undefined, query: string): void => {
    if (item === undefined || results.length >= CONTEXT_CANDIDATE_LIMIT) return;
    const url = resultUrl(item);
    const family = url === undefined ? undefined : urlApiFamily(url);
    if (
      apiFamily !== undefined &&
      candidateApiFamilies.has(apiFamily) &&
      family !== undefined &&
      family !== apiFamily
    ) {
      return;
    }
    if (item.source === 'web') {
      const canonicalUrl = canonicalResultUrl(item.result.url);
      if (indexedUrls.has(canonicalUrl) || webUrls.has(canonicalUrl)) return;
      webUrls.add(canonicalUrl);
    }
    const identity = resultIdentity(item);
    if (identities.has(identity)) return;
    identities.add(identity);
    results.push(item);
    queries.set(identity, query);
  };
  const primary = searches[0];
  if (primary !== undefined) {
    add(primary.response.results[0], primary.query);
    add(primary.response.results[1], primary.query);
  }
  const focusedSearches = searches.slice(1);
  const maxFocusedResults = Math.max(
    0,
    ...focusedSearches.map(({ response }) => response.results.length)
  );
  for (
    let rank = 0;
    rank < maxFocusedResults && results.length < CONTEXT_CANDIDATE_LIMIT;
    rank += 1
  ) {
    for (const search of focusedSearches) {
      add(search.response.results[rank], search.query);
    }
    if (primary !== undefined) {
      add(primary.response.results[rank + 2], primary.query);
    }
  }
  const collectionId = searches.find(({ response }) => response.collectionId !== null)?.response
    .collectionId;
  return {
    response: {
      results,
      collectionId: collectionId ?? null,
      legs: {
        mintlify: {
          contributed: searches.some(({ response }) => response.legs.mintlify.contributed),
          latencyMs: Math.max(
            0,
            ...searches.map(({ response }) => response.legs.mintlify.latencyMs)
          ),
          count: searches.reduce((sum, { response }) => sum + response.legs.mintlify.count, 0),
        },
        web: {
          contributed: searches.some(({ response }) => response.legs.web.contributed),
          latencyMs: Math.max(0, ...searches.map(({ response }) => response.legs.web.latencyMs)),
          count: searches.reduce((sum, { response }) => sum + response.legs.web.count, 0),
        },
      },
    },
    queries,
  };
}

function normalizePublishedDate(publishedDate?: string): string | null {
  if (!publishedDate) return null;
  const timestamp = Date.parse(publishedDate);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function toContractResult(params: {
  item: UniversalSearchResultItem;
  includeText: boolean;
  maxCharacters?: number;
}): UniversalSearchResult {
  const { item, includeText, maxCharacters } = params;
  if (item.source === 'web') {
    const { result } = item;
    const available = includeText ? result.text : '';
    const text =
      maxCharacters !== undefined
        ? truncateMarkdownToCharacters(available, maxCharacters)
        : available;
    const cappedByProvider = maxCharacters !== undefined && available.length >= maxCharacters;
    return {
      id: result.url,
      url: result.url,
      title: result.title,
      text,
      ...(includeText ? { truncated: text.length < available.length || cappedByProvider } : {}),
      score: item.score,
      source: 'web',
      siteName: new URL(result.url).hostname.replace(/^www\./, ''),
      breadcrumbs: [],
      publishedDate: normalizePublishedDate(result.publishedDate),
    };
  }

  const { result } = item;
  const groupId = result.metadata.groupId ?? result.page;
  const url = result.metadata.url;
  if (!url) {
    throw new Error(`Universal search result ${groupId} is missing its canonical URL`);
  }
  let available = '';
  if (includeText) {
    const matchedChunk = result.content.trim() !== '' ? result.content : result.markdown;
    available = matchedChunk !== undefined && matchedChunk.trim() !== '' ? matchedChunk : '';
  }
  const pageText =
    maxCharacters !== undefined
      ? truncateMarkdownToCharacters(available, maxCharacters)
      : available;

  return {
    id: groupId,
    url,
    title: result.metadata.title,
    text: pageText,
    ...(includeText
      ? { truncated: pageText.length < available.length, totalCharacters: available.length }
      : {}),
    score: item.score,
    source: 'mintlify',
    siteName: result.metadata.subdomain ?? new URL(url).hostname.replace(/^www\./, ''),
    breadcrumbs: result.metadata.breadcrumbs,
    publishedDate: null,
  };
}

export async function runUniversalSearchContext(
  universalSearchService: UniversalSearchService,
  input: UniversalSearchContextBody
): Promise<UniversalSearchOperationResult<UniversalSearchContextResponse>> {
  const { query, product, format, includeDomains, excludeDomains, tokenBudget } = input;
  const retrievalQueries = buildContextQueries(query, product);
  const searches = await Promise.all(
    retrievalQueries.map(async (retrievalQuery, index) => {
      const mintlifyQuery =
        index === 0 && SDK_SETUP_QUERY.test(query)
          ? `${product?.trim() ? `${product.trim()} ` : ''}SDK client initialization middleware official API`
          : retrievalQuery;
      const response = await universalSearchService.search({
        query: retrievalQuery,
        ...(mintlifyQuery === retrievalQuery ? {} : { mintlifyQuery }),
        product,
        numResults: CONTEXT_NUM_RESULTS,
        maxCharacters: CONTEXT_WEB_FETCH_CHARACTERS_PER_RESULT,
        includeDomains,
        excludeDomains,
        contentMode: 'chunk',
        rerank: false,
        latencyBudgetMs: CONTEXT_LATENCY_BUDGET_MS,
      });
      return { query: mintlifyQuery, response };
    })
  );
  const mergedSearch = mergeContextSearchResponses(searches);
  const rerankedResults =
    retrievalQueries.length > 1 && typeof universalSearchService.rerankContextResults === 'function'
      ? await universalSearchService.rerankContextResults(
          retrievalQueries[0] ?? query,
          mergedSearch.response.results
        )
      : mergedSearch.response.results;
  const searchResponse = { ...mergedSearch.response, results: rerankedResults };
  const hydratedItems = new Set<UniversalSearchResultItem>();
  if (VERSION_SENSITIVE_QUERY.test(query)) {
    const hydrationTargets = searchResponse.results
      .filter((item) => item.source === 'mintlify')
      .slice(0, CONTEXT_HYDRATED_PAGE_LIMIT);
    if (hydrationTargets.length > 0) {
      hydrationTargets.forEach((item) => hydratedItems.add(item));
      await universalSearchService.hydrateResultContent(
        hydrationTargets,
        searchResponse.collectionId,
        { timeoutMs: CONTEXT_HYDRATION_TIMEOUT_MS }
      );
    }
  }
  const hasHydratedMarkdown = searchResponse.results.some(
    (item) =>
      item.source === 'mintlify' &&
      hydratedItems.has(item) &&
      typeof item.result.markdown === 'string' &&
      item.result.markdown.trim() !== ''
  );
  const contextResults =
    SDK_SETUP_QUERY.test(query) && hasHydratedMarkdown
      ? searchResponse.results.filter((item) => item.source === 'mintlify')
      : searchResponse.results;
  const snippets = toContextSnippets(contextResults, mergedSearch.queries, hydratedItems);
  const assembled = (() => {
    if (format === 'txt') {
      const context = assembleContext(snippets, {
        tokenBudget,
        firstSnippetTokenShare: CONTEXT_PRIMARY_TOKEN_SHARE,
      });
      return {
        response: context.text,
        resultsCount: context.usedSnippets,
        outputTokens: context.outputTokens,
      };
    }
    const context = assembleContextItems(snippets, {
      tokenBudget,
      firstSnippetTokenShare: CONTEXT_PRIMARY_TOKEN_SHARE,
    });
    return {
      response: context.response,
      resultsCount: context.usedSnippets,
      outputTokens: context.outputTokens,
    };
  })();
  const response = assembled.response;
  const resultsCount = assembled.resultsCount;
  const outputTokens = assembled.outputTokens;
  const operationResult = {
    response: {
      requestId: randomUUID(),
      query,
      response,
      resultsCount,
      outputTokens,
    },
    usage: {
      ...searchUsageMetrics(searchResponse, resultsCount),
      format,
      hasProduct: product !== undefined,
      outputTokens,
    },
  };
  return operationResult;
}

export async function runUniversalSearchSearch(
  universalSearchService: UniversalSearchService,
  input: UniversalSearchSearchBody
): Promise<UniversalSearchOperationResult<UniversalSearchSearchResponse>> {
  const { query, numResults, includeDomains, excludeDomains, text } = input;
  const includeText = text === true || typeof text === 'object';
  const maxCharacters = typeof text === 'object' ? text.maxCharacters : undefined;
  const searchResponse = await universalSearchService.search({
    query,
    numResults,
    includeDomains,
    excludeDomains,
    maxCharacters,
    contentMode: 'chunk',
  });

  const contractResults = searchResponse.results.map((item) => {
    try {
      return toContractResult({
        item,
        includeText,
        maxCharacters,
      });
    } catch (err) {
      getLogger().warn(
        {
          err,
          source: item.source,
          resultId: item.source === 'mintlify' ? item.result.metadata.groupId : item.result.url,
        },
        'Skipping invalid universal search result'
      );
      return null;
    }
  });
  const results = contractResults.filter(
    (result): result is UniversalSearchResult => result !== null
  );

  const operationResult = {
    response: { requestId: randomUUID(), results },
    usage: {
      ...searchUsageMetrics(searchResponse, results.length),
      textRequested: includeText,
      maxCharactersApplied: maxCharacters !== undefined,
    },
  };
  return operationResult;
}

export async function runUniversalSearchContents(
  universalSearchService: UniversalSearchService,
  input: UniversalSearchContentsBody
): Promise<UniversalSearchOperationResult<UniversalSearchContentsResponse>> {
  const mintlifyLegStartedAt = Date.now();
  let mintlifyLegLatencyMs = 0;
  let contentsResult: Awaited<ReturnType<UniversalSearchService['getContents']>>;
  try {
    contentsResult = await universalSearchService.getContents(input);
  } finally {
    mintlifyLegLatencyMs = Date.now() - mintlifyLegStartedAt;
  }
  const { results, statuses } = contentsResult;
  const succeeded = statuses.filter((status) => status.status === 'success').length;

  return {
    response: { requestId: randomUUID(), results, statuses },
    usage: {
      legsUsed: ['mintlify'],
      legLatenciesMs: { mintlify: mintlifyLegLatencyMs },
      maxCharactersApplied: input.maxCharacters !== undefined,
      counts: {
        requested: statuses.length,
        succeeded,
        failed: statuses.length - succeeded,
        returned: results.length,
      },
    },
  };
}
