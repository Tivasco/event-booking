import { openDb } from './db.js';
import { createApp } from './app.js';

const db = openDb();
const port = Number(process.env.PORT ?? 3000);

createApp(db).listen(port, () => {
  console.log(`Seatwise running at http://localhost:${port} (database: ${db.name})`);
});
