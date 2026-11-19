import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OBSERVATION_LIMIT = 1200;
const pages = new Set(['/', '/archive', '/report']);
const utcDay = timestamp => new Date(timestamp).toISOString().slice(0, 10);

class JournalError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function validateText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JournalError(`Enter a non-empty ${label}.`, 400);
  }
  const text = value.trim();
  if (Array.from(text).length > maxLength) {
    throw new JournalError(`The ${label} must be ${maxLength} characters or fewer.`, 400);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new JournalError(`The ${label} contains an unsupported control character.`, 400);
  }
  return text;
}

function normalizedText(text) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function privateFile(filename) {
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('DB_PATH must name a regular file.');
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return path;
}

export function openStore(filename = process.env.DB_PATH || './var/journal.sqlite') {
  const db = new DatabaseSync(filename === ':memory:' ? filename : privateFile(filename));

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS journal (
        receipt TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        observation TEXT,
        slug TEXT UNIQUE,
        title TEXT,
        summary TEXT,
        published_at INTEGER,
        CHECK (
          (observation IS NOT NULL AND published_at IS NULL AND slug IS NULL AND title IS NULL AND summary IS NULL)
          OR
          (observation IS NULL AND published_at IS NOT NULL AND slug IS NOT NULL AND title IS NOT NULL AND summary IS NOT NULL)
        )
      ) STRICT;
      CREATE TABLE IF NOT EXISTS admissions (client_key TEXT, accepted_at INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS admissions_by_time ON admissions(accepted_at);
      CREATE INDEX IF NOT EXISTS admissions_by_client ON admissions(client_key, accepted_at);
      CREATE TABLE IF NOT EXISTS daily_stats (
        day_utc TEXT PRIMARY KEY,
        home_reads INTEGER NOT NULL,
        archive_reads INTEGER NOT NULL,
        report_reads INTEGER NOT NULL,
        accepted_reports INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;
      INSERT OR IGNORE INTO settings(name, value) VALUES ('rate_secret', randomblob(32));
    `);
    const secret = db.prepare("SELECT value FROM settings WHERE name = 'rate_secret'").get().value;
    const dropOld = db.prepare('DELETE FROM admissions WHERE accepted_at <= ?');
    const forgetClient = db.prepare('UPDATE admissions SET client_key = NULL WHERE client_key IS NOT NULL AND accepted_at <= ?');
    const globalCount = db.prepare('SELECT count(*) AS count FROM admissions WHERE accepted_at > ?');
    const clientCount = db.prepare('SELECT count(*) AS count FROM admissions WHERE client_key = ? AND accepted_at > ?');
    const recordAdmission = db.prepare('INSERT INTO admissions (client_key, accepted_at) VALUES (?, ?)');
    const incrementStats = db.prepare(`INSERT INTO daily_stats(day_utc, home_reads, archive_reads, report_reads, accepted_reports)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(day_utc) DO UPDATE SET
        home_reads = home_reads + excluded.home_reads,
        archive_reads = archive_reads + excluded.archive_reads,
        report_reads = report_reads + excluded.report_reads,
        accepted_reports = accepted_reports + excluded.accepted_reports`);
    const recentStats = db.prepare('SELECT day_utc, home_reads, archive_reads, report_reads, accepted_reports FROM daily_stats WHERE day_utc BETWEEN ? AND ? ORDER BY day_utc DESC');
    const trimStats = db.prepare('DELETE FROM daily_stats WHERE day_utc < ?');
    const insert = db.prepare('INSERT INTO journal(receipt, created_at, observation) VALUES (?, ?, ?)');
    const fetch = db.prepare('SELECT * FROM journal WHERE receipt = ?');
    const remove = db.prepare('DELETE FROM journal WHERE receipt = ?');
    const publish = db.prepare(`UPDATE journal SET observation = NULL, title = ?, summary = ?, slug = ?, published_at = ?
                                WHERE receipt = ? AND published_at IS NULL`);
    const published = db.prepare(`SELECT slug, title, summary, date(published_at / 1000, 'unixepoch') AS published_on
                                   FROM journal WHERE published_at IS NOT NULL ORDER BY published_at DESC, slug`);
    const pending = db.prepare(`SELECT receipt, datetime(created_at / 1000, 'unixepoch') AS received_utc
                                 FROM journal WHERE published_at IS NULL ORDER BY created_at, receipt LIMIT 100`);

    function cleanup(now) {
      dropOld.run(now - DAY);
      forgetClient.run(now - HOUR);
      trimStats.run(utcDay(now - 89 * DAY));
    }

    function getReport(code) {
      const report = fetch.get(code);
      if (!report) throw new JournalError('No record with that receipt.', 404);
      return report;
    }

    transaction(() => cleanup(Date.now()));
    const sweep = setInterval(() => {
      try {
        transaction(() => cleanup(Date.now()));
      } catch (error) {
        console.error('Could not prune journal counters:', error.message);
      }
    }, 10 * 60_000).unref();

    return {
      clientKeyForAddress(address) {
        return createHmac('sha256', secret).update(address).digest('hex');
      },

      addReport(observation, clientKey) {
        const text = validateText(observation, 'observation', OBSERVATION_LIMIT);
        if (typeof clientKey !== 'string' || !/^[a-f0-9]{64}$/.test(clientKey)) {
          throw new Error('Expected a private rate-limit key from clientKeyForAddress().');
        }
        return transaction(() => {
          const now = Date.now();
          cleanup(now);
          if (globalCount.get(now - DAY).count >= 100 || clientCount.get(clientKey, now - HOUR).count >= 5) {
            throw new JournalError('The submission limit has been reached. Please try again later.', 429);
          }
          const code = 'DR-' + randomBytes(16).toString('hex').toUpperCase();
          insert.run(code, now, text);
          recordAdmission.run(clientKey, now);
          incrementStats.run(utcDay(now), 0, 0, 0, 1);
          return { code };
        });
      },

      recordPageRead(path) {
        if (!pages.has(path)) return;
        incrementStats.run(utcDay(Date.now()), Number(path === '/'), Number(path === '/archive'), Number(path === '/report'), 0);
      },

      stats() {
        const now = Date.now();
        return recentStats.all(utcDay(now - 29 * DAY), utcDay(now));
      },

      listPublished: () => published.all(),
      listPending: () => pending.all(),
      getReport,

      publishReport(code, title, summary) {
        const headline = validateText(title, 'title', 120);
        const body = validateText(summary, 'summary', 1200);
        if (/[\r\n]/u.test(headline)) throw new JournalError('Keep the title on one line.', 400);
        if (/\bDR-[a-f0-9]{32}\b/i.test(headline + ' ' + body)) {
          throw new JournalError('Remove the private receipt from the public text.', 400);
        }
        return transaction(() => {
          const report = getReport(code);
          if (report.published_at !== null) {
            if (report.title === headline && report.summary === body) return report.slug;
            throw new JournalError('This report has already been published.', 409);
          }
          const raw = normalizedText(report.observation);
          if (normalizedText(body) === raw || normalizedText(headline) === raw) {
            throw new JournalError('Write a separate retrospective summary instead of copying the submission.', 400);
          }
          const stem = headline.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'entry';
          const slug = stem + '-' + randomBytes(8).toString('hex');
          publish.run(headline, body, slug, Date.now(), code);
          return slug;
        });
      },

      discardReport(code) {
        if (!remove.run(code).changes) throw new JournalError('No record with that receipt.', 404);
      },

      close() {
        clearInterval(sweep);
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
