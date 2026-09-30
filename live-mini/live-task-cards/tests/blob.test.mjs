import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobStore } from '../src/store.mjs';
import { CardService } from '../src/service.mjs';
import { get, put, BlobPreconditionFailedError } from '../src/vercel-blob-lite.mjs';
import { config, payload } from './helpers.mjs';

// Boundary doubles only. No Vercel account, credentials or remote requests.
function blobDouble() {
  let raw = null, version = 0;
  const writes = [];
  return {
    writes,
    async getImpl(pathname, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      return raw === null ? null : { statusCode: 200, stream: raw, blob: { etag: `"${version}"` } };
    },
    async putImpl(pathname, next, options) {
      writes.push(options);
      if (raw !== null && !options.allowOverwrite) throw Error('Blob already exists');
      if (options.ifMatch && options.ifMatch !== `"${version}"`) throw new BlobPreconditionFailedError();
      raw = next; version++;
    },
  };
}

test('Blob first create forbids overwrite and later writes use the current ETag', async () => {
  const api = blobDouble();
  const service = new CardService(new BlobStore({ pathname: 'test.json', ...api }), config());
  const first = await service.create(await payload());
  await service.update(first.id, { requestId: 'next', expectedRevision: first.revision, content: { ...first.content, theme: 'light' } });
  assert.equal(api.writes[0].allowOverwrite, false);
  assert.equal(api.writes[0].ifMatch, undefined);
  assert.equal(api.writes[1].allowOverwrite, true);
  assert.equal(api.writes[1].ifMatch, '"1"');
});

test('simultaneous empty Blob registries cannot overwrite the first accepted card', async () => {
  const api = blobDouble(), input = await payload();
  const services = Array.from({ length: 6 }, () => new CardService(new BlobStore({ pathname: 'test.json', ...api }), config()));
  const inputs = services.map((_, i) => ({ ...input, requestId: `r-${i}`, taskId: `t-${i}` }));
  const attempts = await Promise.allSettled(services.map((service, i) => service.create(inputs[i])));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of attempts.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'STORE_UNAVAILABLE');
  // A caller retries the same request identity after the failed create, never a new task.
  const records = [];
  for (let i = 0; i < services.length; i++) records.push(await services[i].create(inputs[i]));
  assert.equal(new Set(records.map(record => record.slot)).size, 6);
  assert.equal((await services[0].slots()).filter(slot => slot.occupied).length, 6);
});

test('Blob CAS conflicts re-read current state without losing occupied slots', async () => {
  const api = blobDouble(), input = await payload();
  const service = () => new CardService(new BlobStore({ pathname: 'test.json', ...api }), config());
  await service().create(input);
  const records = await Promise.all(Array.from({ length: 6 }, (_, i) => service().create({ ...input, requestId: `r-${i}`, taskId: `t-${i}` })));
  assert.equal(new Set(records.map(record => record.slot)).size, 6);
  assert.equal((await service().slots()).filter(slot => slot.occupied).length, 7);
});

test('existing Blob registry without an ETag fails closed before a write', async () => {
  const store = new BlobStore({ pathname: 'test.json', getImpl: async () => ({ statusCode: 200, stream: '{}' }), putImpl: () => assert.fail('must not write') });
  await assert.rejects(store.transaction(() => assert.fail('must not change')), { code: 'STORE_UNAVAILABLE' });
});

test('Blob read failures and unexpected 304 do not become empty registries', async () => {
  for (const getImpl of [async () => { throw Error('offline'); }, async () => ({ statusCode: 304 })]) {
    const store = new BlobStore({ pathname: 'test.json', getImpl });
    await assert.rejects(store.read(), { code: 'STORE_UNAVAILABLE' });
  }
});

test('Blob CAS has a bounded retry budget', async () => {
  const store = new BlobStore({ pathname: 'test.json', maxRetries: 1, getImpl: async () => null,
    putImpl: async () => { throw new BlobPreconditionFailedError(); } });
  await assert.rejects(store.transaction(() => null), { code: 'STORE_BUSY' });
});

test('Blob HTTP reads bypass cache and normalize weak ETags', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'fixture.private.blob.vercel-storage.com');
    assert.equal(new URL(url).searchParams.get('cache'), '0');
    assert.equal(options.redirect, 'error');
    return new Response('{}', { headers: { etag: 'W/"revision"' } });
  });
  const result = await get('test.json', { access: 'private', token: 'vercel_blob_rw_fixture_test', useCache: false });
  assert.equal(result.blob.etag, '"revision"');
});

test('Blob HTTP writes preserve no-overwrite/CAS headers and classify 412', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-allow-overwrite'], calls === 0 ? '0' : '1');
    assert.equal(options.headers['x-if-match'], calls === 0 ? undefined : '"revision"');
    return calls++ === 0 ? Response.json({ pathname: 'test.json' }) : new Response('', { status: 412 });
  });
  const options = { access: 'private', token: 'vercel_blob_rw_fixture_test' };
  await put('test.json', '{}', options);
  await assert.rejects(put('test.json', '{}', { ...options, allowOverwrite: true, ifMatch: 'W/"revision"' }), { name: 'BlobPreconditionFailedError' });
});
