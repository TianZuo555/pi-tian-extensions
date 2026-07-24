import assert from "node:assert/strict";
import test from "node:test";
import { queryCodexUsage } from "../packages/pi-usage/lib/providers.ts";

const validCodexUsage = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 25,
      limit_window_seconds: 18_000,
      reset_at: 1_800_000_000,
    },
  },
};

function jsonResponse(body, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

test("Codex usage retries one transient network failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("temporary network failure");
    return jsonResponse(validCodexUsage);
  };

  const report = await queryCodexUsage("test-token", undefined, 50, 1);
  assert.equal(calls, 2);
  assert.equal(report.plan, "plus");
  assert.equal(report.windows[0]?.remainingPercent, 75);
});

test("Codex usage retries after a per-attempt timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }
    return jsonResponse(validCodexUsage);
  };

  const report = await queryCodexUsage("test-token", undefined, 5, 1);
  assert.equal(calls, 2);
  assert.equal(report.windows.length, 1);
});

test("Codex usage does not retry authentication failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ detail: "invalid token" }, 401, "Unauthorized");
  };

  await assert.rejects(
    queryCodexUsage("test-token", undefined, 50, 1),
    /401 Unauthorized/,
  );
  assert.equal(calls, 1);
});

test("Codex usage honors caller cancellation without starting a request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(validCodexUsage);
  };

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    queryCodexUsage("test-token", controller.signal, 50, 1),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(calls, 0);
});
