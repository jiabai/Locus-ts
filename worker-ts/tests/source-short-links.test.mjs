// 三平台短链适配器的单元测试（fake fetch，不打真实网络）。
// 场景对齐 `worker/tests/test_source_resolution.py` 的短链分组与各平台 source 测试：
// 重定向 / 最终 URL / 正文内嵌 URL / http→https 重试 / 平台不匹配拒止 / 失败收敛 null。
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildDefaultSourceResolver} from '../src/sources/platform-short-links.ts';
import {PageFetchError} from '../src/sources/short-link-http.ts';
import {SourceResolver} from '../src/sources/source-resolution.ts';
import {SourceIdentityError} from '../src/sources/source-identity.ts';

const XHS_NOTE_ID = '64a1b2c3d4e5f67890123456';

/** 极简 fake fetch：按注册表返回响应；支持 302 与正文。 */
function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((candidate) => url.startsWith(candidate));
    const route = key === undefined ? undefined : routes[key];
    if (!route) {
      throw new PageFetchError(`fake fetch: no route for ${url}`);
    }
    if (route.redirect) {
      return {
        status: 302,
        header: (name) => (name.toLowerCase() === 'location' ? route.redirect : null),
        url,
        body: new TextEncoder().encode(''),
      };
    }
    return {
      status: 200,
      header: () => null,
      url: route.finalUrl ?? url,
      body: new TextEncoder().encode(route.body ?? ''),
    };
  };
}

function resolverWith(routes) {
  const fetch = fakeFetch(routes);
  return new SourceResolver(buildDefaultSourceResolver(fetch));
}

test('bilibili short link resolves via redirect, final url and embedded url', async () => {
  // 302 Location
  const viaRedirect = await resolverWith({
    'https://b23.tv/demo': {redirect: 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2&spm_id_from=x'},
  }).resolveRequest('https://b23.tv/demo?token=secret');
  assert.equal(viaRedirect.identity.canonicalUrl, 'https://www.bilibili.com/video/BV1Aa411c7mD?p=2');
  assert.equal(viaRedirect.identity.effectivePart, 2);

  // 最终 URL（fetch 跟随后的 response.url）
  const viaFinalUrl = await resolverWith({
    'https://b23.tv/direct': {body: '', finalUrl: 'https://www.bilibili.com/video/BV1Aa411c7mD'},
  }).resolveRequest('https://b23.tv/direct');
  assert.equal(viaFinalUrl.identity.canonicalUrl, 'https://www.bilibili.com/video/BV1Aa411c7mD');
});

test('douyin short link resolves via final url or embedded aweme id', async () => {
  // Python 的 douyin 客户端跟随重定向后从 response.url 提取 ID：fake 直接给最终 URL。
  const viaRedirect = await resolverWith({
    'https://v.douyin.com/demo': {finalUrl: 'https://www.douyin.com/video/7524373044106677544?previous_page=x'},
  }).resolveRequest('https://v.douyin.com/demo?token=secret');
  assert.equal(viaRedirect.identity.canonicalUrl, 'https://www.douyin.com/video/7524373044106677544');

  const viaBody = await resolverWith({
    'https://v.douyin.com/page': {
      body: 'something <a href="https://www.douyin.com/note/1?modal_id=7524373044106677544">x</a>',
    },
  }).resolveRequest('https://v.douyin.com/page');
  assert.equal(viaBody.identity.canonicalUrl, 'https://www.douyin.com/video/7524373044106677544');

  // 输入里带 modal_id 的直连：不过网络。
  const direct = await resolverWith({}).resolveRequest(
    'https://www.douyin.com/note/123?modal_id=7524373044106677544&token=secret',
  );
  assert.equal(direct.identity.canonicalUrl, 'https://www.douyin.com/video/7524373044106677544');
});

test('xiaohongshu short link resolves and html entities in the body are unescaped', async () => {
  const viaRedirect = await resolverWith({
    'https://xhslink.com/o/demo': {
      redirect: `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}?xsec_token=resolved-secret`,
    },
  }).resolveRequest('https://xhslink.com/o/demo?xsec_token=review-secret#share');
  assert.equal(viaRedirect.identity.canonicalUrl, `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}`);

  const viaEscapedBody = await resolverWith({
    'https://xhslink.cn/page': {
      body: `<a href="https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}?xsec_token=t&amp;source=x">l</a>`,
    },
  }).resolveRequest('https://xhslink.cn/page');
  assert.equal(viaEscapedBody.identity.canonicalUrl, `https://www.xiaohongshu.com/explore/${XHS_NOTE_ID}`);
});

test('http short links retry over https before giving up', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    if (url.startsWith('http://')) throw new PageFetchError('plain http refused');
    return {
      status: 302,
      header: (name) => (name.toLowerCase() === 'location' ? 'https://www.bilibili.com/video/BV1Aa411c7mD' : null),
      url,
      body: new TextEncoder().encode(''),
    };
  };
  const request = await new SourceResolver(buildDefaultSourceResolver(fetch))
    .resolveRequest('http://b23.tv/demo');
  assert.equal(request.identity.canonicalUrl, 'https://www.bilibili.com/video/BV1Aa411c7mD');
  assert.deepEqual(seen, ['http://b23.tv/demo', 'https://b23.tv/demo']);
});

test('cross-platform adapter output is rejected and the direct error is preserved', async () => {
  // b23.tv 展开成 douyin URL：平台不匹配，继续找下一个适配器，最终抛直连错误。
  await assert.rejects(
    () => resolverWith({
      'https://b23.tv/evil': {redirect: 'https://www.douyin.com/video/7524373044106677544'},
    }).resolveRequest('https://b23.tv/evil'),
    SourceIdentityError,
  );
  // 短链解析失败（无路由 = 网络失败）→ 适配器返回 null → 保留直连错误。
  await assert.rejects(
    () => resolverWith({}).resolveRequest('https://b23.tv/nowhere'),
    /Source URL does not contain a supported stable video ID/u,
  );
});

test('unsupported bilibili content raises through to the identity error', async () => {
  await assert.rejects(
    () => resolverWith({
      'https://b23.tv/bangumi': {redirect: 'https://www.bilibili.com/bangumi/play/ep1'},
    }).resolveRequest('https://b23.tv/bangumi'),
    SourceIdentityError,
  );
});
