// In production this is backed by SearchService, which executes hybrid/BM25
// search against Chroma Cloud over the Mintlify-hosted docs corpus.

import { K, type WhereExpression } from 'chromadb';

export type SearchEngine = 'bm25' | 'hybrid';

export interface SearchAuthContext {
  groups?: string[];
  ensurePublicOnly?: boolean;
}

export interface SearchResult {
  page: string;
  header: string;
  content: string;
  markdown?: string;
  metadata: {
    title: string;
    breadcrumbs: string[];
    icon: string | null;
    hash: string | null;
    openapi: string | null;
    groupId?: string;
    url?: string;
    subdomain?: string;
    chunkId?: string;
  };
  score: number;
  boostFactor?: number;
}

export type SearchQueryBody = {
  query: string;
  pageSize?: number;
  scoreThreshold?: number;
  filters?: {
    version?: string;
    language?: string;
    product?: string;
    tag?: string;
  };
};

function andAll(clauses: WhereExpression[]): WhereExpression | undefined {
  if (clauses.length === 0) return undefined;
  return clauses.reduce((acc, clause) => acc.and(clause));
}

export function buildFilters(
  filters?: SearchQueryBody['filters'],
  authContext?: SearchAuthContext,
  options?: {
    includeCode?: boolean;
    includeHidden?: boolean;
    unversioned?: boolean;
    includeSubdomains?: string[];
    excludeSubdomains?: string[];
    gatedOnly?: boolean;
  }
): WhereExpression | undefined {
  const clauses: WhereExpression[] = [];

  if (!options?.includeCode) {
    clauses.push(K('tags').notContains('code'));
  }

  if (!options?.includeHidden) {
    clauses.push(K('tags').notContains('HIDDEN'));
  }

  if (options?.includeSubdomains?.length) {
    clauses.push(K('subdomain').isIn(options.includeSubdomains));
  }

  if (options?.excludeSubdomains?.length) {
    clauses.push(K('subdomain').notIn(options.excludeSubdomains));
  }

  if (filters?.version && !options?.unversioned) {
    clauses.push(
      K('tags').contains(`VERSION:${filters.version}`).or(K('tags').contains(`VERSION:*`))
    );
  }

  if (filters?.language) {
    clauses.push(
      K('tags').contains(`LANGUAGE:${filters.language}`).or(K('tags').contains(`LANGUAGE:*`))
    );
  }

  if (filters?.product) {
    clauses.push(
      K('tags').contains(`PRODUCT:${filters.product}`).or(K('tags').contains(`PRODUCT:*`))
    );
  }

  if (filters?.tag) {
    clauses.push(K('tags').contains(filters.tag.toLowerCase()));
  }

  if (options?.gatedOnly) {
    if (authContext?.ensurePublicOnly) {
      clauses.push(K('tags').notContains('PUBLIC'));
    } else if (authContext?.groups) {
      const gatedClauses: WhereExpression[] = [
        K('tags').notContains('PUBLIC'),
        K('tags').notContains('USERAUTH:*'),
        ...authContext.groups.map((g) => K('tags').notContains(`USERAUTH:${g}`)),
      ];
      clauses.push(gatedClauses.reduce((acc, clause) => acc.and(clause)));
    }
  } else if (authContext?.ensurePublicOnly) {
    clauses.push(K('tags').contains('PUBLIC'));
  } else if (authContext?.groups) {
    const authOptions: WhereExpression[] = [
      K('tags').contains(`USERAUTH:*`),
      ...authContext.groups.map((g) => K('tags').contains(`USERAUTH:${g}`)),
    ];
    clauses.push(authOptions.reduce((acc, clause) => acc.or(clause), K('tags').contains('PUBLIC')));
  }

  return andAll(clauses);
}

export function parseMetadataValue(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

const FRONTMATTER_LABELS = ['Title', 'Breadcrumbs', 'Keywords', 'Section'];

export function stripDocumentFrontmatter(document: string): string {
  const separatorIndex = document.indexOf('\n\n');
  if (separatorIndex === -1) return document;

  const prefixLines = document.slice(0, separatorIndex).split('\n');
  const isFrontmatter =
    prefixLines.length > 0 &&
    prefixLines.every((line) => FRONTMATTER_LABELS.some((label) => line.startsWith(`${label}: `)));
  if (!isFrontmatter) return document;

  return document.slice(separatorIndex + 2);
}

export interface SearchService {
  search(params: {
    body: SearchQueryBody;
    collectionId: string;
    engine: SearchEngine;
    schemaVersion?: 'v1' | 'v2' | 'v3';
    authContext?: SearchAuthContext;
    defaultPageSize?: number;
    includeCode?: boolean;
    includeHidden?: boolean;
    includeMarkdown?: boolean;
    lightweightSelect?: boolean;
    unversioned?: boolean;
    domainFilter?: { includeSubdomains?: string[]; excludeSubdomains?: string[] };
  }): Promise<SearchResult[]>;
}

export default SearchService;
