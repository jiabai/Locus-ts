// URL 任务请求的基准比对：字段闭集、版本号、模型白名单、URL 裁剪与固定失败文案。
// 基准由 `scripts/tests/process-request-golden.py` 从 Python 生产源码生成。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  DESKTOP_ASR_MODELS,
  PROCESS_VIDEO_CONTRACT_VERSION,
} from '../src/protocol/contract.ts';
import {
  INVALID_PROCESS_PAYLOAD_CODE,
  INVALID_PROCESS_PAYLOAD_MESSAGE,
  InvalidProcessRequestError,
  parseProcessVideoRequest,
} from '../src/protocol/process-request.ts';

const GOLDEN = JSON.parse(
  await readFile(new URL('./fixtures/process-request-golden.json', import.meta.url), 'utf8'),
);

function attempt(payload) {
  try {
    const request = parseProcessVideoRequest(payload);
    return {ok: true, url: request.url, asr_model: request.asrModel};
  } catch (error) {
    if (!(error instanceof InvalidProcessRequestError)) throw error;
    return {ok: false, error: error.message};
  }
}

test('constants match the python request contract', () => {
  assert.deepEqual(GOLDEN.fields, ['asr_model', 'contract_version', 'url']);
  assert.equal(GOLDEN.contract_version, PROCESS_VIDEO_CONTRACT_VERSION);
  assert.equal(GOLDEN.message, INVALID_PROCESS_PAYLOAD_MESSAGE);
  assert.deepEqual(GOLDEN.models, [...DESKTOP_ASR_MODELS].sort());
});

test('every golden case matches the python decision and normalized url', () => {
  assert.ok(GOLDEN.cases.length >= 30, 'golden 数量不足');
  for (const {label, payload, result} of GOLDEN.cases) {
    assert.deepEqual(attempt(payload), result, `判定不一致：${label}`);
  }
});

test('the error carries the application-layer failure code and fixed message', () => {
  const error = new InvalidProcessRequestError();
  assert.equal(error.code, 'INVALID_REQUEST_PAYLOAD');
  assert.equal(error.code, INVALID_PROCESS_PAYLOAD_CODE);
  assert.equal(error.message, INVALID_PROCESS_PAYLOAD_MESSAGE);
  assert.equal(error.name, 'InvalidProcessRequestError');
});

test('python-only whitespace is stripped while U+FEFF is preserved', () => {
  const base = {contract_version: 3, asr_model: 'iic/SenseVoiceSmall-onnx'};
  assert.equal(
    parseProcessVideoRequest({...base, url: '\u001c\u0085https://example.com/v\u001f'}).url,
    'https://example.com/v',
  );
  assert.equal(
    parseProcessVideoRequest({...base, url: '\ufeffhttps://example.com/v\ufeff'}).url,
    '\ufeffhttps://example.com/v\ufeff',
  );
});
