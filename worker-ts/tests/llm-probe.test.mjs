// BYOK 探针的单元测试。
//
// 对齐 `worker/tests/test_llm_probe.py` 的场景分组：请求校验闭集、HTTP 状态分类、
// 网络与超时、成功路径。fake 传输直接给 `fetchImpl`，不打真实网络。
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {runLlmProbe, LLM_PROBE_ERROR_CODES} from '../src/ai/llm-probe.ts';

function fetchReturning(status, body) {
  return async () => ({status, body});
}

const VALID_REQUEST = JSON.stringify({
  base_url: 'https://api.example.io/v1',
  api_key: ' sk-test ',
  model: 'gpt-test',
  provider: 'openai',
});

test('valid request goes out as a minimal chat call and succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, body: JSON.parse(init.body), auth: init.headers.Authorization});
    return {status: 200, body: JSON.stringify({choices: [{message: {role: 'assistant', content: 'pong'}}]})};
  };
  const result = await runLlmProbe(VALID_REQUEST, {fetchImpl});
  assert.deepEqual(result, {ok: true, error_code: null, latency_ms: result.latency_ms});
  assert.equal(result.latency_ms >= 0, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.io/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'gpt-test');
  assert.equal(calls[0].body.max_tokens, 1);
  assert.deepEqual(calls[0].body.messages, [{role: 'user', content: 'ping'}]);
  assert.equal(calls[0].body.stream, false);
  assert.equal('tools' in calls[0].body, false);
});

test('request validation is a closed set', async () => {
  for (const raw of [
    undefined,
    '',
    'not json',
    '[]',
    'null',
    '"text"',
    JSON.stringify({base_url: 'https://x', api_key: 'k', model: 'm'}),
    JSON.stringify({base_url: 'https://x', api_key: 'k', model: 'm', provider: 'openai', extra: 1}),
    JSON.stringify({base_url: 'https://x', api_key: 'k', model: 3, provider: 'openai'}),
    JSON.stringify({base_url: 'https://x', api_key: 'k', model: 'm', provider: 'anthropic'}),
  ]) {
    const result = await runLlmProbe(raw);
    assert.deepEqual(result, {ok: false, error_code: 'LLM_PROBE_INVALID_REQUEST', latency_ms: result.latency_ms});
  }
});

test('http status codes map to the probe error codes', async () => {
  for (const [status, expected] of [
    [401, 'LLM_PROBE_AUTH_FAILED'],
    [403, 'LLM_PROBE_AUTH_FAILED'],
    [404, 'LLM_PROBE_MODEL_NOT_FOUND'],
    [429, 'LLM_PROBE_RATE_LIMITED'],
    [500, 'LLM_PROBE_UNEXPECTED_ERROR'],
    [400, 'LLM_PROBE_UNEXPECTED_ERROR'],
  ]) {
    const result = await runLlmProbe(VALID_REQUEST, {fetchImpl: fetchReturning(status, '{}')});
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(result.error_code, expected, `status ${status}`);
  }
});

test('400 with unknown-model wording is a model-not-found probe failure', async () => {
  const result = await runLlmProbe(VALID_REQUEST, {
    fetchImpl: fetchReturning(400, JSON.stringify({error: {message: 'Model gpt-x does not exist'}})),
  });
  assert.equal(result.error_code, 'LLM_PROBE_MODEL_NOT_FOUND');
});

test('unreadable responses map to invalid response', async () => {
  for (const body of ['not json', '{}', JSON.stringify({choices: []}), '§§']) {
    const result = await runLlmProbe(VALID_REQUEST, {fetchImpl: fetchReturning(200, body)});
    assert.equal(result.ok, false, body);
    assert.equal(result.error_code, 'LLM_PROBE_INVALID_RESPONSE', body);
  }
});

test('fetch rejections classify as network or timeout', async () => {
  const network = await runLlmProbe(VALID_REQUEST, {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(network.error_code, 'LLM_PROBE_NETWORK_ERROR');
  const timeout = await runLlmProbe(VALID_REQUEST, {
    fetchImpl: async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
  });
  assert.equal(timeout.error_code, 'LLM_PROBE_TIMEOUT');
});

test('empty base url falls back to the official endpoint; empty key still goes out', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {status: 401, body: '{}'};
  };
  const result = await runLlmProbe(JSON.stringify({
    base_url: '  ', api_key: '', model: '  m  ', provider: 'openai_compatible',
  }), {fetchImpl});
  assert.equal(result.error_code, 'LLM_PROBE_AUTH_FAILED');
  assert.equal(calls[0], 'https://api.openai.com/v1/chat/completions');
});

test('error code set is closed and matches python', () => {
  assert.deepEqual([...LLM_PROBE_ERROR_CODES].sort(), [
    'LLM_PROBE_AUTH_FAILED',
    'LLM_PROBE_INVALID_REQUEST',
    'LLM_PROBE_INVALID_RESPONSE',
    'LLM_PROBE_MODEL_NOT_FOUND',
    'LLM_PROBE_NETWORK_ERROR',
    'LLM_PROBE_RATE_LIMITED',
    'LLM_PROBE_TIMEOUT',
    'LLM_PROBE_UNEXPECTED_ERROR',
  ]);
});
