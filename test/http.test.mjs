import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createForumServer } from '../app.mjs';
import { openForum } from '../forum-store.mjs';

const origin = 'https://forum.example';

async function fixture(t, { secretPath, dbPath = ':memory:' } = {}) {
  const store = openForum(dbPath);
  const server = createForumServer({ store, origin, secretPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function request(path, { cookie, data, headers = {}, ...options } = {}) {
    return fetch(base + path, {
      redirect: 'manual', method: data ? 'POST' : 'GET', ...options,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      body: data ? new URLSearchParams(data) : undefined,
    });
  }
  return { store, request };
}

function field(html, name) {
  const value = html.match(new RegExp('name="' + name + '" value="([^"]*)"'));
  assert.ok(value, 'expected field ' + name);
  return value[1];
}

function sessionCookie(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'expected a new session cookie');
  assert.match(value, /; HttpOnly/);
  assert.match(value, /; Secure/);
  assert.match(value, /; SameSite=/);
  assert.doesNotMatch(value, /max-age|expires/i);
  return value.split(';')[0];
}

function assertPrivate(response) {
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
}

async function composeForm(app, path, cookie) {
  const response = await app.request(path, { cookie });
  assert.equal(response.status, 200);
  assertPrivate(response);
  const html = await response.text();
  assert.match(html, /name="robots" content="noindex/);
  const action = html.match(/<form\b[^>]*\baction="([^"]+)"/);
  assert.ok(action, 'expected a posting form');
  const nickname = html.match(/<input\b[^>]*\bname="nickname"[^>]*>/);
  assert.ok(nickname, 'expected a nickname field');
  assert.doesNotMatch(nickname[0], /\brequired\b/);
  if (!cookie || response.headers.has('set-cookie')) cookie = sessionCookie(response);
  return {
    cookie, action: action[1],
    fields: { csrf: field(html, 'csrf'), nonce: field(html, 'nonce') },
  };
}

function seededTopic(store) {
  return store.createTopic({ key: 'fixture', nonce: 'seed', nickname: 'Robin', title: 'First visit', body: 'Our local park.' });
}

test('public pages and sitemap expose discussions while retired journal URLs and unknown pages stay private', async t => {
  const app = await fixture(t);
  const id = seededTopic(app.store);
  const paths = ['/', '/topics/' + id];
  for (const path of paths) {
    const response = await app.request(path + '?ref=outside');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    const html = await response.text();
    assert.ok(html.includes('rel="canonical" href="' + origin + path + '"'));
    assert.doesNotMatch(html, /name="robots" content="noindex/);
    const head = await app.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  const xml = await (await app.request('/sitemap.xml')).text();
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), paths.map(path => origin + path));
  assert.match(await (await app.request('/robots.txt')).text(), /Sitemap: https:\/\/forum\.example\/sitemap\.xml/);
  for (const path of ['/report', '/archive']) {
    for (const options of [{}, { data: { observation: 'retired' } }]) {
      const response = await app.request(path, options);
      assert.equal(response.status, 410);
      assertPrivate(response);
    }
  }
  for (const path of ['/absent', '/?page=2', '/topics/999']) {
    const response = await app.request(path);
    assert.equal(response.status, 404);
    assertPrivate(response);
  }
});

test('large sitemaps split at the URL limit and preserve topic ranges when a discussion is updated', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forum-sitemap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'forum.sqlite');
  const app = await fixture(t, { dbPath });
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  const stamp = '2020-01-01T00:00:00.000Z';
  db.prepare(`WITH RECURSIVE ids(id) AS (VALUES (1) UNION ALL SELECT id + 1 FROM ids WHERE id < 49999)
    INSERT INTO topics (id, nickname, title, body, created_at, last_activity)
    SELECT id, 'Visitor', 'A topic', 'A message', ?, ? FROM ids`).run(stamp, stamp);
  const root = '/sitemap.xml';
  const small = await (await app.request(root)).text();
  assert.equal([...small.matchAll(/<url>/g)].length, 50000);
  assert.ok(small.includes('<loc>' + origin + '/</loc><lastmod>' + stamp + '</lastmod>'));
  assert.equal((await app.request(root + '?part=1')).status, 404);

  const insert = db.prepare(`INSERT INTO topics (id, nickname, title, body, created_at, last_activity)
    VALUES (?, 'Guest', 'Another topic', 'Another message', ?, ?)`);
  insert.run(50000, stamp, stamp);
  insert.run(150000, stamp, stamp);
  app.store.addReply(1, { key: 'guest', nonce: 'reply', body: 'New activity.' });
  const activity = app.store.getTopic(1).topic.last_activity;
  const index = await app.request(root);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /application\/xml/);
  const xml = await index.text();
  assert.ok(xml.includes('<sitemapindex '));
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]),
    [1, 2, 4].map(part => origin + root + '?part=' + part));
  const first = await (await app.request(root + '?part=1')).text();
  assert.equal([...first.matchAll(/<url>/g)].length, 50000);
  assert.ok(first.includes('<loc>' + origin + '/</loc><lastmod>' + activity + '</lastmod>'));
  assert.ok(first.includes('<loc>' + origin + '/topics/1</loc><lastmod>' + activity + '</lastmod>'));
  assert.ok(first.includes('/topics/49999</loc>'));
  assert.ok(!first.includes('/topics/50000</loc>'));
  for (const [part, id] of [[2, 50000], [4, 150000]]) {
    const response = await app.request(root + '?part=' + part);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.deepEqual([...page.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), [origin + '/topics/' + id]);
  }
  for (const query of ['part=0', 'part=', 'part=1.5', 'part=01', 'part=3', 'part=5', 'part=1&part=2']) {
    const result = await app.request(root + '?' + query);
    assert.equal(result.status, 404, query);
    assertPrivate(result);
  }
});

test('new visitors can publish a topic and reply on their first visit', async t => {
  const app = await fixture(t);
  const home = await app.request('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('set-cookie'), null);
  assert.match(await home.text(), /href="\/new"/);
  const topic = await composeForm(app, '/new');
  const data = { ...topic.fields, nickname: '', title: 'Weekend', body: 'Forests & hills.' };
  const post = await app.request(topic.action, { cookie: topic.cookie, data });
  assert.equal(post.status, 303);
  assertPrivate(post);
  const path = post.headers.get('location');
  assert.match(path, /^\/topics\/\d+$/);
  const retry = await app.request(topic.action, { cookie: topic.cookie, data });
  assert.equal(retry.headers.get('location'), path);
  const changed = await app.request(topic.action, { cookie: topic.cookie, data: { ...data, title: 'Different topic' } });
  assert.equal(changed.status, 409);
  assert.equal(app.store.listTopics().total, 1);

  const page = await app.request(path);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('set-cookie'), null);
  const html = await page.text();
  assert.ok(html.includes('href="' + path + '/reply"'));
  assert.match(html, /<bdi>Anonymous<\/bdi>/);
  assert.ok(html.includes('Forests &amp; hills.'));
  assert.doesNotMatch(html, /name="csrf"/);
  const reply = await composeForm(app, path + '/reply');
  assert.notEqual(reply.cookie, topic.cookie);
  const submission = { cookie: reply.cookie, data: { ...reply.fields, nickname: 'Visitor', body: 'We went <yesterday>.' } };
  const response = await app.request(reply.action, submission);
  assert.equal(response.status, 303);
  const location = response.headers.get('location');
  assert.match(location, new RegExp('^' + path + '#reply-\\d+$'));
  const again = await app.request(reply.action, submission);
  assert.equal(again.headers.get('location'), location);
  const updated = await (await app.request(path)).text();
  assert.match(updated, /<bdi>Visitor<\/bdi>/);
  assert.ok(updated.includes('We went &lt;yesterday&gt;.'));
  assert.ok(updated.includes('id="' + location.split('#')[1] + '"'));
  assert.ok(updated.includes('1 reply'));
});

test('guest posts require the original browser form and accept corrections', async t => {
  const app = await fixture(t);
  const form = await composeForm(app, '/new');
  const data = { ...form.fields, title: 'Weekend', body: 'Unpublished <draft>' };
  const foreign = await composeForm(app, '/new');
  for (const options of [
    { data },
    { cookie: foreign.cookie, data },
    { cookie: form.cookie, data: { ...data, csrf: '' } },
    { cookie: form.cookie, data, headers: { origin: 'https://foreign.example' } },
    { cookie: form.cookie, data, headers: { 'sec-fetch-site': 'cross-site' } },
  ]) {
    const denied = await app.request(form.action, options);
    assert.equal(denied.status, 403);
    assertPrivate(denied);
  }
  const badNonce = await app.request(form.action, { cookie: form.cookie, data: { ...data, nonce: '' } });
  assert.equal(badNonce.status, 400);
  assertPrivate(badNonce);
  const invalid = await app.request(form.action, { cookie: form.cookie, data: { ...data, title: '' } });
  assert.equal(invalid.status, 400);
  assertPrivate(invalid);
  const html = await invalid.text();
  assert.ok(html.includes('Unpublished &lt;draft&gt;'));
  assert.equal(app.store.listTopics().total, 0);
  const corrected = await app.request(form.action, { cookie: form.cookie, data: {
    ...data, csrf: field(html, 'csrf'), nonce: field(html, 'nonce'),
  } });
  assert.equal(corrected.status, 303);
  assert.equal(app.store.listTopics().total, 1);
});

test('guest posting limits apply across forms in the same browser', async t => {
  const app = await fixture(t);
  const path = '/topics/' + seededTopic(app.store) + '/reply';
  async function postReply(cookie) {
    const form = await composeForm(app, path, cookie);
    const response = await app.request(form.action, { cookie: form.cookie, data: { ...form.fields, body: 'Here.' } });
    return { response, cookie: form.cookie };
  }
  const first = await postReply();
  assert.equal(first.response.status, 303);
  for (let i = 1; i < 12; i++) {
    assert.equal((await postReply(first.cookie)).response.status, 303);
  }
  const limited = await postReply(first.cookie);
  assert.equal(limited.response.status, 429);
  assertPrivate(limited.response);
  assert.equal((await postReply()).response.status, 303);
});

test('a guest form can still be posted after a server restart with the same signing key', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forum-session-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secretPath = join(dir, 'forum-session.key');
  const open = await fixture(t, { secretPath });
  const key = statSync(secretPath);
  assert.equal(key.size, 32);
  assert.equal(key.mode & 0o777, 0o600);
  const form = await composeForm(open, '/new');
  const submission = { cookie: form.cookie, data: { ...form.fields, title: 'A topic', body: 'A draft.' } };

  const restarted = await fixture(t, { secretPath });
  const published = await restarted.request(form.action, submission);
  assert.equal(published.status, 303);
  assert.equal(restarted.store.listTopics().total, 1);
});

test('an expired guest session gets a fresh form on the next visit', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const app = await fixture(t);
  const old = await composeForm(app, '/new');
  now += 25 * 3_600_000;
  const draft = { title: 'A topic', body: 'A draft.' };
  const expired = await app.request(old.action, { cookie: old.cookie, data: { ...old.fields, ...draft } });
  assert.equal(expired.status, 403);
  const fresh = await composeForm(app, '/new', old.cookie);
  assert.notEqual(fresh.cookie, old.cookie);
  const sent = await app.request(fresh.action, { cookie: fresh.cookie, data: { ...fresh.fields, ...draft } });
  assert.equal(sent.status, 303);
});
