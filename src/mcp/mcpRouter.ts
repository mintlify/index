import { Router } from 'express';

import { UniversalSearchMcpController } from './mcpController.js';

export function createUniversalSearchMcpRouter(controller: UniversalSearchMcpController): Router {
  const universalSearchMcpRouter = Router();

  universalSearchMcpRouter.post('/', controller.handleRequest.bind(controller));
  universalSearchMcpRouter.get('/', controller.handleRequest.bind(controller));
  universalSearchMcpRouter.delete('/', controller.handleRequest.bind(controller));

  return universalSearchMcpRouter;
}
