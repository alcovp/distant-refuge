import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openStore } from '../store.mjs';

const cliPath = fileURLToPath(new URL('../moderate.mjs', import.meta.url));

function tempDB(t) {
  const dir = mkdtempSync(join(tmpdir(), 'distant-refuge-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'private', 'journal.sqlite');
}

function cli(path, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, DB_PATH: path } });
}

test('only a separately authored, reviewed entry reaches the public archive', t => {
  const path = tempDB(t);
  const store = openStore(path);
  t.after(() => store.close());
  const privateText = 'Confidential original submission';
  const { code } = store.addReport(privateText, store.clientKeyForAddress('192.0.2.1'));
  assert.match(code, /^DR-[0-9A-F]{32}$/);
  assert.deepEqual(store.listPublished(), []);
  assert.equal(store.listPending()[0].receipt, code);
  assert.equal(store.getReport(code).observation, privateText);
  assert.throws(() => store.publishReport(code, 'Editorial title', privateText.toUpperCase()), { status: 400 });
  assert.throws(() => store.publishReport(code, 'Editorial title', 'Receipt ' + code), { status: 400 });
  assert.equal(cli(path, 'publish', code, '--title', 'Editorial title').status, 1);
  const summary = 'A reviewed summary.';
  const publication = cli(path, 'publish', code, '--title', 'Editorial title', '--summary', summary);
  assert.equal(publication.status, 0, publication.stderr);
  const [record] = store.listPublished();
  assert.equal(record.summary, summary);
  assert.equal(record.title, 'Editorial title');
  assert.deepEqual(Object.keys(record).sort(), ['published_on', 'slug', 'summary', 'title']);
  assert.match(record.published_on, /^\d{4}-\d\d-\d\d$/);
  assert.ok(!JSON.stringify(record).includes(code));
  assert.ok(!JSON.stringify(record).includes(privateText));
  assert.equal(store.getReport(code).observation, null);
  assert.equal(store.publishReport(code, record.title, summary), record.slug);
  assert.throws(() => store.publishReport(code, 'A second title', summary), { status: 409 });
  assert.deepEqual(store.listPending(), []);
  assert.equal(cli(path, 'discard', code).status, 0);
  assert.deepEqual(store.listPublished(), []);
  assert.throws(() => store.getReport(code), { status: 404 });
});

test('the per-client rolling limit spans restart, discard and independent connections', t => {
  const path = tempDB(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let store = openStore(path);
  const address = '198.51.100.23';
  const key = store.clientKeyForAddress(address);
  for (let i = 0; i < 5; i++) {
    const { code } = store.addReport('Observation', key);
    store.discardReport(code);
  }
  for (const filename of [path, path + '-wal', path + '-shm']) {
    assert.equal(statSync(filename).mode & 0o077, 0);
  }
  store.close();
  store = openStore(path);
  t.after(() => store.close());
  assert.equal(store.clientKeyForAddress(address), key);
  assert.throws(() => store.addReport('Observation', key), { status: 429 });
  const other = openStore(path);
  t.after(() => other.close());
  assert.throws(() => other.addReport('Observation', key), { status: 429 });
  now += 3_600_000;
  assert.ok(other.addReport('Another observation', key).code);
  const inspect = new DatabaseSync(path);
  t.after(() => inspect.close());
  assert.deepEqual(inspect.prepare('SELECT client_key IS NULL AS forgotten, count(*) AS n FROM admissions GROUP BY forgotten ORDER BY forgotten').all().map(row => [row.forgotten, row.n]), [[0, 1], [1, 5]]);
});

test('the global rolling cap admits fresh submissions again after 24 hours', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = openStore(':memory:');
  t.after(() => store.close());
  for (let i = 0; i < 100; i++) {
    assert.ok(store.addReport('Observation', store.clientKeyForAddress(String(i))).code);
  }
  const key = store.clientKeyForAddress('later visitor');
  now += 24 * 3_600_000 - 1;
  assert.throws(() => store.addReport('Observation', key), { status: 429 });
  now++;
  assert.ok(store.addReport('Observation', key).code);
});

test('invalid observations are rejected before the limit is consumed', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const key = store.clientKeyForAddress('198.51.100.41');
  for (const invalid of ['  ', 'x'.repeat(1201), 'abc\u001b[41m', 'a\0b', null]) {
    assert.throws(() => store.addReport(invalid, key), { status: 400 });
  }
  assert.ok(store.addReport('🌙'.repeat(1200), key).code);
  assert.equal(store.listPending().length, 1);
});

test('daily aggregates count only supported reads and accepted reports within their UTC windows', t => {
  const path = tempDB(t);
  const day = 86_400_000;
  let now = Date.UTC(2028, 0, 1);
  t.mock.method(Date, 'now', () => now);
  const store = openStore(path);
  t.after(() => store.close());
  store.recordPageRead('/assets/site.css');
  store.recordPageRead('/?private-query');
  assert.deepEqual(store.stats(), []);
  for (const page of ['/', '/', '/archive', '/report']) store.recordPageRead(page);
  const key = store.clientKeyForAddress('2001:db8::1');
  assert.throws(() => store.addReport('', key), { status: 400 });
  const report = store.addReport('A private observation', key);
  store.discardReport(report.code);
  assert.deepEqual({ ...store.stats()[0] }, {
    day_utc: '2028-01-01', home_reads: 2, archive_reads: 1, report_reads: 1, accepted_reports: 1,
  });
  now += 29 * day;
  store.recordPageRead('/');
  assert.deepEqual(store.stats().map(row => row.day_utc), ['2028-01-30', '2028-01-01']);
  now += day;
  assert.deepEqual(store.stats().map(row => row.day_utc), ['2028-01-30']);
  now += 60 * day;
  store.addReport('A later report', key);
  const readback = new DatabaseSync(path);
  t.after(() => readback.close());
  assert.equal(readback.prepare('SELECT count(*) AS n FROM daily_stats').get().n, 2);
});
