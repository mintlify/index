import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const maxCharactersSchema = z.number().int().positive();
const MAX_CONTENTS_INPUTS = 20;
export const UNIVERSAL_SEARCH_CONTEXT_DEFAULT_TOKEN_BUDGET = 3_000;
export const UNIVERSAL_SEARCH_CONTEXT_MAX_TOKEN_BUDGET = 6_000;

export const universalSearchSearchBodySchema = z
  .object({
    query: nonEmptyString,
    numResults: z.number().int().positive().max(20),
    text: z
      .union([
        z.boolean(),
        z
          .object({
            maxCharacters: maxCharactersSchema,
          })
          .strict(),
      ])
      .optional(),
    includeDomains: z.array(nonEmptyString).min(1).optional(),
    excludeDomains: z.array(nonEmptyString).min(1).optional(),
  })
  .strict();

export const universalSearchContentsBodySchema = z
  .object({
    urls: z.array(z.string().url()).min(1).max(MAX_CONTENTS_INPUTS).optional(),
    ids: z.array(nonEmptyString).min(1).max(MAX_CONTENTS_INPUTS).optional(),
    maxCharacters: maxCharactersSchema.optional(),
    query: nonEmptyString.optional(),
  })
  .strict()
  .refine(({ urls, ids }) => urls !== undefined || ids !== undefined, {
    message: 'At least one of urls or ids is required',
  })
  .refine(({ urls, ids }) => (urls?.length ?? 0) + (ids?.length ?? 0) <= MAX_CONTENTS_INPUTS, {
    message: `A request may reference at most ${MAX_CONTENTS_INPUTS} items across urls and ids`,
  });

export const universalSearchContextBodySchema = z
  .object({
    query: nonEmptyString,
    product: nonEmptyString.optional(),
    format: z.enum(['txt', 'json']),
    includeDomains: z.array(nonEmptyString).min(1).optional(),
    excludeDomains: z.array(nonEmptyString).min(1).optional(),
    tokenBudget: z
      .number()
      .int()
      .positive()
      .max(UNIVERSAL_SEARCH_CONTEXT_MAX_TOKEN_BUDGET)
      .default(UNIVERSAL_SEARCH_CONTEXT_DEFAULT_TOKEN_BUDGET),
  })
  .strict();

export const universalSearchResultSchema = z
  .object({
    id: z.string(),
    url: z.string().url(),
    title: z.string(),
    text: z.string(),
    truncated: z.boolean().optional(),
    totalCharacters: z.number().int().nonnegative().optional(),
    score: z.number(),
    source: z.enum(['mintlify', 'web']),
    siteName: z.string(),
    breadcrumbs: z.array(z.string()),
    publishedDate: z.string().datetime().nullable(),
  })
  .strict();

export const universalSearchSearchResponseSchema = z
  .object({
    requestId: z.string(),
    results: z.array(universalSearchResultSchema),
  })
  .strict();

export const universalSearchContentStatusSchema = z.discriminatedUnion('status', [
  z
    .object({
      id: z.string(),
      status: z.literal('success'),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      status: z.literal('error'),
      error: z
        .object({
          tag: z.string(),
          httpStatusCode: z.number().int().nullable(),
        })
        .strict(),
    })
    .strict(),
]);

export const universalSearchContentsResponseSchema = universalSearchSearchResponseSchema
  .extend({
    statuses: z.array(universalSearchContentStatusSchema),
  })
  .strict();

export const universalSearchContextResponseSchema = z
  .object({
    requestId: z.string(),
    query: z.string(),
    response: z.string(),
    resultsCount: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

export const universalSearchErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .strict();

export type UniversalSearchSearchBody = z.infer<typeof universalSearchSearchBodySchema>;
export type UniversalSearchContentsBody = z.infer<typeof universalSearchContentsBodySchema>;
export type UniversalSearchContextBody = z.infer<typeof universalSearchContextBodySchema>;
