import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const renderer = fileURLToPath(new URL('../deploy/nginx/render.mjs', import.meta.url));
const run = (name, env) => spawnSync(process.execPath, [renderer, name], { env, encoding: 'utf8' });
const site = { PUBLIC_ORIGIN: 'https://forum.example' };

test('nginx deployment renders both site stages and the proxy snippet with the application settings', () => {
  const bootstrap = run('bootstrap.conf', site);
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /server_name forum\.example;/);
  assert.match(bootstrap.stdout, /try_files \$uri =404;/);

  const standard = run('distant-refuge.conf', site);
  assert.equal(standard.status, 0, standard.stderr);
  assert.match(standard.stdout, /ssl_certificate "\/etc\/letsencrypt\/live\/forum\.example\/fullchain\.pem";/);
  assert.match(standard.stdout, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);

  const env = {
    PUBLIC_ORIGIN: 'https://other.example:8443',
    HOST: '::1', PORT: '4190', TLS_CERT_PATH: '/tmp/test certs/fullchain.pem', TLS_KEY_PATH: '/tmp/test certs/key.pem',
  };
  const custom = run('distant-refuge.conf', env);
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /listen 8443 ssl;/);
  assert.match(custom.stdout, /return 308 https:\/\/other\.example:8443\$request_uri;/);
  assert.match(custom.stdout, /ssl_certificate "\/tmp\/test certs\/fullchain\.pem";/);
  assert.match(custom.stdout, /ssl_certificate_key "\/tmp\/test certs\/key\.pem";/);
  const snippet = run('forum-proxy.inc', env);
  assert.equal(snippet.status, 0, snippet.stderr);
  for (const config of [custom, snippet]) {
    assert.match(config.stdout, /proxy_pass http:\/\/\[::1\]:4190;/);
    assert.match(config.stdout, /proxy_set_header X-Real-IP \$remote_addr;/);
    assert.doesNotMatch(config.stdout, /\{\{/);
  }
});

test('nginx deployment reports missing or invalid private configuration without emitting a partial file', () => {
  for (const env of [
    {}, { PUBLIC_ORIGIN: 'http://forum.example' }, { PUBLIC_ORIGIN: 'https://forum.example/topic' },
    { ...site, HOST: 'app;other' }, { ...site, PORT: '65536' }, { ...site, TLS_KEY_PATH: '/bad/"path' },
  ]) {
    const result = run('distant-refuge.conf', env);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
