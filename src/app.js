import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerRoutes } from './routes.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');

/**
 * App factory: takes an open database and returns an Express app that has
 * not started listening — tests and the concurrency demo build their own
 * instances on their own databases and ports.
 */
export function createApp(db, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(publicDir));
  registerRoutes(app, db, options);
  return app;
}
