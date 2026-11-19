# Distant Refuge

A public forum where visitors can start topics and reply under a nickname or as Anonymous.

## Running the forum

Use Node.js 22.22.3 or later. From the repository root, create a private configuration and start the server.

```sh
install -m 600 .env.example .env
npm start
```

The example runs locally on port 3000. For production, set `PUBLIC_ORIGIN` to the site's public HTTPS origin, `FORUM_DB_PATH` to the persistent database path, and `HOST` and `PORT` to the address and port used by the reverse proxy. Keep the database and its adjacent session key across deployments. Git ignores `.env`. The PM2 configuration in `deploy/ecosystem.config.cjs` loads this file from the repository root.

The Nginx renderer reads the same settings. To preview a standalone HTTPS virtual host, run `node --env-file=.env deploy/nginx/render.mjs distant-refuge.conf`. For a shared virtual host, render `forum-proxy.inc` and `forum-locations.inc` individually. The renderer writes to standard output. Set `TLS_CERT_PATH` and `TLS_KEY_PATH` only when the certificate files use custom paths.

## Search and discovery

The homepage, topics and reply pages have canonical URLs based on `PUBLIC_ORIGIN`. Published topics appear in `/sitemap.xml`, which search engines can discover through `/robots.txt`. Linked pagination lets crawlers reach older discussions and later replies. The public HTML in `forum-views.mjs` describes each thread and its visible replies with Schema.org microdata. Posting forms and error responses request exclusion from search results.

| Optional setting in the private `.env` | What to enter |
| --- | --- |
| `SITE_DESCRIPTION` | A short introduction explaining who the forum is for and what people discuss. The homepage displays it and uses it as its search description. A built-in introduction is used when empty. |
| `GOOGLE_SITE_VERIFICATION` | The content value of the HTML verification tag for a Google Search Console URL-prefix property. |
| `BING_SITE_VERIFICATION` | The content value of the HTML verification tag for Bing Webmaster Tools. |

Restart the forum after editing the file. To monitor indexing, confirm ownership in each search service and submit the site's `/sitemap.xml` there. Search engine verification tags are public on the homepage once configured. Thread titles, snippets, authors and replies come from actual posts.

Run `npm test` to check the forum, search markup and deployment templates.
