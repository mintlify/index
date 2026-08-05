import {
  Aggregate,
  ChromaNotFoundError,
  GroupBy,
  IncludeEnum,
  K,
  Key,
  Knn,
  Metadata,
  Search,
  Where,
} from 'chromadb';

import type { LeanUniversalSearchManifest } from '../internal/manifestRepository.js';
import { ChromaRepository } from '../internal/chromaRepository.js';
import { UniversalSearchManifestRepository } from '../internal/manifestRepository.js';
import type {
  UniversalSearchContentStatus,
  UniversalSearchResult,
} from '../api/types.js';
import { getLogger } from '../internal/logger.js';
import { MINTLIFY_APP_SUFFIX, isMintlifyAppHost } from '../internal/mintlifyAppDomain.js';
import { withTimeout } from '../internal/withTimeout.js';
import type { UniversalSearchContentsBody } from '../api/validator.js';
import SearchService, {
  buildFilters,
  parseMetadataValue,
  SearchResult,
  stripDocumentFrontmatter,
} from '../internal/searchService.js';
import {
  selectRelevantWindow,
  truncateMarkdownToCharacters,
} from './contextAssembly.js';
import type {
  UniversalSearchRerankCandidate,
  UniversalSearchReranker,
} from './reranker.js';
import {
  PRODUCTION_UNIVERSAL_SEARCH_RETRIEVAL_CONFIG,
  type UniversalSearchRetrievalConfig,
} from './retrievalConfig.js';
import type {
  UniversalSearchRouteDecision,
  UniversalSearchRoutePlan,
  UniversalSearchRouter,
} from './router.js';
import { WebSearchProvider, WebSearchProviderResult } from './webSearchProvider.js';

const DEFAULT_NUM_RESULTS = 10;
const HYDRATE_TIMEOUT_MS = 3000;
const ACTIVE_MANIFEST_CACHE_TTL_MS = 5_000;
const MINIMUM_RERANK_CANDIDATES = 20;
const RERANK_CANDIDATE_MULTIPLIER = 2;
const LATENCY_BOUNDED_CATALOG_TIMEOUT_MS = 100;
const LATENCY_BOUNDED_WEB_RESULT_LIMIT = 5;
const RELEVANCE_GATE_MIN_WORDS = 4;
const PUBLIC_TAG_WHERE: Where = { tags: { $contains: 'PUBLIC' } };
const UNSERVED_LEG_STAT: UniversalSearchLegStat = { contributed: false, latencyMs: 0, count: 0 };

export type UniversalSearchLeg = 'mintlify' | 'web';

export type UniversalSearchResultItem =
  | {
      source: 'mintlify';
      score: number;
      result: SearchResult;
      relevance?: number;
      relevanceScore?: number;
    }
  | {
      source: 'web';
      score: number;
      result: WebSearchProviderResult;
      relevance?: number;
      relevanceScore?: number;
    };

export type UniversalSearchLegStat = {
  contributed: boolean;
  latencyMs: number;
  count: number;
};

export type UniversalSearchResponse = {
  results: UniversalSearchResultItem[];
  legs: Record<UniversalSearchLeg, UniversalSearchLegStat>;
  collectionId: string | null;
};

type LegOutcome<T> = {
  results: T[];
  latencyMs: number;
  ok: boolean;
  collectionId?: string;
};

type LegSearchContext = {
  query: string;
  mintlifyQuery: string;
  numResults: number;
  rerankCandidateCount: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxCharacters?: number;
  includeSubdomains?: string[];
  excludeSubdomains?: string[];
  includeMatchesNothing: boolean;
  retryUnfilteredMintlify: boolean;
  collectionName: string | null;
  storedCollectionId: string | null;
  contentMode: UniversalSearchContentMode;
  rerank: boolean;
  latencyBudgetMs?: number;
};

type ScopedLegWinner =
  | { source: 'mintlify'; outcome: LegOutcome<SearchResult> }
  | { source: 'web'; outcome: LegOutcome<WebSearchProviderResult> };

type UniversalSearchContentMode = 'chunk' | 'page';

type UniversalSearchParams = {
  query: string;
  mintlifyQuery?: string;
  product?: string;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxCharacters?: number;
  contentMode?: UniversalSearchContentMode;
  rerank?: boolean;
  latencyBudgetMs?: number;
  forceWeb?: boolean;
};

function rrfScore(rank: number, k: number): number {
  return 1 / (k + rank);
}

function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function hostname(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export default class UniversalSearchService {
  private readonly collectionIdCache = new Map<string, string>();
  private readonly rerankedItems = new WeakSet<UniversalSearchResultItem>();
  private activeManifestCache:
    | { value: LeanUniversalSearchManifest | null; expiresAt: number }
    | undefined;
  private activeManifestRequest: Promise<LeanUniversalSearchManifest | null> | undefined;

  constructor(
    private readonly searchService: SearchService,
    private readonly webSearchProvider: WebSearchProvider,
    private readonly manifestRepository: UniversalSearchManifestRepository,
    private readonly chromaRepository: ChromaRepository,
    private readonly retrievalConfig: UniversalSearchRetrievalConfig = PRODUCTION_UNIVERSAL_SEARCH_RETRIEVAL_CONFIG,
    private readonly reranker?: UniversalSearchReranker,
    private readonly router?: UniversalSearchRouter
  ) {}

  private async resolveCollectionId(collectionName: string): Promise<string> {
    const cached = this.collectionIdCache.get(collectionName);
    if (cached !== undefined) return cached;
    const collection = await this.chromaRepository.getCollectionByName(collectionName);
    this.collectionIdCache.set(collectionName, collection.id);
    return collection.id;
  }

  private async getActiveManifest(
    forceRefresh = false
  ): Promise<LeanUniversalSearchManifest | null> {
    if (forceRefresh) {
      this.activeManifestCache = undefined;
    }
    const cached = this.activeManifestCache;
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (cached !== undefined && !forceRefresh) {
      void this.loadActiveManifest().catch((err) => {
        getLogger().warn({ err }, 'Universal search active manifest background refresh failed');
      });
      return cached.value;
    }

    return this.loadActiveManifest();
  }

  private async loadActiveManifest(): Promise<LeanUniversalSearchManifest | null> {
    const activeRequest = this.activeManifestRequest;
    if (activeRequest !== undefined) {
      return activeRequest;
    }

    const request = this.manifestRepository.getActiveManifest();
    this.activeManifestRequest = request;
    try {
      const value = await request;
      this.activeManifestCache = {
        value,
        expiresAt: Date.now() + ACTIVE_MANIFEST_CACHE_TTL_MS,
      };
      return value;
    } finally {
      if (this.activeManifestRequest === request) {
        this.activeManifestRequest = undefined;
      }
    }
  }

  warmSearchCaches(): void {
    void this.warmSearchCachesOperation().catch((err) =>
      getLogger().warn({ err }, 'Universal search cache warmup failed')
    );
  }

  private async warmSearchCachesOperation(): Promise<void> {
    const activeManifest = await this.getActiveManifest();
    if (activeManifest === null || this.router?.matchSubdomains === undefined) return;
    await this.router.matchSubdomains('', activeManifest.collectionName);
  }

  async search(params: UniversalSearchParams): Promise<UniversalSearchResponse> {
    const { query, product, includeDomains, excludeDomains, maxCharacters } = params;
    const contentMode = params.contentMode ?? 'page';
    const numResults = params.numResults ?? DEFAULT_NUM_RESULTS;
    const rerankCandidateCount = Math.max(
      numResults * RERANK_CANDIDATE_MULTIPLIER,
      MINIMUM_RERANK_CANDIDATES
    );

    const activeManifest = await this.getActiveManifest();
    const collectionName = activeManifest?.collectionName ?? null;
    const storedCollectionId = activeManifest?.collectionId ?? null;
    const catalogQuery = product ?? (params.latencyBudgetMs !== undefined ? query : undefined);

    const [includeSubdomains, excludeSubdomains, productSubdomains] = await Promise.all([
      collectionName
        ? this.resolveSubdomains(collectionName, includeDomains)
        : Promise.resolve(undefined),
      collectionName
        ? this.resolveSubdomains(collectionName, excludeDomains)
        : Promise.resolve(undefined),
      !params.forceWeb &&
      collectionName &&
      catalogQuery !== undefined &&
      this.router?.matchSubdomains !== undefined
        ? (params.latencyBudgetMs === undefined
            ? this.router.matchSubdomains(catalogQuery, collectionName)
            : withTimeout(
                this.router.matchSubdomains(catalogQuery, collectionName),
                LATENCY_BOUNDED_CATALOG_TIMEOUT_MS,
                (ms) => new Error(`Universal search catalog matching timed out after ${ms}ms`)
              )
          ).catch((err) => {
            getLogger().warn(
              { err, product: catalogQuery },
              'Universal search product matching failed'
            );
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);

    const includeMatchesNothing = includeSubdomains !== undefined && includeSubdomains.length === 0;
    const matchedProductSubdomains =
      productSubdomains !== undefined && productSubdomains.length > 0
        ? productSubdomains
        : undefined;
    const effectiveIncludeSubdomains = includeSubdomains ?? matchedProductSubdomains;

    const ctx: LegSearchContext = {
      query,
      mintlifyQuery: params.mintlifyQuery ?? query,
      numResults,
      rerankCandidateCount,
      includeDomains,
      excludeDomains,
      maxCharacters,
      includeSubdomains: effectiveIncludeSubdomains,
      excludeSubdomains,
      includeMatchesNothing,
      retryUnfilteredMintlify: false,
      collectionName,
      storedCollectionId,
      contentMode,
      rerank: params.rerank ?? true,
      latencyBudgetMs: params.latencyBudgetMs,
    };

    if (params.forceWeb) {
      return this.serveRouted(
        'web',
        ctx,
        Promise.resolve({ results: [], latencyMs: 0, ok: true }),
        this.startWebLeg(ctx)
      );
    }

    if (effectiveIncludeSubdomains !== undefined && effectiveIncludeSubdomains.length > 0) {
      const mintlifyLeg = this.startMintlifyLeg(ctx);
      if (ctx.latencyBudgetMs !== undefined) {
        const webLeg = this.startWebLeg(ctx);
        return this.serveScopedWithinLatencyBudget(ctx, mintlifyLeg, webLeg);
      }
      const webLeg = mintlifyLeg.then((outcome) =>
        outcome.ok && outcome.results.length > 0
          ? { results: [], latencyMs: 0, ok: true }
          : this.startWebLeg(ctx)
      );
      return this.serveRouted('mintlify', ctx, mintlifyLeg, webLeg);
    }

    if (
      (includeSubdomains === undefined || includeMatchesNothing) &&
      (product !== undefined || params.latencyBudgetMs !== undefined)
    ) {
      const webLeg = this.startWebLeg(ctx);
      return this.serveRouted(
        'web',
        ctx,
        Promise.resolve({ results: [], latencyMs: 0, ok: true }),
        webLeg
      );
    }

    if (this.router && this.retrievalConfig.routerEnabled) {
      const webLeg = this.startWebLeg(ctx);
      let routePlan: UniversalSearchRoutePlan;
      try {
        routePlan = await this.router.plan(query, collectionName);
      } catch (err) {
        getLogger().warn({ err }, 'Universal search router planning failed; defaulting to web leg');
        const mintlifyLeg = this.startMintlifyLeg(ctx);
        return this.serveRouted('web', ctx, mintlifyLeg, webLeg);
      }

      const hasExplicitDomainFilters = includeDomains !== undefined || excludeDomains !== undefined;
      const inferredSubdomains =
        !hasExplicitDomainFilters && routePlan.matchedSubdomains.length > 0
          ? routePlan.matchedSubdomains
          : undefined;
      const routedCtx: LegSearchContext = {
        ...ctx,
        includeSubdomains: inferredSubdomains ?? ctx.includeSubdomains,
        retryUnfilteredMintlify: inferredSubdomains !== undefined,
      };
      const deferMintlify = !hasExplicitDomainFilters && routePlan.matchedSubdomains.length === 0;
      const mintlifyLeg = deferMintlify ? undefined : this.startMintlifyLeg(routedCtx);
      return this.searchRouted(routePlan.decision, routedCtx, mintlifyLeg, webLeg);
    }

    const { mintlifyLeg, webLeg } = this.startLegs(ctx);
    return this.combineLegs(ctx, mintlifyLeg, webLeg);
  }

  private async serveScopedWithinLatencyBudget(
    ctx: LegSearchContext,
    mintlifyLegPromise: Promise<LegOutcome<SearchResult>>,
    webLegPromise: Promise<LegOutcome<WebSearchProviderResult>>
  ): Promise<UniversalSearchResponse> {
    const startedAt = Date.now();
    const winner = await Promise.race([
      mintlifyLegPromise.then((outcome): ScopedLegWinner => ({ source: 'mintlify', outcome })),
      webLegPromise.then((outcome): ScopedLegWinner => ({ source: 'web', outcome })),
    ]);

    if (winner.source === 'mintlify') {
      if (!winner.outcome.ok || winner.outcome.results.length === 0) {
        return this.serveRouted('web', ctx, Promise.resolve(winner.outcome), webLegPromise);
      }
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, (ctx.latencyBudgetMs ?? 0) - elapsedMs);
      const web =
        remainingMs === 0 ? null : await withTimeout(webLegPromise, remainingMs).catch(() => null);
      if (web !== null && web.ok && web.results.length > 0) {
        return this.blendScopedLegs(ctx, winner.outcome, web);
      }
      return this.serveRouted('mintlify', ctx, Promise.resolve(winner.outcome), webLegPromise);
    }

    if (!winner.outcome.ok || winner.outcome.results.length === 0) {
      return this.serveRouted('mintlify', ctx, mintlifyLegPromise, Promise.resolve(winner.outcome));
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(0, (ctx.latencyBudgetMs ?? 0) - elapsedMs);
    const mintlify =
      remainingMs === 0
        ? null
        : await withTimeout(mintlifyLegPromise, remainingMs).catch(() => null);
    if (mintlify !== null && mintlify.ok && mintlify.results.length > 0) {
      return this.blendScopedLegs(ctx, mintlify, winner.outcome);
    }
    return this.serveRouted('web', ctx, mintlifyLegPromise, Promise.resolve(winner.outcome));
  }

  private async blendScopedLegs(
    ctx: LegSearchContext,
    mintlify: LegOutcome<SearchResult>,
    web: LegOutcome<WebSearchProviderResult>
  ): Promise<UniversalSearchResponse> {
    const items = [
      ...this.toItems({ source: 'mintlify', results: mintlify.results }),
      ...this.toItems({ source: 'web', results: web.results }),
    ].sort((a, b) => b.score - a.score);
    const results = await this.rankAndCut(ctx.query, items, ctx.rerank);
    return {
      results: results.slice(0, ctx.numResults),
      collectionId:
        mintlify.collectionId ??
        this.resolvedCollectionId(ctx.collectionName, ctx.storedCollectionId),
      legs: {
        mintlify: this.legStat(mintlify),
        web: this.legStat(web),
      },
    };
  }

  private resolvedCollectionId(
    collectionName: string | null,
    storedCollectionId: string | null
  ): string | null {
    return (
      storedCollectionId ??
      (collectionName ? (this.collectionIdCache.get(collectionName) ?? null) : null)
    );
  }

  private startLegs(ctx: LegSearchContext): {
    mintlifyLeg: Promise<LegOutcome<SearchResult>>;
    webLeg: Promise<LegOutcome<WebSearchProviderResult>>;
  } {
    return {
      mintlifyLeg: this.startMintlifyLeg(ctx),
      webLeg: this.startWebLeg(ctx),
    };
  }

  private startMintlifyLeg(ctx: LegSearchContext): Promise<LegOutcome<SearchResult>> {
    return ctx.collectionName && !ctx.includeMatchesNothing
      ? this.runMintlifyLeg({
          query: ctx.mintlifyQuery,
          collectionName: ctx.collectionName,
          collectionId: ctx.storedCollectionId,
          numResults: ctx.numResults,
          includeSubdomains: ctx.includeSubdomains,
          excludeSubdomains: ctx.excludeSubdomains,
          contentMode: ctx.contentMode,
        })
      : Promise.resolve<LegOutcome<SearchResult>>({ results: [], latencyMs: 0, ok: true });
  }

  private startWebLeg(ctx: LegSearchContext): Promise<LegOutcome<WebSearchProviderResult>> {
    const numResults =
      ctx.latencyBudgetMs !== undefined && !ctx.rerank
        ? Math.min(ctx.numResults, LATENCY_BOUNDED_WEB_RESULT_LIMIT)
        : ctx.rerank && this.reranker
          ? ctx.rerankCandidateCount
          : ctx.numResults;
    return this.runWebLeg({
      query: ctx.query,
      numResults,
      includeDomains: ctx.includeDomains,
      excludeDomains: ctx.excludeDomains,
      maxCharacters: ctx.maxCharacters,
      searchType: this.retrievalConfig.webSearchType,
      livecrawl: this.retrievalConfig.webLivecrawl,
    });
  }

  private toItems(
    leg:
      | { source: 'mintlify'; results: SearchResult[] }
      | { source: 'web'; results: WebSearchProviderResult[] }
  ): UniversalSearchResultItem[] {
    const k = this.retrievalConfig.sourceBlendRrfK;
    if (leg.source === 'mintlify') {
      return leg.results.map((result, i) => ({
        source: leg.source,
        score: rrfScore(i + 1, k),
        result,
      }));
    }
    return leg.results.map((result, i) => ({
      source: leg.source,
      score: rrfScore(i + 1, k),
      result,
    }));
  }

  private async rankAndCut(
    query: string,
    items: UniversalSearchResultItem[],
    rerank: boolean
  ): Promise<UniversalSearchResultItem[]> {
    if (!rerank || !this.reranker) return items;
    const rankedItems = await this.rerankItems(query, items);
    return this.applyRelevanceCutoff(rankedItems);
  }

  async rerankContextResults(
    query: string,
    items: UniversalSearchResultItem[]
  ): Promise<UniversalSearchResultItem[]> {
    if (!this.reranker || items.length < 2) return items;
    return await this.rerankItems(query, items);
  }

  private legStat(outcome: LegOutcome<unknown>, opts?: { count?: number }): UniversalSearchLegStat {
    const count = opts?.count ?? outcome.results.length;
    return { contributed: outcome.ok && count > 0, latencyMs: outcome.latencyMs, count };
  }

  private async combineLegs(
    ctx: LegSearchContext,
    mintlifyLegPromise: Promise<LegOutcome<SearchResult>>,
    webLegPromise: Promise<LegOutcome<WebSearchProviderResult>>
  ): Promise<UniversalSearchResponse> {
    return this.combineLegsOperation(ctx, mintlifyLegPromise, webLegPromise);
  }

  private async combineLegsOperation(
    ctx: LegSearchContext,
    mintlifyLegPromise: Promise<LegOutcome<SearchResult>>,
    webLegPromise: Promise<LegOutcome<WebSearchProviderResult>>
  ): Promise<UniversalSearchResponse> {
    const { query, numResults, collectionName, storedCollectionId } = ctx;

    const syncedHostsPromise = collectionName
      ? this.collectSyncedHosts(collectionName).catch((err: unknown) => {
          getLogger().warn({ err }, 'Universal search synced hosts lookup failed');
          return new Set<string>();
        })
      : Promise.resolve(new Set<string>());

    const [mintlify, web, syncedHosts] = await Promise.all([
      mintlifyLegPromise,
      webLegPromise,
      syncedHostsPromise,
    ]);

    const mintlifyItems = this.toItems({ source: 'mintlify', results: mintlify.results });
    const webItems = this.toItems({ source: 'web', results: web.results }).filter((item) => {
      const host = item.source === 'web' ? hostname(item.result.url) : null;
      return host === null || !syncedHosts.has(host);
    });
    const items = [...mintlifyItems, ...webItems].sort((a, b) => b.score - a.score);
    const rankedCut = await this.rankAndCut(query, items, ctx.rerank);

    return {
      results: rankedCut.slice(0, numResults),
      collectionId:
        mintlify.collectionId ?? this.resolvedCollectionId(collectionName, storedCollectionId),
      legs: {
        mintlify: this.legStat(mintlify),
        web: this.legStat(web, { count: webItems.length }),
      },
    };
  }

  private async searchRouted(
    decisionPromise: Promise<UniversalSearchRouteDecision>,
    ctx: LegSearchContext,
    mintlifyLeg: Promise<LegOutcome<SearchResult>> | undefined,
    webLeg: Promise<LegOutcome<WebSearchProviderResult>>
  ): Promise<UniversalSearchResponse> {
    const routerStart = Date.now();
    let decision: UniversalSearchRouteDecision;
    try {
      decision = await decisionPromise;
    } catch (err) {
      getLogger().warn({ err }, 'Universal search router failed; defaulting to web leg');
      return this.serveRouted('web', ctx, mintlifyLeg, webLeg);
    }

    getLogger().info(
      {
        leg: decision.leg,
        confidence: decision.confidence,
        matchedSite: decision.matchedSite,
        shortcut: decision.shortcut ?? false,
        routerLatencyMs: Date.now() - routerStart,
      },
      'Universal search routed'
    );

    const primary: UniversalSearchLeg =
      decision.leg === 'mintlify' && ctx.collectionName && !ctx.includeMatchesNothing
        ? 'mintlify'
        : 'web';
    return this.serveRouted(primary, ctx, mintlifyLeg, webLeg);
  }

  private async resolveMintlifyLeg(
    ctx: LegSearchContext,
    mintlifyLegPromise: Promise<LegOutcome<SearchResult>> | undefined
  ): Promise<LegOutcome<SearchResult>> {
    const mintlify = await (mintlifyLegPromise ?? this.startMintlifyLeg(ctx));
    if ((mintlify.ok && mintlify.results.length > 0) || !ctx.retryUnfilteredMintlify) {
      return mintlify;
    }
    getLogger().info(
      { latencyMs: mintlify.latencyMs },
      'Universal search catalog-filtered Mintlify leg empty; retrying unfiltered'
    );
    const retried = await this.startMintlifyLeg({
      ...ctx,
      includeSubdomains: undefined,
      retryUnfilteredMintlify: false,
    });
    return {
      ...retried,
      latencyMs: mintlify.latencyMs + retried.latencyMs,
      collectionId: retried.collectionId ?? mintlify.collectionId,
    };
  }

  private async serveRouted(
    primary: UniversalSearchLeg,
    ctx: LegSearchContext,
    mintlifyLegPromise: Promise<LegOutcome<SearchResult>> | undefined,
    webLegPromise: Promise<LegOutcome<WebSearchProviderResult>>
  ): Promise<UniversalSearchResponse> {
    if (primary === 'mintlify') {
      const mintlify = await this.resolveMintlifyLeg(ctx, mintlifyLegPromise);
      const collectionId =
        mintlify.collectionId ??
        this.resolvedCollectionId(ctx.collectionName, ctx.storedCollectionId);

      if (mintlify.ok && mintlify.results.length > 0) {
        const items = await this.rankAndCut(
          ctx.query,
          this.toItems({ source: 'mintlify', results: mintlify.results }),
          ctx.rerank
        );
        return {
          results: items.slice(0, ctx.numResults),
          collectionId,
          legs: { mintlify: this.legStat(mintlify), web: UNSERVED_LEG_STAT },
        };
      }

      getLogger().info(
        { latencyMs: mintlify.latencyMs },
        'Universal search routed mintlify leg empty; falling back to web'
      );
      const web = await webLegPromise;
      const items = this.toItems({ source: 'web', results: web.results });
      return {
        results: items.slice(0, ctx.numResults),
        collectionId,
        legs: { mintlify: this.legStat(mintlify), web: this.legStat(web) },
      };
    }

    const web = await webLegPromise;
    const collectionId = this.resolvedCollectionId(ctx.collectionName, ctx.storedCollectionId);

    if (web.ok && web.results.length > 0) {
      const items = this.toItems({ source: 'web', results: web.results });
      return {
        results: items.slice(0, ctx.numResults),
        collectionId,
        legs: { mintlify: UNSERVED_LEG_STAT, web: this.legStat(web) },
      };
    }

    getLogger().info(
      { latencyMs: web.latencyMs },
      'Universal search routed web leg empty; falling back to mintlify'
    );

    if (!ctx.collectionName || ctx.includeMatchesNothing) {
      return {
        results: [],
        collectionId,
        legs: { mintlify: UNSERVED_LEG_STAT, web: this.legStat(web) },
      };
    }

    const mintlify = await this.resolveMintlifyLeg(ctx, mintlifyLegPromise);
    const items = await this.rankAndCut(
      ctx.query,
      this.toItems({ source: 'mintlify', results: mintlify.results }),
      ctx.rerank
    );
    return {
      results: items.slice(0, ctx.numResults),
      collectionId:
        mintlify.collectionId ??
        this.resolvedCollectionId(ctx.collectionName, ctx.storedCollectionId),
      legs: { mintlify: this.legStat(mintlify), web: this.legStat(web) },
    };
  }

  private applyRelevanceCutoff(items: UniversalSearchResultItem[]): UniversalSearchResultItem[] {
    if (!this.retrievalConfig.cutoffEnabled) return items;

    const hasRerankedItems = items.some((item) => this.rerankedItems.has(item));
    if (!hasRerankedItems) return items;

    return items.filter(
      (item, index) =>
        index < this.retrievalConfig.cutoffMinKeep ||
        (item.relevance !== undefined &&
          item.relevance >= this.retrievalConfig.cutoffMinRelevance) ||
        (item.relevanceScore !== undefined &&
          item.relevanceScore >= this.retrievalConfig.cutoffMinScore) ||
        (this.rerankedItems.has(item) &&
          item.relevance === undefined &&
          item.relevanceScore === undefined)
    );
  }

  private async rerankItems(
    query: string,
    items: UniversalSearchResultItem[]
  ): Promise<UniversalSearchResultItem[]> {
    if (!this.reranker || items.length < 2) return items;
    const byId = new Map<string, UniversalSearchResultItem>();
    const candidates: UniversalSearchRerankCandidate[] = items.map((item, index) => {
      const id = `candidate-${index}`;
      byId.set(id, item);
      const retrievalScore = items.length === 1 ? 1 : 1 - index / (items.length - 1);
      if (item.source === 'web') {
        return {
          id,
          source: item.source,
          title: item.result.title,
          url: item.result.url,
          siteName: hostname(item.result.url) ?? undefined,
          snippet: item.result.text,
          retrievalScore,
        };
      }
      return {
        id,
        source: item.source,
        title: item.result.metadata.title,
        url: item.result.metadata.url ?? '',
        siteName: item.result.metadata.subdomain,
        snippet: item.result.markdown ?? item.result.content,
        retrievalScore,
      };
    });

    try {
      const reranked = await this.reranker.rerank(query, candidates);
      const seen = new Set<string>();
      const results: UniversalSearchResultItem[] = [];
      for (const ranked of reranked) {
        const item = byId.get(ranked.id);
        if (!item || seen.has(ranked.id)) continue;
        seen.add(ranked.id);
        const rerankedItem: UniversalSearchResultItem = {
          ...item,
          score: ranked.score,
          relevance: ranked.relevance,
          relevanceScore: ranked.relevanceScore,
        };
        this.rerankedItems.add(rerankedItem);
        results.push(rerankedItem);
      }
      for (const [id, item] of byId) {
        if (!seen.has(id)) results.push(item);
      }
      return results;
    } catch (err) {
      getLogger().warn({ err }, 'Universal search reranker failed; preserving retrieval order');
      return items;
    }
  }

  async hydrateResultContent(
    items: UniversalSearchResultItem[],
    collectionId: string | null,
    {
      ensureChunkDocument = false,
      timeoutMs = HYDRATE_TIMEOUT_MS,
    }: { ensureChunkDocument?: boolean; timeoutMs?: number } = {}
  ): Promise<void> {
    if (!collectionId) return;
    const targets = new Map<string, SearchResult[]>();
    for (const item of items) {
      if (item.source !== 'mintlify') continue;
      const chunkId = item.result.metadata.chunkId;
      const needsFetch = ensureChunkDocument
        ? item.result.content === ''
        : item.result.markdown === undefined;
      if (typeof chunkId !== 'string' || !needsFetch) continue;
      const list = targets.get(chunkId) ?? [];
      list.push(item.result);
      targets.set(chunkId, list);
    }
    if (targets.size === 0) return;

    try {
      const page = await withTimeout(
        this.chromaRepository.get(collectionId, {
          ids: Array.from(targets.keys()),
          include: [IncludeEnum.documents, IncludeEnum.metadatas],
        }),
        timeoutMs,
        (ms) => new Error(`Universal search hydration timed out after ${ms}ms`)
      );
      for (let i = 0; i < page.ids.length; i++) {
        const results = targets.get(page.ids[i] ?? '');
        if (!results) continue;
        const document = stripDocumentFrontmatter(page.documents[i] ?? '');
        const markdown = page.metadatas[i]?.markdown;
        for (const result of results) {
          result.content = document;
          if (typeof markdown === 'string' && markdown !== '') {
            result.markdown = markdown;
          }
        }
      }
    } catch (err) {
      getLogger().warn(
        { err, collectionId, chunkCount: targets.size },
        'Universal search content hydration failed'
      );
    }
  }

  private async collectSyncedHosts(collectionName: string): Promise<Set<string>> {
    const sites = await this.manifestRepository.getSyncedSiteHosts(collectionName);
    const hosts = new Set<string>();
    for (const site of sites) {
      hosts.add(normalizeHost(`${site.subdomain}${MINTLIFY_APP_SUFFIX}`));
      for (const domain of site.domains ?? []) {
        hosts.add(normalizeHost(domain));
      }
    }
    return hosts;
  }

  private async resolveSubdomains(
    collectionName: string,
    domains: string[] | undefined
  ): Promise<string[] | undefined> {
    if (!domains?.length) return undefined;
    const subdomains = new Set<string>();
    const customDomains: string[] = [];
    for (const domain of domains) {
      const host = normalizeHost(domain);
      if (isMintlifyAppHost(host)) {
        subdomains.add(host.slice(0, -MINTLIFY_APP_SUFFIX.length));
      } else {
        customDomains.push(host);
      }
    }
    if (customDomains.length) {
      const resolved = await this.manifestRepository.getSubdomainsByDomains(
        collectionName,
        customDomains
      );
      for (const subdomain of resolved) {
        subdomains.add(subdomain);
      }
    }
    return Array.from(subdomains);
  }

  async getContents(params: UniversalSearchContentsBody): Promise<{
    results: UniversalSearchResult[];
    statuses: UniversalSearchContentStatus[];
  }> {
    try {
      return await this.getContentsOperation(params, false, true);
    } catch (err) {
      if (!(err instanceof ChromaNotFoundError)) throw err;
      return this.getContentsOperation(params, true, false);
    }
  }

  private async getContentsOperation(
    params: UniversalSearchContentsBody,
    forceManifestRefresh: boolean,
    refreshOnNotFound: boolean
  ): Promise<{
    results: UniversalSearchResult[];
    statuses: UniversalSearchContentStatus[];
  }> {
    const { urls, ids, maxCharacters, query } = params;
    const inputs = [
      ...(urls ?? []).map((raw) => ({ kind: 'url' as const, raw })),
      ...(ids ?? []).map((raw) => ({ kind: 'id' as const, raw })),
    ];

    const activeManifest = await this.getActiveManifest(forceManifestRefresh);
    const collectionName = activeManifest?.collectionName ?? null;

    if (!collectionName) {
      return {
        results: [],
        statuses: inputs.map(({ raw }) => ({
          id: raw,
          status: 'error',
          error: { tag: 'not_synced', httpStatusCode: null },
        })),
      };
    }

    let collectionId: string;
    try {
      collectionId =
        activeManifest?.collectionId ?? (await this.resolveCollectionId(collectionName));
    } catch (err) {
      if (refreshOnNotFound && err instanceof ChromaNotFoundError) throw err;
      getLogger().warn(
        { err, collectionName },
        'Universal search contents collection resolution failed'
      );
      return {
        results: [],
        statuses: inputs.map(({ raw }) => ({
          id: raw,
          status: 'error',
          error: { tag: 'fetch_error', httpStatusCode: 500 },
        })),
      };
    }

    const hostToSubdomain = new Map<string, string>();
    const requestedSubdomains = new Set<string>();
    const customHosts = new Set<string>();
    for (const input of inputs) {
      if (input.kind === 'id') {
        const resolved = resolveContentInput(input, hostToSubdomain);
        if (!('error' in resolved)) {
          requestedSubdomains.add(resolved.subdomain);
        }
        continue;
      }
      try {
        const host = normalizeHost(new URL(input.raw).hostname);
        if (isMintlifyAppHost(host)) {
          requestedSubdomains.add(host.slice(0, -MINTLIFY_APP_SUFFIX.length));
        } else {
          customHosts.add(host);
        }
      } catch {
        continue;
      }
    }
    const customHostList = Array.from(customHosts);
    const [syncedDirectSubdomains, customHostSubdomains] = await Promise.all([
      requestedSubdomains.size === 0
        ? Promise.resolve([])
        : this.manifestRepository.getSyncedSiteSubdomains(
            collectionName,
            Array.from(requestedSubdomains)
          ),
      Promise.all(
        customHostList.map((host) =>
          this.manifestRepository.getSubdomainsByDomains(collectionName, [host])
        )
      ),
    ]);
    const syncedSubdomains = new Set(syncedDirectSubdomains);
    for (let index = 0; index < customHostList.length; index++) {
      const host = customHostList[index];
      const subdomain = customHostSubdomains[index]?.[0];
      if (host === undefined || subdomain === undefined) continue;
      hostToSubdomain.set(host, subdomain);
      syncedSubdomains.add(subdomain);
    }

    const settled = await Promise.all(
      inputs.map((input) =>
        this.fetchContentForInput(input, {
          collectionId,
          hostToSubdomain,
          syncedSubdomains,
          maxCharacters,
          query,
          refreshOnNotFound,
        })
      )
    );
    const webFallbackUrls = settled.flatMap((item, index) => {
      const input = inputs[index];
      if (
        input?.kind !== 'url' ||
        item.status.status !== 'error' ||
        !['not_found', 'not_synced'].includes(item.status.error.tag)
      ) {
        return [];
      }
      return [input.raw];
    });
    if (webFallbackUrls.length > 0 && this.webSearchProvider.getContents !== undefined) {
      try {
        const webResults = await this.webSearchProvider.getContents(webFallbackUrls, {
          maxCharacters,
          livecrawl: this.retrievalConfig.webLivecrawl,
        });
        const byUrl = new Map(webResults.map((result) => [result.url, result]));
        for (let index = 0; index < settled.length; index++) {
          const input = inputs[index];
          if (input?.kind !== 'url') continue;
          const webResult = byUrl.get(input.raw);
          if (webResult === undefined) continue;
          settled[index] = {
            result: buildWebContentResult(webResult, maxCharacters, query),
            status: { id: input.raw, status: 'success' },
          };
        }
      } catch (err) {
        getLogger().warn({ err, urlCount: webFallbackUrls.length }, 'Web content lookup failed');
      }
    }

    const results = settled
      .map((s) => s.result)
      .filter((r): r is UniversalSearchResult => r !== null);
    const statuses = settled.map((s) => s.status);

    return { results, statuses };
  }

  private async fetchContentForInput(
    input: { kind: 'url' | 'id'; raw: string },
    ctx: {
      collectionId: string;
      hostToSubdomain: Map<string, string>;
      syncedSubdomains: Set<string>;
      maxCharacters?: number;
      query?: string;
      refreshOnNotFound: boolean;
    }
  ): Promise<{ result: UniversalSearchResult | null; status: UniversalSearchContentStatus }> {
    const resolved = resolveContentInput(input, ctx.hostToSubdomain);
    if ('error' in resolved) {
      return { result: null, status: { id: input.raw, status: 'error', error: resolved.error } };
    }

    const { subdomain, wheres } = resolved;
    if (!ctx.syncedSubdomains.has(subdomain)) {
      return {
        result: null,
        status: {
          id: input.raw,
          status: 'error',
          error: { tag: 'not_synced', httpStatusCode: null },
        },
      };
    }

    let page: Awaited<ReturnType<ChromaRepository['getAllRecords']>> | null = null;
    try {
      const [firstWhere, ...remainingWheres] = wheres;
      if (firstWhere === undefined) {
        return {
          result: null,
          status: {
            id: input.raw,
            status: 'error',
            error: { tag: 'not_found', httpStatusCode: 404 },
          },
        };
      }
      const lookupWhere =
        remainingWheres.length === 0 ? firstWhere : { $or: [firstWhere, ...remainingWheres] };
      const candidate = await this.chromaRepository.getAllRecords(ctx.collectionId, {
        where: { $and: [lookupWhere, PUBLIC_TAG_WHERE] },
        include: [IncludeEnum.documents, IncludeEnum.metadatas],
      });
      if (candidate.ids.length > 0) {
        page = candidate;
      }
    } catch (err) {
      if (ctx.refreshOnNotFound && err instanceof ChromaNotFoundError) throw err;
      getLogger().warn({ err, subdomain }, 'Universal search contents lookup failed');
      return {
        result: null,
        status: {
          id: input.raw,
          status: 'error',
          error: { tag: 'fetch_error', httpStatusCode: 500 },
        },
      };
    }

    if (page === null) {
      return {
        result: null,
        status: {
          id: input.raw,
          status: 'error',
          error: { tag: 'not_found', httpStatusCode: 404 },
        },
      };
    }

    return {
      result: buildContentResult(subdomain, page, ctx.maxCharacters, ctx.query),
      status: { id: input.raw, status: 'success' },
    };
  }

  private async probeDenseDistances(args: {
    query: string;
    collectionId: string;
    includeSubdomains?: string[];
    excludeSubdomains?: string[];
  }): Promise<Map<string, number>> {
    const dense = await this.chromaRepository.embedDenseQuery(args.query);
    const where = buildFilters(
      undefined,
      { ensurePublicOnly: true },
      {
        includeSubdomains: args.includeSubdomains,
        excludeSubdomains: args.excludeSubdomains,
      }
    );
    const search = new Search()
      .rank(
        Knn({ query: dense, key: Key.EMBEDDING, limit: this.retrievalConfig.denseProbeKnnLimit })
      )
      .groupBy(new GroupBy([K('group_id')], Aggregate.minK([Key.SCORE], 1)))
      .limit(this.retrievalConfig.denseProbeGroupLimit)
      .select(Key.SCORE, K('group_id'));
    const result = await this.chromaRepository.search(
      args.collectionId,
      where ? search.where(where) : search
    );
    const distances = new Map<string, number>();
    for (const row of result.rows()[0] ?? []) {
      const groupId = row.metadata?.group_id;
      const score = row.score;
      if (typeof groupId === 'string' && typeof score === 'number' && !distances.has(groupId)) {
        distances.set(groupId, score);
      }
    }
    return distances;
  }

  private async runMintlifyLeg(args: {
    query: string;
    collectionName: string;
    collectionId: string | null;
    numResults: number;
    includeSubdomains?: string[];
    excludeSubdomains?: string[];
    contentMode: UniversalSearchContentMode;
    refreshOnNotFound?: boolean;
  }): Promise<LegOutcome<SearchResult>> {
    const start = Date.now();
    let collectionId = args.collectionId;
    const pageSize = Math.max(
      args.numResults * this.retrievalConfig.candidateMultiplier,
      this.retrievalConfig.minimumCandidatePool
    );
    try {
      if (collectionId === null) {
        collectionId = await this.resolveCollectionId(args.collectionName);
      }
      const gated =
        this.retrievalConfig.relevanceGateEnabled &&
        args.includeSubdomains === undefined &&
        args.query.trim().split(/\s+/).length >= RELEVANCE_GATE_MIN_WORDS;
      const [results, distances] = await Promise.all([
        this.searchService.search({
          body: { query: args.query, pageSize },
          collectionId,
          engine: this.retrievalConfig.engine,
          schemaVersion: 'v3',
          authContext: { ensurePublicOnly: true },
          lightweightSelect: args.contentMode === 'page',
          includeMarkdown: args.contentMode === 'page',
          domainFilter: {
            includeSubdomains: args.includeSubdomains,
            excludeSubdomains: args.excludeSubdomains,
          },
        }),
        gated
          ? this.probeDenseDistances({
              query: args.query,
              collectionId,
              includeSubdomains: args.includeSubdomains,
              excludeSubdomains: args.excludeSubdomains,
            }).catch((err) => {
              getLogger().warn({ err }, 'Universal search dense relevance probe failed');
              return null;
            })
          : Promise.resolve(null),
      ]);
      if (distances === null) {
        return { results, latencyMs: Date.now() - start, ok: true, collectionId };
      }
      const best = Math.min(...distances.values());
      if (distances.size === 0 || best > this.retrievalConfig.denseLegKillDistance) {
        getLogger().info(
          {
            queryCharacters: args.query.length,
            queryWords: args.query.trim() === '' ? 0 : args.query.trim().split(/\s+/).length,
            bestDenseDistance: distances.size ? best : null,
          },
          'Universal search Mintlify leg suppressed: no relevant corpus coverage'
        );
        return { results: [], latencyMs: Date.now() - start, ok: true, collectionId };
      }
      const filtered = results.filter((result) => {
        const groupId = result.metadata.groupId;
        if (typeof groupId !== 'string') return true;
        const distance = distances.get(groupId);
        return distance !== undefined && distance <= this.retrievalConfig.denseResultDistance;
      });
      return { results: filtered, latencyMs: Date.now() - start, ok: true, collectionId };
    } catch (err) {
      if (err instanceof ChromaNotFoundError && args.refreshOnNotFound !== false) {
        this.collectionIdCache.delete(args.collectionName);
        try {
          const active = await this.getActiveManifest(true);
          if (
            active !== null &&
            (active.collectionName !== args.collectionName ||
              active.collectionId !== args.collectionId)
          ) {
            const retried = await this.runMintlifyLeg({
              ...args,
              collectionName: active.collectionName,
              collectionId: active.collectionId ?? null,
              refreshOnNotFound: false,
            });
            return { ...retried, latencyMs: Date.now() - start };
          }
        } catch (refreshError) {
          getLogger().warn(
            { err: refreshError },
            'Universal search active manifest refresh failed'
          );
        }
      }
      getLogger().warn({ err }, 'Universal search Mintlify leg failed');
      return {
        results: [],
        latencyMs: Date.now() - start,
        ok: false,
        collectionId: collectionId ?? undefined,
      };
    }
  }

  private async runWebLeg(args: {
    query: string;
    numResults: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    maxCharacters?: number;
    searchType?: 'auto' | 'fast';
    livecrawl?: 'fallback' | 'never';
  }): Promise<LegOutcome<WebSearchProviderResult>> {
    const start = Date.now();
    try {
      const results = await this.webSearchProvider.search(args.query, {
        numResults: args.numResults,
        includeDomains: args.includeDomains,
        excludeDomains: args.excludeDomains,
        maxCharacters: args.maxCharacters,
        searchType: args.searchType,
        livecrawl: args.livecrawl,
      });
      return { results, latencyMs: Date.now() - start, ok: true };
    } catch (err) {
      getLogger().warn({ err }, 'Universal search web leg failed, degrading to Mintlify-only');
      return { results: [], latencyMs: Date.now() - start, ok: false };
    }
  }
}

function buildWebContentResult(
  result: WebSearchProviderResult,
  maxCharacters?: number,
  query?: string
): UniversalSearchResult {
  const text =
    maxCharacters === undefined
      ? result.text
      : query === undefined
        ? truncateMarkdownToCharacters(result.text, maxCharacters)
        : selectRelevantWindow(result.text, query, maxCharacters);
  const host = hostname(result.url);
  return {
    id: result.url,
    url: result.url,
    title: result.title,
    text,
    truncated: result.truncated === true || text.length < result.text.length,
    score: 0,
    source: 'web',
    siteName: host ?? '',
    breadcrumbs: [],
    publishedDate: result.publishedDate ?? null,
  };
}

type ContentError = { tag: string; httpStatusCode: number | null };
type ResolvedContentInput = { subdomain: string; wheres: Where[] } | { error: ContentError };

function resolveContentInput(
  input: { kind: 'url' | 'id'; raw: string },
  hostToSubdomain: Map<string, string>
): ResolvedContentInput {
  if (input.kind === 'id') {
    const separatorIndex = input.raw.indexOf(':');
    if (separatorIndex <= 0) {
      return { error: { tag: 'invalid_id', httpStatusCode: 400 } };
    }
    return { subdomain: input.raw.slice(0, separatorIndex), wheres: [{ group_id: input.raw }] };
  }

  let parsed: URL;
  try {
    parsed = new URL(input.raw);
  } catch {
    return { error: { tag: 'invalid_url', httpStatusCode: 400 } };
  }

  const host = normalizeHost(parsed.hostname);
  const subdomain = isMintlifyAppHost(host)
    ? host.slice(0, -MINTLIFY_APP_SUFFIX.length)
    : hostToSubdomain.get(host);

  if (subdomain === undefined || subdomain === '') {
    return { error: { tag: 'not_synced', httpStatusCode: null } };
  }

  let slug: string;
  try {
    slug = decodeURIComponent(parsed.pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return { error: { tag: 'invalid_url', httpStatusCode: 400 } };
  }

  const pathPart = parsed.pathname.replace(/\/+$/, '');
  const bareHost = parsed.hostname.replace(/^www\./i, '');
  const urlWheres: Where[] = [bareHost, `www.${bareHost}`].map((h) => {
    const conjuncts: Where[] = [{ subdomain }, { url: `${parsed.protocol}//${h}${pathPart}` }];
    return { $and: conjuncts };
  });
  return {
    subdomain,
    wheres: [...urlWheres, { group_id: `${subdomain}:${slug}` }],
  };
}

function buildContentResult(
  subdomain: string,
  page: { metadatas: (Metadata | null)[]; documents: (string | null)[] },
  maxCharacters?: number,
  query?: string
): UniversalSearchResult {
  const meta: Metadata = page.metadatas.find((m): m is Metadata => m !== null) ?? {};
  const rawBreadcrumbs = parseMetadataValue(meta.breadcrumbs);
  const breadcrumbs = Array.isArray(rawBreadcrumbs) ? rawBreadcrumbs.map(String) : [];

  const available = page.metadatas
    .map((metadata, index) => {
      const rawChunkIndex = metadata?.chunk_index;
      const parsedChunkIndex =
        rawChunkIndex === undefined || rawChunkIndex === null
          ? Number.NaN
          : Number.parseInt(String(rawChunkIndex), 10);
      return {
        document: stripDocumentFrontmatter(page.documents[index] ?? ''),
        chunkIndex: Number.isNaN(parsedChunkIndex) ? index : parsedChunkIndex,
      };
    })
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .map(({ document }) => document)
    .filter((document) => document !== '')
    .join('\n\n');
  let text = available;
  if (maxCharacters !== undefined) {
    text =
      query !== undefined
        ? selectRelevantWindow(available, query, maxCharacters)
        : truncateMarkdownToCharacters(available, maxCharacters);
  }

  return {
    id: typeof meta.group_id === 'string' ? meta.group_id : '',
    url: typeof meta.url === 'string' ? meta.url : '',
    title: typeof meta.title === 'string' ? meta.title : '',
    text,
    truncated: text.length < available.length,
    totalCharacters: available.length,
    score: 0,
    source: 'mintlify',
    siteName: subdomain,
    breadcrumbs,
    publishedDate: null,
  };
}
