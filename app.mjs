import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPostingAccess } from './forum-access.mjs';
import { listing, thread, compose, problem } from './forum-views.mjs';

const html = 'text/html; charset=utf-8';
const xml = 'application/xml; charset=utf-8';
const asset = name => readFileSync(new URL('./public/' + name, import.meta.url));
const assets = new Map([
  ['/assets/forum.css', ['text/css; charset=utf-8', asset('forum.css')]],
  ['/assets/favicon.svg', ['image/svg+xml', asset('favicon.svg')]],
]);
const error = (status, message) => Object.assign(new Error(message), { status });
const newNonce = () => randomBytes(18).toString('hex');

function pageNumber(value) {
  if (value === null) return 1;
  if (!/^[1-9]\d{0,6}$/.test(value)) throw error(404, 'This page does not exist.');
  return Number(value);
}

async function readFields(request) {
  if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw error(415, 'Please use a forum form.');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > 96 * 1024) {
      request.resume();
      throw error(413, 'This message is too large.');
    }
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const names = [...fields.keys()];
  if (new Set(names).size !== names.length) throw error(400, 'The form contains a duplicate field.');
  return fields;
}

export function createForumServer({ store, origin: configuredOrigin, secretPath, seo = {} }) {
  const url = new URL(configuredOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP or HTTPS origin.');
  }
  const origin = url.origin;
  const access = createPostingAccess({ origin, secretPath });
  return createServer({ requestTimeout: 20000, headersTimeout: 15000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    function privateResponse() {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    function send(status, type, body) {
      res.writeHead(status, { 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : body);
    }
    function redirect(location, status = 303) {
      res.writeHead(status, { Location: location });
      res.end();
    }
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw error(400, 'Invalid URL.');
      const { pathname: path, searchParams } = new URL(req.url, origin);
      if (req.headers.host?.toLowerCase() === 'www.' + url.host) return redirect(origin + req.url, 308);
      const get = req.method === 'GET' || req.method === 'HEAD';
      if (!get && req.method !== 'POST') throw error(405, 'This method is unavailable.');
      if (path === '/report' || path === '/archive') throw error(410, 'The former journal is closed.');
      if (get && assets.has(path)) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        return send(200, ...assets.get(path));
      }
      if (get && path === '/robots.txt') {
        return send(200, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n\nSitemap: ' + origin + '/sitemap.xml\n');
      }
      if (get && path === '/sitemap.xml') {
        const parts = searchParams.getAll('part');
        if (parts.length > 1 || (parts.length && !/^[1-9]\d{0,10}$/.test(parts[0]))) throw error(404, 'Sitemap not found.');
        const sitemap = store.sitemap(parts.length ? Number(parts[0]) : null);
        if (!sitemap) throw error(404, 'Sitemap not found.');
        const base = origin.replaceAll('&', '&amp;');
        const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
        const namespace = ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        if (sitemap.parts) {
          const nodes = sitemap.parts.map(part => '<sitemap><loc>' + base + '/sitemap.xml?part=' + part + '</loc></sitemap>');
          return send(200, xml, declaration + '<sitemapindex' + namespace + nodes.join('') + '</sitemapindex>');
        }
        const nodes = [];
        if (sitemap.includeHome) {
          const lastmod = sitemap.homeLastmod ? '<lastmod>' + sitemap.homeLastmod + '</lastmod>' : '';
          nodes.push('<url><loc>' + base + '/</loc>' + lastmod + '</url>');
        }
        for (const row of sitemap.topics) {
          nodes.push('<url><loc>' + base + '/topics/' + row.id + '</loc><lastmod>' + row.last_activity + '</lastmod></url>');
        }
        return send(200, xml, declaration + '<urlset' + namespace + nodes.join('') + '</urlset>');
      }
      if (get && path === '/') {
        const page = pageNumber(searchParams.get('page'));
        const result = store.listTopics(page);
        if (page > 1 && !result.topics.length) throw error(404, 'This page does not exist.');
        return send(200, html, listing({ origin, ...result, page, seo }));
      }
      const topicRoute = path.match(/^\/topics\/([1-9]\d{0,14})(?:\/(reply|replies))?$/);
      const id = topicRoute && Number(topicRoute[1]);
      if (get && topicRoute && !topicRoute[2]) {
        const page = pageNumber(searchParams.get('page'));
        const result = store.getTopic(id, page);
        if (!result || (page > 1 && !result.replies.length)) throw error(404, 'This discussion could not be found.');
        return send(200, html, thread({ origin, ...result, page }));
      }

      privateResponse();
      if (!get) {
        const sender = req.headers.origin;
        if (req.headers['sec-fetch-site'] === 'cross-site' || (sender && sender !== origin)) {
          throw error(403, 'Open this forum directly to submit the form.');
        }
      }

      const isForm = path === '/new' || topicRoute?.[2] === 'reply';
      const isSubmission = path === '/topics' || topicRoute?.[2] === 'replies';
      if (!((get && isForm) || (!get && isSubmission))) throw error(404, 'This page could not be found.');
      const topic = id ? store.getTopic(id, 1)?.topic : null;
      if (id && !topic) throw error(404, 'This discussion could not be found.');
      if (get) {
        const csrf = access.formCsrf(req, res);
        return send(200, html, compose({ origin, topic, csrf, nonce: newNonce() }));
      }
      const fields = await readFields(req);
      const csrf = fields.get('csrf');
      const key = access.authorize(req, csrf);
      const values = Object.fromEntries(['nickname', 'title', 'body'].map(name => [name, fields.get(name) || '']));
      const nonce = fields.get('nonce');
      if (!/^[a-f0-9]{36}$/.test(nonce || '')) throw error(400, 'Reopen the form and try again.');
      try {
        if (!topic) return redirect('/topics/' + store.createTopic({ ...values, nonce, key }));
        const reply = store.addReply(id, { ...values, nonce, key });
        const page = store.replyPage(reply);
        return redirect('/topics/' + id + (page > 1 ? '?page=' + page : '') + '#reply-' + reply);
      } catch (err) {
        if (err.status !== 400) throw err;
        return send(400, html, compose({ origin, topic, csrf, nonce, values, error: err.message }));
      }
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('Forum request failed:', err.code || err.name);
      privateResponse();
      return send(status, html, problem({ origin, status, message: status === 500 ? 'The forum is temporarily unavailable.' : err.message }));
    }
  });
}
