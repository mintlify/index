import { Exa } from 'exa-js';

import { getLogger } from './logger.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export type WebSearchResult = {
  url: string;
  metadata: {
    title: string;
    publishedDate?: string;
  };
  content?: string; // For full text search
  highlights?: string[]; // For snippet search
  summary?: string; // For ai summary search
};

export class ExaService {
  private exa: Exa;

  constructor() {
    this.exa = new Exa(requireEnv('EXA_API_KEY'));
  }

  async searchWebFull(
    query: string,
    sites: string[],
    options?: {
      numResults?: number;
      excludeDomains?: string[];
      maxCharacters?: number;
      rethrowErrors?: boolean;
      searchType?: 'auto' | 'fast';
      livecrawl?: 'fallback' | 'never';
    }
  ): Promise<WebSearchResult[]> {
    try {
      const exaSites = sites.map((site) =>
        site.startsWith('site:') ? site.replace('site:', '') : site
      );
      const startTime = new Date();
      const response = await this.exa.searchAndContents(query, {
        ...(exaSites.length > 0 && { includeDomains: exaSites }),
        ...(options?.excludeDomains &&
          options.excludeDomains.length > 0 && { excludeDomains: options.excludeDomains }),
        text: {
          maxCharacters: options?.maxCharacters ?? 6000,
        },
        numResults: options?.numResults ?? 4,
        livecrawl: options?.livecrawl ?? 'fallback',
        filterEmptyResults: false, // keep titles for context even when there's no content (likely due to js required for pageload)
        type: options?.searchType ?? 'auto',
      });

      getLogger().info(
        {
          exaDomains: exaSites,
          query,
          time: new Date().getTime() - startTime.getTime() + 'ms',
        },
        'Exa web search full results received'
      );

      return response.results.map((result) => ({
        url: result.url,
        metadata: {
          title: result.title || 'Untitled',
          publishedDate: result.publishedDate,
        },
        content: result.text || '',
      }));
    } catch (err) {
      getLogger().error({ err, query, sites }, 'Error performing web full text search with Exa');
      if (options?.rethrowErrors) {
        throw err;
      }
      return [];
    }
  }

  async getWebContents(
    urls: string[],
    options?: {
      maxCharacters?: number;
      rethrowErrors?: boolean;
      livecrawl?: 'fallback' | 'never';
    }
  ): Promise<WebSearchResult[]> {
    try {
      const response = await this.exa.getContents(urls, {
        text: { maxCharacters: options?.maxCharacters ?? 6000 },
        livecrawl: options?.livecrawl ?? 'fallback',
      });
      return response.results.map((result) => ({
        url: result.url,
        metadata: {
          title: result.title || 'Untitled',
          publishedDate: result.publishedDate,
        },
        content: result.text || '',
      }));
    } catch (err) {
      getLogger().error({ err, urls }, 'Error retrieving web contents with Exa');
      if (options?.rethrowErrors) {
        throw err;
      }
      return [];
    }
  }
}
