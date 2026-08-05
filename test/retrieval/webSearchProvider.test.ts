import { describe, expect, it, vi } from 'vitest';

import type { ExaService, WebSearchResult } from '../../src/internal/exaService.js';
import {
  ExaWebSearchProvider,
  WebSearchTimeoutError,
} from '../../src/retrieval/webSearchProvider.js';

function createFakeExaService(
  searchWebFull: ReturnType<typeof vi.fn>,
  getWebContents: ReturnType<typeof vi.fn> = vi.fn()
) {
  return { searchWebFull, getWebContents } as unknown as ExaService;
}

describe('ExaWebSearchProvider', () => {
  it('maps WebSearchResult to WebSearchProviderResult', async () => {
    const results: WebSearchResult[] = [
      {
        url: 'https://a.com',
        metadata: { title: 'A', publishedDate: '2024-01-01' },
        content: 'body',
      },
      { url: 'https://b.com', metadata: { title: 'B' }, content: undefined },
    ];
    const searchWebFull = vi.fn().mockResolvedValue(results);
    const provider = new ExaWebSearchProvider(createFakeExaService(searchWebFull));

    const mapped = await provider.search('query');

    expect(mapped).toEqual([
      { url: 'https://a.com', title: 'A', text: 'body', publishedDate: '2024-01-01' },
      { url: 'https://b.com', title: 'B', text: '', publishedDate: undefined },
    ]);
  });

  it('forwards options and always sets rethrowErrors', async () => {
    const searchWebFull = vi.fn().mockResolvedValue([]);
    const provider = new ExaWebSearchProvider(createFakeExaService(searchWebFull));

    await provider.search('query', {
      includeDomains: ['example.com'],
      excludeDomains: ['spam.com'],
      maxCharacters: 1234,
      numResults: 5,
    });

    expect(searchWebFull).toHaveBeenCalledWith('query', ['example.com'], {
      numResults: 5,
      excludeDomains: ['spam.com'],
      maxCharacters: 1234,
      rethrowErrors: true,
    });
  });

  it('defaults includeDomains to an empty array', async () => {
    const searchWebFull = vi.fn().mockResolvedValue([]);
    const provider = new ExaWebSearchProvider(createFakeExaService(searchWebFull));

    await provider.search('query');

    expect(searchWebFull).toHaveBeenCalledWith(
      'query',
      [],
      expect.objectContaining({ rethrowErrors: true })
    );
  });

  it('rejects with WebSearchTimeoutError when the search hangs past the timeout', async () => {
    vi.useFakeTimers();
    const searchWebFull = vi.fn().mockReturnValue(new Promise<WebSearchResult[]>(() => {}));
    const provider = new ExaWebSearchProvider(createFakeExaService(searchWebFull), 100);

    const promise = provider.search('query');
    const assertion = expect(promise).rejects.toBeInstanceOf(WebSearchTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    vi.useRealTimers();
  });

  it('propagates a rejection from the underlying search', async () => {
    const error = new Error('boom');
    const searchWebFull = vi.fn().mockRejectedValue(error);
    const provider = new ExaWebSearchProvider(createFakeExaService(searchWebFull));

    await expect(provider.search('query')).rejects.toBe(error);
  });

  it('retrieves and maps exact URL contents', async () => {
    const getWebContents = vi.fn().mockResolvedValue([
      {
        url: 'https://example.com/guide',
        metadata: { title: 'Guide' },
        content: 'Full guide',
      },
    ]);
    const provider = new ExaWebSearchProvider(createFakeExaService(vi.fn(), getWebContents));

    const results = await provider.getContents(['https://example.com/guide'], {
      maxCharacters: 4_000,
      livecrawl: 'never',
    });

    expect(results).toEqual([
      {
        url: 'https://example.com/guide',
        title: 'Guide',
        text: 'Full guide',
        publishedDate: undefined,
      },
    ]);
    expect(getWebContents).toHaveBeenCalledWith(['https://example.com/guide'], {
      maxCharacters: 4_000,
      rethrowErrors: true,
      livecrawl: 'never',
    });
  });

  it('marks exact URL contents truncated when they reach the provider cap', async () => {
    const getWebContents = vi.fn().mockResolvedValue([
      {
        url: 'https://example.com/guide',
        metadata: { title: 'Guide' },
        content: 'Full guide',
      },
    ]);
    const provider = new ExaWebSearchProvider(createFakeExaService(vi.fn(), getWebContents));

    const results = await provider.getContents(['https://example.com/guide'], {
      maxCharacters: 10,
    });

    expect(results[0]?.truncated).toBe(true);
  });

  it('rejects immediately without calling searchWebFull when the signal is already aborted', async () => {
    const searchWebFull = vi.fn();
    const provider = new ExaWebSearchProvider(createFakeExaService(searchWebFull));
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    await expect(provider.search('query', { signal: controller.signal })).rejects.toThrow(
      'pre-aborted'
    );
    expect(searchWebFull).not.toHaveBeenCalled();
  });

  it('rejects with the abort reason when aborted mid-flight', async () => {
    const searchWebFull = vi.fn().mockReturnValue(new Promise<WebSearchResult[]>(() => {}));
    const provider = new ExaWebSearchProvider(createFakeExaService(searchWebFull));
    const controller = new AbortController();

    const promise = provider.search('query', { signal: controller.signal });
    controller.abort(new Error('mid-flight abort'));

    await expect(promise).rejects.toThrow('mid-flight abort');
  });
});
