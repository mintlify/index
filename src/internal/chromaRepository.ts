// In production this is backed by Chroma Cloud, storing the hybrid
// (BM25 + dense) search index over the Mintlify-hosted docs corpus.

import type {
  Collection,
  GetResult,
  IncludeEnum,
  Metadata,
  SearchLike,
  SearchResult,
  Where,
} from 'chromadb';

export interface ChromaRepository {
  getCollectionByName(name: string): Promise<Collection>;

  embedDenseQuery(text: string): Promise<number[]>;

  get(
    collectionId: string,
    args: {
      ids?: string[];
      where?: Where;
      include?: IncludeEnum[];
      limit?: number;
      offset?: number;
    }
  ): Promise<GetResult>;

  getAllRecords(
    collectionId: string,
    args: {
      where?: Where;
      include?: IncludeEnum[];
      pageSize?: number;
    }
  ): Promise<{
    ids: string[];
    documents: (string | null)[];
    metadatas: (Metadata | null)[];
    embeddings: number[][];
  }>;

  search(collectionId: string, searches: SearchLike | SearchLike[]): Promise<SearchResult>;
}
