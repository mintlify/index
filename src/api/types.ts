import type { z } from 'zod';

import type {
  universalSearchContentStatusSchema,
  universalSearchContentsResponseSchema,
  universalSearchContextResponseSchema,
  universalSearchErrorResponseSchema,
  universalSearchResultSchema,
  universalSearchSearchResponseSchema,
} from './validator.js';

export type UniversalSearchResult = z.infer<typeof universalSearchResultSchema>;
export type UniversalSearchSearchResponse = z.infer<typeof universalSearchSearchResponseSchema>;
export type UniversalSearchContentStatus = z.infer<typeof universalSearchContentStatusSchema>;
export type UniversalSearchContentsResponse = z.infer<typeof universalSearchContentsResponseSchema>;
export type UniversalSearchContextResponse = z.infer<typeof universalSearchContextResponseSchema>;
export type UniversalSearchErrorResponse = z.infer<typeof universalSearchErrorResponseSchema>;
