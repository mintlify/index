import { Router } from 'express';

import { UniversalSearchController } from './controller.js';

export function createUniversalSearchRouter(controller: UniversalSearchController): Router {
  const universalSearchV1Router = Router();

  universalSearchV1Router.post('/context', controller.context.bind(controller));
  universalSearchV1Router.post('/search', controller.search.bind(controller));
  universalSearchV1Router.post('/contents', controller.contents.bind(controller));

  return universalSearchV1Router;
}
