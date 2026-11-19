import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) {
  console.error('Usage: node deploy/backup.mjs SOURCE_DB BACKUP_DIRECTORY');
  process.exit(2);
}

process.umask(0o077);
let directory;
let db;
try {
  db = new DatabaseSync(source, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 10000');
  const date = new Date().toISOString().slice(0, 10);
  directory = mkdtempSync(join(resolve(destination), `distant-refuge-${date}-`));
  const target = join(directory, basename(resolve(source)));
  db.prepare('VACUUM INTO ?').run(target);
  db.close();

  chmodSync(target, 0o600);
  db = new DatabaseSync(target, { readOnly: true });
  const results = db.prepare('PRAGMA integrity_check').all();
  if (results.length !== 1 || results[0].integrity_check !== 'ok') {
    throw new Error('SQLite integrity check failed');
  }
  console.log(target);
} catch (error) {
  if (directory) rmSync(directory, { recursive: true, force: true });
  console.error('Backup failed:', error.message);
  process.exitCode = 1;
} finally {
  if (db?.isOpen) db.close();
}
