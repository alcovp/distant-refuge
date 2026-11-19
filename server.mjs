import { dirname, join, resolve } from 'node:path';
import { createForumServer } from './app.mjs';
import { openForum } from './forum-store.mjs';

if (process.env.NODE_ENV === 'production' && (!process.env.PUBLIC_ORIGIN || !process.env.FORUM_DB_PATH)) {
  throw new Error('Set PUBLIC_ORIGIN and FORUM_DB_PATH in the production environment.');
}
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const origin = process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:' + port;
const dbPath = resolve(process.env.FORUM_DB_PATH || './var/forum.sqlite');
const store = openForum(dbPath);
const secretPath = join(dirname(dbPath), 'forum-session.key');
const seo = {
  description: process.env.SITE_DESCRIPTION,
  googleVerification: process.env.GOOGLE_SITE_VERIFICATION,
  bingVerification: process.env.BING_SITE_VERIFICATION,
};
const server = createForumServer({ store, origin, secretPath, seo });
server.listen(port, host, () => console.log('Distant Refuge forum listening on ' + host + ':' + port));
const stop = () => server.close(() => { store.close(); process.exit(0); });
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
