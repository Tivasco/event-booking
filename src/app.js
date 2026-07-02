import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(publicDir));

  app.get('/', (req, res) => {
    res.send('Event booking platform — under construction.');
  });

  return app;
}
