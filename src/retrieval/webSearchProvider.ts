import { withTimeout } from '../internal/withTimeout.js';
import { ExaService, WebSearchResult } from '../internal/exaService.js';

export type WebSearchProviderResult = {
  url: string;
  title: string;
  text: string;
  publishedDate?: string;
  truncated?: boolean;
};

export type WebSearchProviderOptions = {
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxCharacters?: number;
  signal?: AbortSignal;
  searchType?: 'auto' | 'fast';
  livecrawl?: 'fallback' | 'never';
};

export type WebContentsProviderOptions = {
  maxCharacters?: number;
  livecrawl?: 'fallback' | 'never';
};

export interface WebSearchProvider {
  search(query: string, options?: WebSearchProviderOptions): Promise<WebSearchProviderResult[]>;
  getContents?(
    urls: string[],
    options?: WebContentsProviderOptions
  ): Promise<WebSearchProviderResult[]>;
}

export class WebSearchTimeoutError extends Error {
  constructor(ms: number) {
    super(`Web search timed out after ${ms}ms`);
    this.name = 'WebSearchTimeoutError';
  }
}

export const WEB_SEARCH_TIMEOUT_MS = 8000;

function toProviderResult(result: WebSearchResult): WebSearchProviderResult {
  return {
    url: result.url,
    title: result.metadata.title,
    text: result.content ?? '',
    publishedDate: result.metadata.publishedDate,
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let cleanup: () => void = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup = () => signal.removeEventListener('abort', onAbort);
  });
  return Promise.race([promise, abortPromise]).finally(cleanup);
}

export class ExaWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly exaService: ExaService,
    private readonly timeoutMs: number = WEB_SEARCH_TIMEOUT_MS
  ) {}

  async search(
    query: string,
    options?: WebSearchProviderOptions
  ): Promise<WebSearchProviderResult[]> {
    const signal = options?.signal;

    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

    const searchPromise = this.exaService.searchWebFull(query, options?.includeDomains ?? [], {
      numResults: options?.numResults,
      excludeDomains: options?.excludeDomains,
      maxCharacters: options?.maxCharacters,
      rethrowErrors: true,
      searchType: options?.searchType,
      livecrawl: options?.livecrawl,
    });

    const timedPromise = withTimeout(
      searchPromise,
      this.timeoutMs,
      (ms) => new WebSearchTimeoutError(ms)
    );

    const results = await (signal ? raceAbort(timedPromise, signal) : timedPromise);

    return results.map(toProviderResult);
  }

  async getContents(
    urls: string[],
    options?: WebContentsProviderOptions
  ): Promise<WebSearchProviderResult[]> {
    const contentsPromise = this.exaService.getWebContents(urls, {
      maxCharacters: options?.maxCharacters,
      rethrowErrors: true,
      livecrawl: options?.livecrawl,
    });
    const results = await withTimeout(
      contentsPromise,
      this.timeoutMs,
      (ms) => new WebSearchTimeoutError(ms)
    );
    return results.map((result) => {
      const mapped = toProviderResult(result);
      return options?.maxCharacters !== undefined && mapped.text.length >= options.maxCharacters
        ? { ...mapped, truncated: true }
        : mapped;
    });
  }
}
