import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  checkoutManagedLlm,
  derivePerCallRequestId,
  parseManagedCheckoutResponse,
  parseTimeoutSeconds,
  readMaxOutputTokens,
  resolveInsightLlmConfig,
} from "../src/ai/config.ts";
import { createInsightLlm } from "../src/ai/index.ts";

const BYOK_ENV = {
  APP_LLM_API_KEY: "sk-test",
  APP_LLM_MODEL: "gpt-4o-mini",
  APP_LLM_BASE_URL: "https://api.example.test/v1",
};

test("an invalid output budget fails before any checkout", () => {
  // 非法预算是部署配置错误：必须在扣额度之前发现，所以码是 AI_CONFIG_MISSING。
  assert.equal(readMaxOutputTokens({}), 8192);
  assert.equal(readMaxOutputTokens({ APP_LLM_MAX_TOKENS: "4096" }), 4096);
  for (const raw of ["0", "-1", "abc", "1.5", " "]) {
    if (raw === " ") {
      assert.equal(readMaxOutputTokens({ APP_LLM_MAX_TOKENS: raw }), 8192, "空白视同未配置");
      continue;
    }
    assert.throws(
      () => readMaxOutputTokens({ APP_LLM_MAX_TOKENS: raw }),
      (error) => {
        assert.equal(error.code, "AI_CONFIG_MISSING");
        assert.equal(error.message, "Insight agent output token budget is invalid.");
        return true;
      },
      raw,
    );
  }
});

test("the timeout falls back to 60 seconds unless it is a positive number", () => {
  assert.equal(parseTimeoutSeconds(undefined), 60);
  assert.equal(parseTimeoutSeconds("30"), 30);
  assert.equal(parseTimeoutSeconds(" 12.5 "), 12.5);
  for (const raw of ["0", "-1", "abc", ""]) {
    assert.equal(parseTimeoutSeconds(raw), 60, raw);
  }
});

test("per-call request ids keep the suffix and truncate the seed", () => {
  assert.equal(derivePerCallRequestId("req-1", 1), "req-1-call-0001");
  assert.equal(derivePerCallRequestId("req-1", 12), "req-1-call-0012");

  const long = "x".repeat(200);
  const derived = derivePerCallRequestId(long, 3);
  assert.equal(derived.length, 160);
  assert.equal(derived.endsWith("-call-0003"), true);
});

test("byok configuration is read from the documented environment keys", () => {
  const config = resolveInsightLlmConfig(BYOK_ENV);
  assert.equal(config.mode, "byok");
  assert.equal(config.apiKey, "sk-test");
  assert.equal(config.model, "gpt-4o-mini");
  assert.equal(config.baseUrl, "https://api.example.test/v1");
  assert.equal(config.provider, "openai_compatible");
  assert.equal(config.maxOutputTokens, 8192);

  // base url 与 provider 都有默认值；提供方只接受两个值。
  const minimal = resolveInsightLlmConfig({ APP_LLM_API_KEY: "k", APP_LLM_MODEL: "m" });
  assert.equal(minimal.baseUrl, "https://api.openai.com/v1");
  assert.equal(minimal.provider, "openai_compatible");
});

test("missing byok settings fail with the fixed message", () => {
  for (const environ of [
    {},
    { APP_LLM_API_KEY: "k" },
    { APP_LLM_MODEL: "m" },
    { ...BYOK_ENV, APP_LLM_PROVIDER: "anthropic" },
    { ...BYOK_ENV, APP_LLM_API_KEY: "   " },
  ]) {
    assert.throws(
      () => resolveInsightLlmConfig(environ),
      (error) => {
        assert.equal(error.code, "AI_CONFIG_MISSING");
        assert.equal(error.message, "Insight agent LLM is not configured.");
        return true;
      },
    );
  }
});

test("server mode requires all three checkout settings", () => {
  const base = {
    APP_LLM_SOURCE: "server",
    APP_LLM_CHECKOUT_URL: "https://server.test/checkout",
    APP_LLM_SESSION_TOKEN: "session",
    APP_LLM_CHECKOUT_REQUEST_ID: "req-1",
  };
  const config = resolveInsightLlmConfig(base);
  assert.equal(config.mode, "managed");
  assert.equal(config.requestId, "req-1");

  for (const key of ["APP_LLM_CHECKOUT_URL", "APP_LLM_SESSION_TOKEN", "APP_LLM_CHECKOUT_REQUEST_ID"]) {
    const incomplete = { ...base };
    delete incomplete[key];
    assert.throws(() => resolveInsightLlmConfig(incomplete), (error) => error.code === "AI_CONFIG_MISSING", key);
  }
});

test("checkout responses are validated, not guessed", () => {
  const valid = parseManagedCheckoutResponse(JSON.stringify({
    provider: "openai",
    base_url: "https://server.test/v1",
    model: "m",
    api_key: "k",
    timeout_seconds: 30,
  }));
  assert.deepEqual(
    { provider: valid.provider, baseUrl: valid.baseUrl, model: valid.model, apiKey: valid.apiKey, timeoutSeconds: valid.timeoutSeconds },
    { provider: "openai", baseUrl: "https://server.test/v1", model: "m", apiKey: "k", timeoutSeconds: 30 },
  );
  // 缺 timeout_seconds 用默认值，不报错。
  assert.equal(
    parseManagedCheckoutResponse(JSON.stringify({ provider: "openai_compatible", base_url: "u", model: "m", api_key: "k" })).timeoutSeconds,
    60,
  );

  for (const raw of [
    "not json",
    "{}",
    JSON.stringify({ provider: "anthropic", base_url: "u", model: "m", api_key: "k" }),
    JSON.stringify({ provider: "openai", base_url: "", model: "m", api_key: "k" }),
    JSON.stringify({ provider: "openai", base_url: "u", model: "", api_key: "k" }),
    JSON.stringify({ provider: "openai", base_url: "u", model: "m", api_key: "" }),
  ]) {
    assert.throws(
      () => parseManagedCheckoutResponse(raw),
      (error) => error.code === "AI_LLM_CHECKOUT_INVALID_RESPONSE",
      raw,
    );
  }
});

test("checkout http failures map to auth, quota and config codes", async () => {
  const config = resolveInsightLlmConfig({
    APP_LLM_SOURCE: "server",
    APP_LLM_CHECKOUT_URL: "https://server.test/checkout",
    APP_LLM_SESSION_TOKEN: "session",
    APP_LLM_CHECKOUT_REQUEST_ID: "req-1",
  });

  const respond = (status, body) => async () => ({ status, body });
  const cases = [
    [respond(401, "{}"), "AI_LLM_AUTH_REQUIRED"],
    [respond(403, "{}"), "AI_LLM_QUOTA_UNAVAILABLE"],
    [respond(400, JSON.stringify({ error: "LLM_CONFIG_MISSING" })), "AI_LLM_CONFIG_MISSING"],
    [respond(500, "{}"), "AI_LLM_CHECKOUT_FAILED"],
  ];
  for (const [transport, code] of cases) {
    await assert.rejects(
      () => checkoutManagedLlm(config, { transport }),
      (error) => {
        assert.equal(error.code, code);
        return true;
      },
    );
  }

  // 传输层异常：超时单独成码，其余归为 checkout 失败。
  const timeout = new Error("timeout");
  timeout.name = "TimeoutError";
  await assert.rejects(
    () => checkoutManagedLlm(config, { transport: async () => { throw timeout; } }),
    (error) => error.code === "AI_LLM_CHECKOUT_TIMEOUT",
  );
});

test("managed mode checks out a fresh endpoint for every model call", async () => {
  const checkoutBodies = [];
  const transport = async (url, init) => {
    checkoutBodies.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return {
      status: 200,
      body: JSON.stringify({
        provider: "openai_compatible",
        base_url: "https://server.test/v1",
        model: "managed-model",
        api_key: "temporary-key",
      }),
    };
  };
  const chatRequests = [];
  const llm = await createInsightLlm(
    {
      APP_LLM_SOURCE: "server",
      APP_LLM_CHECKOUT_URL: "https://server.test/checkout",
      APP_LLM_SESSION_TOKEN: "session-token",
      APP_LLM_CHECKOUT_REQUEST_ID: "req-1",
      APP_LLM_MAX_TOKENS: "2048",
    },
    {
      transport,
      fetchImpl: async (url, init) => {
        chatRequests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "好" } }] }) };
      },
    },
  );

  assert.equal(llm.mode, "managed");
  await llm.chat([{ role: "user", content: "第一次" }]);
  await llm.chat([{ role: "user", content: "第二次" }]);

  // 每次调用一个 request id：服务端按它计量，复用会让计费与配额错位。
  assert.deepEqual(checkoutBodies.map((item) => item.body.request_id), ["req-1-call-0001", "req-1-call-0002"]);
  assert.deepEqual(checkoutBodies.map((item) => item.auth), ["Bearer session-token", "Bearer session-token"]);
  assert.deepEqual(chatRequests.map((item) => item.auth), ["Bearer temporary-key", "Bearer temporary-key"]);
  // 输出预算取本地配置，不被 checkout 响应的默认值覆盖。
  assert.deepEqual(chatRequests.map((item) => item.body.max_tokens), [2048, 2048]);
  assert.deepEqual(chatRequests.map((item) => item.url), [
    "https://server.test/v1/chat/completions",
    "https://server.test/v1/chat/completions",
  ]);
});

test("a real http server round-trip works without any injection", async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, body: JSON.parse(body), auth: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "submit_summary", arguments: '{"markdown":"# 标题"}' } }],
          },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const llm = await createInsightLlm({
    APP_LLM_API_KEY: "sk-test",
    APP_LLM_MODEL: "gpt-test",
    APP_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
  });

  let delivered = null;
  const outcome = await llm.complete({
    messages: [{ role: "user", content: "总结" }],
    tools: [{
      name: "submit_summary",
      description: "Submit the summary",
      parameters: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
      handler: ({ args }) => {
        delivered = args.markdown;
        return null;
      },
    }],
    maxTurns: 2,
  });

  assert.equal(outcome.delivered, true);
  assert.equal(delivered, "# 标题");
  assert.equal(seen[0].url, "/v1/chat/completions");
  assert.equal(seen[0].auth, "Bearer sk-test");
  assert.equal(seen[0].body.model, "gpt-test");
  assert.equal(seen[0].body.tool_choice, "auto");
});
