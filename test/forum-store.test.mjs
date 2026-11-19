import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openForum } from '../forum-store.mjs';

function dbPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'distant-forum-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'forum.sqlite');
}

function post(extra = {}) {
  return { nickname: 'Two friends 🌙', title: 'Shore birds', body: 'A first-hand note.', key: 'test-session', nonce: randomUUID(), ...extra };
}

test('topics and replies are immediate, ordered and retry-safe across connections', t => {
  const path = dbPath(t);
  const a = openForum(path);
  const b = openForum(path);
  t.after(() => { a.close(); b.close(); });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const first = post({ body: '🌙'.repeat(6000) });
  const id = a.createTopic(first);
  assert.equal(b.createTopic(first), id);
  assert.throws(() => b.createTopic({ ...first, title: 'Different title' }), { status: 409 });
  const second = b.createTopic(post());
  assert.deepEqual(a.listTopics().topics.map(row => row.id), [second, id]);
  const reply = post({ body: 'First line\r\nSecond line <3' });
  const replyId = b.addReply(id, reply);
  assert.equal(a.addReply(id, reply), replyId);
  assert.throws(() => b.addReply(second, reply), { status: 409 });
  const { topic, replies, total } = b.getTopic(id);
  assert.equal(topic.body, first.body);
  assert.equal(total, 1);
  assert.equal(topic.reply_count, 1);
  assert.equal(topic.created_at, new Date(now).toISOString());
  assert.equal(replies[0].id, replyId);
  assert.equal(replies[0].body, 'First line\nSecond line <3');
  assert.deepEqual(Object.keys(replies[0]).sort(), ['body', 'created_at', 'id', 'nickname']);
  assert.deepEqual(a.listTopics().topics.map(row => row.id), [id, second]);
  assert.deepEqual(a.sitemap().topics.map(row => row.id), [id, second]);
  for (const file of [path, path + '-wal', path + '-shm']) assert.equal(statSync(file).mode & 0o077, 0);
});

test('invalid or missing topics do not consume another guest’s slot or posting allowance', t => {
  const forum = openForum(':memory:');
  t.after(() => forum.close());
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const form = post();
  assert.throws(() => forum.addReply(222, form), { status: 404 });
  assert.throws(() => forum.createTopic({ ...form, nickname: 'a\nb' }), { status: 400 });
  assert.throws(() => forum.createTopic({ ...form, body: '🌙'.repeat(6001) }), { status: 400 });
  const id = forum.createTopic(form);
  for (let i = 1; i < 12; i++) forum.addReply(id, post());
  assert.throws(() => forum.createTopic(post()), { status: 429 });
  assert.equal(forum.createTopic(form), id);
  assert.ok(forum.createTopic(post({ key: 'independent-session' })));
  now += 10 * 60_000;
  assert.ok(forum.createTopic(post()));
});

test('pagination has stable boundaries, including redirects after a retried reply', t => {
  const forum = openForum(':memory:');
  t.after(() => forum.close());
  const id = forum.createTopic(post());
  for (let i = 0; i < 25; i++) forum.createTopic(post({ key: randomUUID() }));
  assert.equal(forum.listTopics().total, 26);
  assert.equal(forum.listTopics().topics.length, 25);
  assert.equal(forum.listTopics(2).topics[0].id, id);
  const ids = [];
  for (let n = 0; n < 52; n++) ids.push(forum.addReply(id, post({ key: randomUUID() })));
  assert.equal(forum.replyPage(ids[49]), 1);
  assert.equal(forum.replyPage(ids[50]), 2);
  assert.equal(forum.replyPage(9999), null);
  assert.deepEqual(forum.getTopic(id, 2).replies.map(row => row.id), ids.slice(50));
  assert.equal(forum.getTopic(id, 2).total, 52);
  assert.equal(forum.getTopic(999), null);
  for (const page of [0, '1', 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => forum.listTopics(page), { status: 400 });
  }
});

test('an existing unrelated database is not initialized or exposed as a public forum', t => {
  const path = dbPath(t);
  const privateDb = new DatabaseSync(path);
  privateDb.exec("CREATE TABLE journal(original TEXT); INSERT INTO journal VALUES ('private');");
  privateDb.close();
  assert.throws(() => openForum(path), /different application/);
  const stored = new DatabaseSync(path);
  t.after(() => stored.close());
  assert.equal(stored.prepare('SELECT original FROM journal').get().original, 'private');
  assert.deepEqual(stored.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name), ['journal']);
});
