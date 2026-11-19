import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const applicationId = 0x44524631;
const postingWindow = 10 * 60_000;
const topicPageSize = 25;
const replyPageSize = 50;
const sitemapSize = 50_000;
const inputError = (message, status = 400) => Object.assign(new Error(message), { status });

function privatePath(filename) {
  if (filename === ':memory:') return filename;
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_RDWR, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('FORUM_DB_PATH must be a regular file.');
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return path;
}

function content(value, label, max, multiline = false) {
  if (typeof value !== 'string') throw inputError('Enter a ' + label + '.');
  const cleaned = value.trim().replace(/\r\n?/g, '\n');
  if (!cleaned || Array.from(cleaned).length > max) {
    throw inputError('The ' + label + ' must be between 1 and ' + max + ' characters.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(cleaned) ||
      (!multiline && /[\n\t\u2028\u2029]/u.test(cleaned))) {
    throw inputError('The ' + label + ' contains an unsupported character.');
  }
  return cleaned;
}

function digest(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest();
}

function offset(page, size) {
  const count = (page - 1) * size;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(count)) {
    throw inputError('Invalid page number.');
  }
  return count;
}

export function openForum(filename = process.env.FORUM_DB_PATH || './var/forum.sqlite') {
  const db = new DatabaseSync(privatePath(filename));
  function transaction(begin, work) {
    db.exec(begin);
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    transaction('BEGIN IMMEDIATE', () => {
      const id = db.prepare('PRAGMA application_id').get().application_id;
      const populated = db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (id !== applicationId && (id !== 0 || populated)) {
        throw new Error('FORUM_DB_PATH points to a database belonging to a different application.');
      }
      db.exec(`
        PRAGMA application_id = ${applicationId};
        CREATE TABLE IF NOT EXISTS topics (
          id INTEGER PRIMARY KEY, nickname TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
          created_at TEXT NOT NULL, last_activity TEXT NOT NULL, last_event INTEGER NOT NULL DEFAULT 0,
          reply_count INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX IF NOT EXISTS topic_activity ON topics(last_activity DESC, last_event DESC);
        CREATE TABLE IF NOT EXISTS replies (
          id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id), nickname TEXT NOT NULL,
          body TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS topic_replies ON replies(topic_id, id);
        CREATE TABLE IF NOT EXISTS post_keys (
          event_id INTEGER PRIMARY KEY, retry_key BLOB NOT NULL UNIQUE, payload_hash BLOB NOT NULL,
          result_id INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS recent_posts (session_hash BLOB NOT NULL, posted_at INTEGER NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS recent_by_session ON recent_posts(session_hash, posted_at);
        CREATE INDEX IF NOT EXISTS recent_by_time ON recent_posts(posted_at);
      `);
    });

    db.exec('PRAGMA journal_mode = WAL');
    const replyPosition = db.prepare(`SELECT count(*) AS position FROM replies
      WHERE topic_id = (SELECT topic_id FROM replies WHERE id = ?) AND id <= ?`);
    const cols = 'id, nickname, title, body, created_at, reply_count, last_activity';
    const topics = db.prepare('SELECT ' + cols + ' FROM topics ORDER BY last_activity DESC, last_event DESC LIMIT ? OFFSET ?');
    const totalTopics = db.prepare('SELECT count(*) AS n FROM topics');
    const topic = db.prepare('SELECT ' + cols + ' FROM topics WHERE id = ?');
    const replies = db.prepare('SELECT id, nickname, body, created_at FROM replies WHERE topic_id = ? ORDER BY id LIMIT ? OFFSET ?');
    const addTopic = db.prepare('INSERT INTO topics (nickname, title, body, created_at, last_activity) VALUES (?, ?, ?, ?, ?)');
    const addReply = db.prepare('INSERT INTO replies (topic_id, nickname, body, created_at) VALUES (?, ?, ?, ?)');
    const updateTopic = db.prepare('UPDATE topics SET reply_count = reply_count + ?, last_event = ?, last_activity = ? WHERE id = ?');
    const previous = db.prepare('SELECT result_id, payload_hash FROM post_keys WHERE retry_key = ?');
    const recordKey = db.prepare('INSERT INTO post_keys(retry_key, payload_hash, result_id) VALUES (?, ?, ?)');
    const prune = db.prepare('DELETE FROM recent_posts WHERE posted_at <= ?');
    const recent = db.prepare('SELECT count(*) AS n FROM recent_posts WHERE session_hash = ?');
    const increment = db.prepare('INSERT INTO recent_posts(session_hash, posted_at) VALUES (?, ?)');
    const sitemapOverflow = db.prepare('SELECT 1 FROM topics ORDER BY id LIMIT 1 OFFSET ?');
    const sitemapRows = db.prepare('SELECT id, last_activity FROM topics WHERE id BETWEEN ? AND ? ORDER BY id');
    const latestTopic = db.prepare('SELECT last_activity FROM topics ORDER BY last_activity DESC LIMIT 1');
    // Seek to the first topic in each remaining ID range, so gaps do not create empty sitemaps.
    const sitemapParts = db.prepare(`
      WITH RECURSIVE parts(part) AS (
        VALUES (1)
        UNION ALL
        SELECT (SELECT id / ${sitemapSize} + 1 FROM topics
                WHERE id >= parts.part * ${sitemapSize} ORDER BY id LIMIT 1)
        FROM parts WHERE part IS NOT NULL LIMIT ${sitemapSize + 1}
      )
      SELECT part FROM parts WHERE part IS NOT NULL`);
    prune.run(Date.now() - postingWindow);

    function write(topicId, { key, nonce, nickname = '', title, body }) {
      if (typeof key !== 'string' || !key.length || key.length > 256) throw inputError('Reopen the form in this browser and try again.', 403);
      if (typeof nonce !== 'string' || !nonce.length || nonce.length > 256) throw inputError('Reopen the form and try again.');
      const author = typeof nickname === 'string' && !nickname.trim() ? 'Anonymous' : content(nickname, 'nickname', 40);
      const text = content(body, 'message', 6000, true);
      const subject = topicId === null ? content(title, 'title', 140) : null;
      const retryKey = digest('form', key, nonce);
      const payload = digest(topicId, author, subject, text);
      const session = digest('rate', key);

      return transaction('BEGIN IMMEDIATE', () => {
        const saved = previous.get(retryKey);
        if (saved) {
          if (!payload.equals(saved.payload_hash)) throw inputError('This form has already submitted a different post.', 409);
          return saved.result_id;
        }
        if (topicId !== null && !topic.get(topicId)) throw inputError('This topic could not be found.', 404);
        const now = Date.now();
        prune.run(now - postingWindow);
        if (recent.get(session).n >= 12) throw inputError('You have posted several times recently. Try again in ten minutes.', 429);
        const stamp = new Date(now).toISOString();
        const result = topicId === null
          ? addTopic.run(author, subject, text, stamp, stamp)
          : addReply.run(topicId, author, text, stamp);
        const resultId = Number(result.lastInsertRowid);
        const event = recordKey.run(retryKey, payload, resultId);
        updateTopic.run(topicId === null ? 0 : 1, event.lastInsertRowid, stamp, topicId ?? resultId);
        increment.run(session, now);
        return resultId;
      });
    }

    return {
      createTopic(data) { return write(null, data); },
      addReply(id, data) {
        if (!Number.isSafeInteger(id) || id < 1) throw inputError('This topic could not be found.', 404);
        return write(id, data);
      },
      listTopics(page = 1) {
        const start = offset(page, topicPageSize);
        return transaction('BEGIN', () => ({ topics: topics.all(topicPageSize, start), total: totalTopics.get().n }));
      },
      getTopic(id, page = 1) {
        if (!Number.isSafeInteger(id) || id < 1) return null;
        const start = offset(page, replyPageSize);
        return transaction('BEGIN', () => {
          const row = topic.get(id);
          return row ? { topic: row, replies: replies.all(id, replyPageSize, start), total: row.reply_count } : null;
        });
      },
      replyPage(id) {
        if (!Number.isSafeInteger(id) || id < 1) return null;
        const { position } = replyPosition.get(id, id);
        return position ? Math.ceil(position / replyPageSize) : null;
      },
      sitemap(part = null) {
        if (part !== null && (!Number.isSafeInteger(part) || part < 1 || !Number.isSafeInteger(part * sitemapSize))) return null;
        return transaction('BEGIN', () => {
          const split = Boolean(sitemapOverflow.get(sitemapSize - 1));
          if (part === null && split) {
            const parts = sitemapParts.all().map(row => row.part);
            if (parts.length > sitemapSize) throw inputError('The sitemap index is too large.', 503);
            return { parts };
          }
          if (part !== null && !split) return null;
          const first = part === null ? 1 : (part - 1) * sitemapSize;
          const last = part === null ? Number.MAX_SAFE_INTEGER : part * sitemapSize - 1;
          const topics = sitemapRows.all(first, last);
          const includeHome = part === null || part === 1;
          if (!includeHome && !topics.length) return null;
          return { topics, includeHome, homeLastmod: includeHome ? latestTopic.get()?.last_activity : null };
        });
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
