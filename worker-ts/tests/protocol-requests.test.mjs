import assert from "node:assert/strict";
import test from "node:test";

import { parseProcessLocalMediaRequest } from "../src/protocol/requests.ts";
import { readStdinRequest, StdinRequestError } from "../src/protocol/stdin.ts";

const VALID = {
  contract_version: 4,
  source_path: "C:\\Users\\me\\Videos\\采访 01.wav",
  media_kind: "audio",
  safe_display_name: "采访 01.wav",
  source_extension: "wav",
  asr_model: "iic/SenseVoiceSmall-onnx",
};

function without(key) {
  const copy = { ...VALID };
  delete copy[key];
  return copy;
}

test("a well-formed local media request parses into the worker shape", () => {
  const request = parseProcessLocalMediaRequest(VALID);
  assert.deepEqual(request, {
    sourcePath: "C:\\Users\\me\\Videos\\采访 01.wav",
    mediaKind: "audio",
    safeDisplayName: "采访 01.wav",
    sourceExtension: "wav",
    asrModel: "iic/SenseVoiceSmall-onnx",
  });
});

test("the request field set is exact in both directions", () => {
  assert.throws(() => parseProcessLocalMediaRequest({ ...VALID, extra: 1 }), /invalid/);
  for (const key of Object.keys(VALID)) {
    assert.throws(() => parseProcessLocalMediaRequest(without(key)), /invalid/, `缺少 ${key} 应当失败`);
  }
  assert.throws(() => parseProcessLocalMediaRequest(null), /invalid/);
  assert.throws(() => parseProcessLocalMediaRequest([VALID]), /invalid/);
  assert.throws(() => parseProcessLocalMediaRequest("{}"), /invalid/);
});

test("the contract version must be the integer 4", () => {
  assert.throws(() => parseProcessLocalMediaRequest({ ...VALID, contract_version: 3 }), /invalid/);
  assert.throws(() => parseProcessLocalMediaRequest({ ...VALID, contract_version: "4" }), /invalid/);
  assert.throws(() => parseProcessLocalMediaRequest({ ...VALID, contract_version: true }), /invalid/);
});

test("paths must be absolute and agree with the declared extension", () => {
  assert.throws(
    () => parseProcessLocalMediaRequest({ ...VALID, source_path: "Videos/采访 01.wav" }),
    /invalid/,
  );
  // 声明 wav 但路径是 mp3：两侧对同一个文件的认知不同。
  assert.throws(
    () => parseProcessLocalMediaRequest({ ...VALID, source_path: "C:\\Users\\me\\Videos\\采访 01.mp3" }),
    /invalid/,
  );
  assert.throws(() => parseProcessLocalMediaRequest({ ...VALID, source_extension: "mp4" }), /invalid/);
});

test("media kind drives which extensions are accepted", () => {
  assert.throws(() => parseProcessLocalMediaRequest({ ...VALID, media_kind: "image" }), /invalid/);
  const video = {
    ...VALID,
    media_kind: "video",
    source_path: "C:\\Users\\me\\Videos\\采访 01.mp4",
    safe_display_name: "采访 01.mp4",
    source_extension: "mp4",
  };
  assert.equal(parseProcessLocalMediaRequest(video).mediaKind, "video");
});

test("display names are treated as the untrusted strings they are", () => {
  for (const name of [
    "../escape.wav",
    "C:\\Users\\me\\a.wav",
    "采访\u202Efdp.wav",
    "采访.wav.mp3",
    "..",
    ` ${"a".repeat(200)}.wav`,
  ]) {
    assert.throws(
      () => parseProcessLocalMediaRequest({ ...VALID, safe_display_name: name }),
      /invalid/,
      JSON.stringify(name),
    );
  }
});

test("only the closed model set is accepted", () => {
  // PyTorch 标识仍在契约闭集里（宿主可能传），由管线按「本 worker 不支持」拒止。
  assert.equal(
    parseProcessLocalMediaRequest({ ...VALID, asr_model: "iic/SenseVoiceSmall" }).asrModel,
    "iic/SenseVoiceSmall",
  );
  assert.throws(
    () => parseProcessLocalMediaRequest({ ...VALID, asr_model: "iic/Unknown" }),
    /invalid/,
  );
});

async function* streamOf(...chunks) {
  for (const chunk of chunks) yield Buffer.from(chunk);
}

test("stdin accepts exactly one JSON object", async () => {
  const payload = await readStdinRequest(streamOf(JSON.stringify(VALID)));
  assert.deepEqual(payload, VALID);

  // 分块到达的请求也要能拼起来。
  const text = JSON.stringify(VALID);
  const split = await readStdinRequest(streamOf(text.slice(0, 10), text.slice(10)));
  assert.deepEqual(split, VALID);
});

test("stdin rejects oversize, non-UTF-8, empty and non-object payloads", async () => {
  const oversize = async function* () {
    yield Buffer.alloc(8 * 1024 * 1024, 0x20);
  };
  await assert.rejects(() => readStdinRequest(oversize()), StdinRequestError);

  const invalidUtf8 = async function* () {
    yield Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
  };
  await assert.rejects(() => readStdinRequest(invalidUtf8()), StdinRequestError);

  await assert.rejects(() => readStdinRequest(streamOf("   \n")), StdinRequestError);
  await assert.rejects(() => readStdinRequest(streamOf("[1,2]")), StdinRequestError);
  await assert.rejects(() => readStdinRequest(streamOf("null")), StdinRequestError);
  await assert.rejects(() => readStdinRequest(streamOf("{not json")), StdinRequestError);

  const empty = async function* () {};
  await assert.rejects(() => readStdinRequest(empty()), StdinRequestError);
});
