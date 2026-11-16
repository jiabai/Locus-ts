// 来源身份识别与解析的单元测试，场景对齐 `worker/tests/test_source_identity.py`
// 与 `worker/tests/test_source_resolution.py` 的参数化分组。
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  canonicalUrlForPersistence,
  identifySource,
  normalizeBilibiliId,
  SourceIdentityError,
  sourceIdentityFromManifest,
  sourceIdentityToManifestDict,
} from '../src/sources/source-identity.ts';
import {resolveSourceRequest, sanitizeSourceText, SourceResolver} from '../src/sources/source-resolution.ts';
import {resolveSourceIdentityOnce} from '../src/sources/resolve-source.ts';

const XHS_NOTE_ID = '64a1b2c3d4e5f67890123456';

const IDENTITY_CASES = [
  [
    `https://alice:password@www.xiaohongshu.com/explore/${XHS_NOTE_ID}?xsec_token=review-secret&source=web#comments`,
    'xiaohongshu', XHS_NOTE_ID, null, `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}`,
  ],
  [
    'https://user:password@www.douyin.com/video/7524373044106677544?token=review-secret#detail',
    'douyin', '7524373044106677544', null, 'https://www.douyin.com/video/7524373044106677544',
  ],
  [
    'https://www.douyin.com/note/123?modal_id=7524373044106677544&token=review-secret#detail',
    'douyin', '7524373044106677544', null, 'https://www.douyin.com/video/7524373044106677544',
  ],
  [
    'https://user:password@www.bilibili.com/video/BV1Aa411c7mD?p=3&spm_id_from=review-secret#reply',
    'bilibili', 'BV1Aa411c7mD', 3, 'https://www.bilibili.com/video/BV1Aa411c7mD?p=3',
  ],
  [
    'https://user:password@www.bilibili.com/video/BV1Aa411c7mD?p=1&token=review-secret#reply',
    'bilibili', 'BV1Aa411c7mD', 1, 'https://www.bilibili.com/video/BV1Aa411c7mD',
  ],
  [
    'https://user:password@www.youtube.com/watch?v=dQw4w9WgXcQ&list=review-secret#chapter',
    'youtube', 'dQw4w9WgXcQ', null, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ],
  [
    'https://youtu.be/dQw4w9WgXcQ?si=review-secret#chapter',
    'youtube', 'dQw4w9WgXcQ', null, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ],
  [
    'https://www.youtube.com/shorts/abcDEF_123-?feature=review-secret#chapter',
    'youtube', 'abcDEF_123-', null, 'https://www.youtube.com/watch?v=abcDEF_123-',
  ],
  [
    'https://www.bilibili.com/video/av170001?p=1&token=review-secret#reply',
    'bilibili', 'av170001', 1, 'https://www.bilibili.com/video/av170001',
  ],
  [XHS_NOTE_ID, 'xiaohongshu', XHS_NOTE_ID, null, `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}`],
  ['BV1Aa411c7mD', 'bilibili', 'BV1Aa411c7mD', 1, 'https://www.bilibili.com/video/BV1Aa411c7mD'],
  ['av170001', 'bilibili', 'av170001', 1, 'https://www.bilibili.com/video/av170001'],
];

test('identify builds allowlisted canonical identities without any share tokens', () => {
  for (const [source, platform, stableId, part, canonicalUrl] of IDENTITY_CASES) {
    const identity = identifySource(source);
    assert.equal(identity.platform, platform, source);
    assert.equal(identity.stableId, stableId, source);
    assert.equal(identity.effectivePart, part, source);
    assert.equal(identity.canonicalUrl, canonicalUrl, source);
    const serialized = JSON.stringify(sourceIdentityToManifestDict(identity));
    assert.equal(serialized.includes('review-secret'), false, source);
    assert.equal(serialized.includes('password'), false, source);
    assert.equal(serialized.includes('xsec_token'), false, source);
  }
});

test('resolved short-link identity wins over the direct short url', () => {
  const identity = identifySource(
    `https://xhslink.com/o/demo?xsec_token=review-secret#share`,
    `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}?xsec_token=resolved-secret`,
  );
  assert.equal(identity.canonicalUrl, `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}`);
  const b23 = identifySource(
    'https://b23.tv/demo?token=review-secret#share',
    'https://www.bilibili.com/video/BV1Aa411c7mD?p=2&spm_id_from=resolved-secret',
  );
  assert.equal(b23.canonicalUrl, 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2');
  const douyin = identifySource(
    'https://v.douyin.com/demo?token=review-secret#share',
    'https://www.douyin.com/video/7524373044106677544?previous_page=resolved-secret',
  );
  assert.equal(douyin.canonicalUrl, 'https://www.douyin.com/video/7524373044106677544');
});

test('unsupported and lookalike hosts are rejected', () => {
  for (const source of [
    `https://www.xiaohongshu.com.evil/explore/${XHS_NOTE_ID}`,
    'https://www.xiaohongshu.com/explore?xsec_token=0123456789abcdef01234567',
    'https://www.xiaohongshu.com/login?signature=deadbeefdeadbeefdeadbeef',
    'https://[invalid-host/video/123?xsec_token=review-secret',
  ]) {
    assert.throws(() => identifySource(source), SourceIdentityError, source);
  }
});

test('oversized stable ids and parts are rejected', () => {
  for (const source of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQx',
    'https://www.bilibili.com/video/BV1Aa411c7mDx',
    'https://www.douyin.com/video/7524373044106677544123456',
    'https://www.bilibili.com/video/BV1Aa411c7mD?p=100001',
  ]) {
    assert.throws(() => identifySource(source), SourceIdentityError, source);
  }
});

test('empty input is rejected with the direct parser error message', () => {
  assert.throws(() => identifySource('   '), /Source URL cannot be empty/u);
});

test('manifest roundtrip validates structure, version and recomputed identity', () => {
  const identity = identifySource('https://www.bilibili.com/video/BV1Aa411c7mD?p=2');
  assert.equal(sourceIdentityFromManifest(sourceIdentityToManifestDict(identity))?.canonicalUrl,
    'https://www.bilibili.com/video/BV1Aa411c7mD?p=2');
  // 版本不对、平台越界、canonical 与重算不一致都算无效。
  const mutated = sourceIdentityToManifestDict(identity);
  assert.equal(sourceIdentityFromManifest({...mutated, version: 2}), null);
  assert.equal(sourceIdentityFromManifest({...mutated, platform: 'weibo'}), null);
  assert.equal(sourceIdentityFromManifest({...mutated, stable_id: ''}), null);
  assert.equal(sourceIdentityFromManifest({...mutated, effective_part: true}), null);
  assert.equal(sourceIdentityFromManifest({...mutated, canonical_url: 'https://x'}), null);
  assert.equal(sourceIdentityFromManifest('text'), null);
  assert.equal(canonicalUrlForPersistence(identity), 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2');
  assert.equal(canonicalUrlForPersistence(null), null);
});

test('normalizeBilibiliId keeps the canonical BV prefix and avid form', () => {
  assert.equal(normalizeBilibiliId('bv1Aa411c7mD'), 'BV1Aa411c7mD');
  assert.equal(normalizeBilibiliId('AV170001'), 'av170001');
  assert.equal(normalizeBilibiliId('nope'), null);
});

test('direct resolution never consults short-link adapters', async () => {
  const received = [];
  const adapter = {
    platform: 'bilibili',
    hosts: new Set(['b23.tv']),
    resolve: async (value) => {
      received.push(value);
      return null;
    },
  };
  const resolver = new SourceResolver([adapter]);
  const request = await resolver.resolveRequest('https://www.bilibili.com/video/BV1Aa411c7mD?p=2&token=secret');
  assert.equal(request.downloadUrl.endsWith('token=secret'), true);
  assert.equal(request.identity.canonicalUrl, 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2');
  assert.deepEqual(received, []);
  // 适配器命中也只接受同平台的身份。
  const resolvingAdapter = {
    platform: 'bilibili',
    hosts: new Set(['b23.tv']),
    resolve: async () => 'https://www.douyin.com/video/7524373044106677544',
  };
  await assert.rejects(
    () => new SourceResolver([resolvingAdapter]).resolveRequest('https://b23.tv/demo'),
    SourceIdentityError,
  );
});

test('sanitize replaces known urls and removes untrusted ones', async () => {
  const request = await resolveSourceRequest('https://www.bilibili.com/video/BV1Aa411c7mD?p=2&token=secret');
  const sanitized = sanitizeSourceText(
    '看这个 https://www.bilibili.com/video/BV1Aa411c7mD?p=2&token=secret 和 '
      + 'https://example.com/leak?a=review-secret，还有视频页 https://www.bilibili.com/video/av170001?p=1&token=x。',
    request,
  );
  assert.equal(sanitized.includes('token=secret'), false);
  assert.equal(sanitized.includes('https://www.bilibili.com/video/BV1Aa411c7mD?p=2'), true);
  assert.equal(sanitized.includes('https://example.com/leak?a=review-secret'), false);
  assert.equal(sanitized.includes('[source URL removed]'), true);
  assert.equal(sanitized.includes('https://www.bilibili.com/video/av170001'), true);
});

test('resolveSourceIdentityOnce mirrors the python result shapes', async () => {
  assert.deepEqual(await resolveSourceIdentityOnce('not json'), {status: 'failed', error: {code: 'INVALID_SOURCE_IDENTITY_JSON'}});
  assert.deepEqual(await resolveSourceIdentityOnce('{}'), {status: 'failed', error: {code: 'INVALID_SOURCE_IDENTITY_PAYLOAD'}});
  assert.deepEqual(await resolveSourceIdentityOnce('[]'), {status: 'failed', error: {code: 'INVALID_SOURCE_IDENTITY_PAYLOAD'}});
  assert.deepEqual(await resolveSourceIdentityOnce(JSON.stringify({url: '   '})),
    {status: 'failed', error: {code: 'INVALID_SOURCE_IDENTITY_PAYLOAD'}});
  assert.deepEqual(await resolveSourceIdentityOnce(JSON.stringify({url: 'https://example.com/watch/1'})),
    {status: 'failed', error: {code: 'SOURCE_IDENTITY_UNAVAILABLE'}});
  const completed = await resolveSourceIdentityOnce(JSON.stringify({
    url: 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2&spm_id_from=secret',
  }));
  assert.deepEqual(completed, {
    status: 'completed',
    source_url: 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2',
    source_identity: {
      version: 1, platform: 'bilibili', stable_id: 'BV1Aa411c7mD',
      effective_part: 2, canonical_url: 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2',
    },
  });
});
