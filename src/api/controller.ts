import { Request, Response } from 'express';

import UniversalSearchService from '../retrieval/engine.js';
import {
  runUniversalSearchContents,
  runUniversalSearchContext,
  runUniversalSearchSearch,
} from '../retrieval/operations.js';
import type {
  UniversalSearchContentsResponse,
  UniversalSearchContextResponse,
  UniversalSearchErrorResponse,
  UniversalSearchSearchResponse,
} from './types.js';
import { getLogger } from '../internal/logger.js';
import {
  universalSearchContentsBodySchema,
  universalSearchContextBodySchema,
  universalSearchSearchBodySchema,
} from './validator.js';

export class UniversalSearchController {
  constructor(private readonly universalSearchService: UniversalSearchService) {}

  async context(
    req: Request,
    res: Response<UniversalSearchContextResponse | UniversalSearchErrorResponse>
  ) {
    const parseResult = universalSearchContextBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    try {
      const result = await runUniversalSearchContext(this.universalSearchService, parseResult.data);
      res.locals.universalSearchUsage = result.usage;
      return res.status(200).json(result.response);
    } catch (err) {
      getLogger().error({ err }, 'Universal search context request failed');
      return res.status(500).json({ error: 'Error building context' });
    }
  }

  async search(
    req: Request,
    res: Response<UniversalSearchSearchResponse | UniversalSearchErrorResponse>
  ) {
    const parseResult = universalSearchSearchBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    try {
      const result = await runUniversalSearchSearch(this.universalSearchService, parseResult.data);
      res.locals.universalSearchUsage = result.usage;
      return res.status(200).json(result.response);
    } catch (err) {
      getLogger().error({ err }, 'Universal search request failed');
      return res.status(500).json({ error: 'Error searching' });
    }
  }

  async contents(
    req: Request,
    res: Response<UniversalSearchContentsResponse | UniversalSearchErrorResponse>
  ) {
    const parseResult = universalSearchContentsBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const result = await runUniversalSearchContents(this.universalSearchService, parseResult.data);
    res.locals.universalSearchUsage = result.usage;
    return res.status(200).json(result.response);
  }
}
