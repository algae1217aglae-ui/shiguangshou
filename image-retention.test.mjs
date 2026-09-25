import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRetentionEvidence, extractDurableInboxReferences, previewImageRetention } from './image-retention.mjs';
import { executeImageRetention } from './image-retention-executor.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-09-25T00:00:00.000Z');

function fixture({ state = { log: [] }, history = '', life = [], albums = { albums: [] }, works = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-'));
  mkdirSync(join(root, 'inbox'));
  mkdirSync(join(root, 'works'));
  writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  writeFileSync(join(root, 'chat-history.jsonl'), history);
  writeFileSync(join(root, 'life.json'), JSON.stringify(life));
  writeFileSync(join(root, 'albums.json'), JSON.stringify(albums));
  writeFileSync(join(root, 'works.json'), JSON.stringify(works));
  return root;
}

function image(root, name, body = name, mtime = NOW - 200 * DAY) {
  const path = join(root, 'inbox', name);
  writeFileSync(path, body);
  const date = new Date(mtime);
  utimesSync(path, date, date);
  return path;
}

function entry(path, ts, extra = {}) {
  return { role: 'user', text: '', images: [path], ts, ...extra };
}

function iso(ms) { return new Date(ms).toISOString(); }

test('90-day cutoff is retained and one millisecond older is eligible', async t => {
  const root = fixture({ state: { log: [entry('inbox/edge.jpg', iso(NOW - 90 * DAY)), entry('inbox/old.jpg', iso(NOW - 90 * DAY - 1))] } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'edge.jpg'); image(root, 'old.jpg');
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.deepEqual(evidence.candidates.map(x => x.relativePath), ['inbox/old.jpg']);
  assert.equal(evidence.skipReasons.within_retention, 1);
});

test('latest trusted reshare wins and state/history duplicate is counted once', async t => {
  const old = entry('inbox/a.jpg', iso(NOW - 120 * DAY));
  const fresh = entry('inbox/a.jpg', iso(NOW - 2 * DAY));
  const root = fixture({ state: { log: [old, fresh] }, history: JSON.stringify(old) + '\n' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'a.jpg');
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.equal(evidence.chatEntries, 2);
  assert.equal(evidence.candidates.length, 0);
  assert.equal(evidence.skipReasons.within_retention, 1);
});

test('missing, invalid, and future timestamps protect exact paths', async t => {
  const root = fixture({ state: { log: [
    entry('inbox/missing.jpg', undefined), entry('inbox/bad.jpg', 'not-a-time'), entry('inbox/future.jpg', iso(NOW + DAY)),
  ] } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['missing.jpg', 'bad.jpg', 'future.jpg']) image(root, name);
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.equal(evidence.candidates.length, 0);
  assert.equal(evidence.skipReasons.untrusted_time, 3);
});

test('required sources fail closed when missing, malformed, truncated, or wrong schema', async t => {
  const cases = [
    root => rmSync(join(root, 'life.json')),
    root => writeFileSync(join(root, 'albums.json'), '{'),
    root => writeFileSync(join(root, 'chat-history.jsonl'), '{"role":"user"'),
    root => writeFileSync(join(root, 'state.json'), JSON.stringify({ log: 'wrong' })),
  ];
  for (const mutate of cases) {
    const root = fixture(); mutate(root);
    await assert.rejects(() => collectRetentionEvidence({ root, now: NOW }), /RETENTION_SOURCE_/);
    rmSync(root, { recursive: true, force: true });
  }
  t.after(() => {});
});

test('hidden/private and non-indexable life or album references still protect', async t => {
  const root = fixture({
    state: { log: [entry('inbox/life.jpg', iso(NOW - 120 * DAY)), entry('inbox/album.jpg', iso(NOW - 120 * DAY))] },
    life: [{ kind: 'photo', photo: '/inbox/life.jpg', hidden: true, private: true, memorySafe: false }],
    albums: { albums: [{ id: 'secret', hidden: true, private: true, items: [{ src: 'inbox/album.jpg', memorySafe: false }] }] },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'life.jpg'); image(root, 'album.jpg');
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.equal(evidence.candidates.length, 0);
  assert.equal(evidence.skipReasons.durable_reference, 2);
});

test('travel stop and group photos are durable life references', async t => {
  const names = ['stop.jpg', 'group.jpg'];
  const root = fixture({
    state: { log: names.map(name => entry(`inbox/${name}`, iso(NOW - 120 * DAY))) },
    life: [{ kind: 'travel', travel: { id: 'trip', stops: [{ place: 'synthetic', photo: '/inbox/stop.jpg' }], group: { photo: '/inbox/group.jpg' } } }],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) image(root, name);
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.deepEqual(evidence.candidates, []);
  assert.equal(evidence.skipReasons.durable_reference, 2);
});

test('works are outside the retention protection scope, including missing or malformed metadata', async t => {
  for (const mode of ['missing', 'malformed', 'dynamic']) {
    const root = fixture({ state: { log: [entry('inbox/old.jpg', iso(NOW - 120 * DAY))] }, works: [{ file: 'card.html' }] });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    image(root, 'old.jpg');
    writeFileSync(join(root, 'works', 'card.html'), '<script>fetch("/inbox/old.jpg")</script>');
    if (mode === 'missing') rmSync(join(root, 'works.json'));
    if (mode === 'malformed') writeFileSync(join(root, 'works.json'), '{');
    const result = await previewImageRetention({ root, now: NOW });
    assert.equal(result.candidateCount, 1, mode);
  }
});

test('executor retains albums, journal and travel photos while removing only expired chat and work-only photos', async t => {
  const names = ['chat.jpg', 'work.jpg', 'album.jpg', 'journal.jpg', 'stop.jpg', 'group.jpg', 'recent.jpg'];
  const root = fixture({
    state: { log: names.map(name => entry('inbox/' + name, iso(NOW - (name === 'recent.jpg' ? 2 : 120) * DAY))) },
    life: [
      { kind: 'photo', photo: '/inbox/journal.jpg', hidden: true, private: true },
      { kind: 'travel', travel: { stops: [{ photo: '/inbox/stop.jpg' }], group: { photo: '/inbox/group.jpg' } } },
    ],
    albums: { albums: [{ hidden: true, private: true, items: [{ src: 'inbox/album.jpg' }] }] },
    works: [{ file: 'dynamic.html' }],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) image(root, name);
  writeFileSync(join(root, 'works', 'dynamic.html'), '<script>fetch("/inbox/work.jpg")</script>');
  const before = await previewImageRetention({ root, now: NOW });
  assert.equal(before.candidateCount, 2);
  const result = await executeImageRetention({ root, now: NOW, enabled: true, reconcile: async () => ({ removed: 2, paused: false }) });
  assert.equal(result.deletedCount, 2);
  for (const name of names) assert.equal(existsSync(join(root, 'inbox', name)), !['chat.jpg', 'work.jpg'].includes(name), name);
});

test('work HTML fails closed for dynamic or externally loaded reference sources', () => {
  const unsupported = [
    '<script>const path = "/in" + "box/dynamic.jpg";</script>',
    '<link rel="stylesheet" href="https://example.test/card.css">',
    '<img src="safe.png" onerror="this.src=\'/inbox/fallback.jpg\'">',
    '<base href="javascript:alert(1)"><img src="old.jpg">',
    String.raw`<div style='background-image:u\72l("/inbox/old.jpg")'></div>`,
    '<div style=\'background-image:image-set("/inbox/old.jpg" 1x)\'></div>',
  ];
  for (const html of unsupported) {
    assert.throws(() => extractDurableInboxReferences(html, { format: 'html', documentPath: '/works/card.html' }), /RETENTION_REFERENCE_UNSUPPORTED/);
  }
});

test('work writer parser still rejects ambiguous inbox traversal', () => {
  assert.throws(() => extractDurableInboxReferences('<img src="/inbox/../secret.jpg">', { format: 'html' }), /RETENTION_REFERENCE_/);
});

test('an exact durable reference protects same-SHA inbox aliases but not unrelated bytes', async t => {
  const state = { log: ['kept.jpg', 'alias.jpg', 'other.jpg'].map(name => entry(`inbox/${name}`, iso(NOW - 120 * DAY))) };
  const root = fixture({ state, life: [{ kind: 'photo', photo: '/inbox/kept.jpg' }] });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'kept.jpg', 'same'); image(root, 'alias.jpg', 'same'); image(root, 'other.jpg', 'different');
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.deepEqual(evidence.candidates.map(x => x.relativePath), ['inbox/other.jpg']);
  assert.equal(evidence.skipReasons.durable_sha_alias, 1);
});

test('a same-name file newer than its last share is protected as replacement', async t => {
  const root = fixture({ state: { log: [entry('inbox/a.jpg', iso(NOW - 120 * DAY))] } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'a.jpg', 'new bytes', NOW - DAY);
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.equal(evidence.candidates.length, 0);
  assert.equal(evidence.skipReasons.file_newer_than_share, 1);
});

test('Windows casing variants of one file share one latest timestamp', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture({ state: { log: [
    entry('inbox/old.jpg', iso(NOW - 120 * DAY)),
    entry('inbox/OLD.JPG', iso(NOW - DAY)),
  ] } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'old.jpg');
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.deepEqual(evidence.candidates, []);
  assert.equal(evidence.skipReasons.within_retention, 1);
});

test('nested durable and chat schemas fail closed instead of ignoring unknown reference shapes', async t => {
  const cases = [
    { life: [{ kind: 'photo', photo: { src: '/inbox/old.jpg' } }] },
    { life: [{ kind: 'travel', travel: { stops: [{ photo: { src: '/inbox/old.jpg' } }] } }] },
    { albums: { albums: [{ items: [{ src: { path: '/inbox/old.jpg' } }] }] } },
    { state: { log: [{ role: 'user', ts: iso(NOW - 120 * DAY), images: { 0: 'inbox/old.jpg' } }] } },
  ];
  for (const options of cases) {
    const root = fixture(options); image(root, 'old.jpg');
    await assert.rejects(() => collectRetentionEvidence({ root, now: NOW }), /RETENTION_SOURCE_.*SCHEMA/);
    rmSync(root, { recursive: true, force: true });
  }
  t.after(() => {});
});

test('orphans, nested paths, non-images, traversal, absolute paths, and symlinks are never candidates', async t => {
  const root = fixture({ state: { log: [
    entry('inbox/nested/a.jpg', iso(NOW - 120 * DAY)), entry('../escape.jpg', iso(NOW - 120 * DAY)),
    entry('C:/escape.jpg', iso(NOW - 120 * DAY)), entry('inbox/readme.txt', iso(NOW - 120 * DAY)),
    entry('inbox/link.jpg', iso(NOW - 120 * DAY)),
  ] } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'orphan.jpg'); image(root, 'readme.txt');
  const target = image(root, 'target.jpg');
  try { symlinkSync(target, join(root, 'inbox', 'link.jpg')); } catch {}
  const evidence = await collectRetentionEvidence({ root, now: NOW });
  assert.equal(evidence.candidates.length, 0);
});

test('public preview exposes aggregates but no paths', async t => {
  const root = fixture({ state: { log: [entry('inbox/old.jpg', iso(NOW - 120 * DAY))] } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  image(root, 'old.jpg', '12345');
  const preview = await previewImageRetention({ root, now: NOW });
  assert.equal(preview.candidateCount, 1);
  assert.equal(preview.estimatedBytes, 5);
  assert.equal(JSON.stringify(preview).includes('old.jpg'), false);
  assert.equal('candidates' in preview, false);
});
