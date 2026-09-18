import test from "node:test";
import assert from "node:assert/strict";
import worker, { extractFirstJsonObject, normalizeResult, parseModelOutput } from "../src/index.js";

const result = {
  status: "uncertain",
  summary: "线索有限",
  candidates: [{
    name: "巴黎",
    country: "法国",
    region: "法兰西岛",
    latitude: 48.8566,
    longitude: 2.3522,
    confidence: 61,
    evidence: ["建筑风格"],
  }],
};

test("parses a direct JSON string", () => {
  assert.deepEqual(parseModelOutput(JSON.stringify(result)), result);
});

test("parses a Workers AI response wrapper", () => {
  assert.deepEqual(parseModelOutput({ response: JSON.stringify(result) }), result);
});

test("accepts an already deserialized object and nested object response", () => {
  assert.equal(parseModelOutput(result), result);
  assert.equal(parseModelOutput({ response: result }), result);
});

test("extracts JSON from Markdown and surrounding explanation", () => {
  const text = `分析如下：\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n请谨慎核对。`;
  assert.deepEqual(parseModelOutput(text), result);
});

test("extracts the first complete object and respects braces inside strings", () => {
  const first = { ...result, summary: "标牌中出现 {A}，但仍不确定" };
  const text = `前言 ${JSON.stringify(first)} 尾注 ${JSON.stringify({ ignored: true })}`;
  assert.deepEqual(extractFirstJsonObject(text), first);
});

test("normalizes optional fields without discarding a usable candidate", () => {
  const normalized = normalizeResult({
    candidates: [{ location: "里斯本", country: "葡萄牙", lat: "999", lon: "-9.14", confidence: "34%" }],
  });
  assert.equal(normalized.status, "uncertain");
  assert.equal(normalized.candidates[0].name, "里斯本");
  assert.equal(normalized.candidates[0].latitude, null);
  assert.equal(normalized.candidates[0].longitude, -9.14);
  assert.equal(normalized.candidates[0].confidence, 34);
  assert.equal(normalized.candidates[0].evidence.length, 1);
});

test("sorts and limits candidates for initial and deep analysis", () => {
  const raw = { candidates: Array.from({ length: 7 }, (_, index) => ({ name: `地点${index}`, confidence: index * 10 })) };
  assert.deepEqual(normalizeResult(raw).candidates.map(({ confidence }) => confidence), [60]);
  assert.deepEqual(normalizeResult(raw, true).candidates.map(({ confidence }) => confidence), [60, 50, 40, 30, 20]);
});

test("rejects output without any usable location rather than inventing one", () => {
  assert.throws(() => normalizeResult({ status: "uncertain", candidates: [] }), /候选位置/);
});

test("automatically retries once when the first model response is malformed", async () => {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "photo.jpg");
  form.append("mode", "initial");
  let calls = 0;
  const env = {
    AI: { run: async () => (++calls === 1 ? { response: "not json" } : { response: JSON.stringify(result) }) },
    ASSETS: { fetch: () => new Response("asset") },
  };
  const response = await worker.fetch(new Request("https://xuntu.test/api/analyze", { method: "POST", body: form }), env);
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal((await response.json()).candidates[0].name, "巴黎");
});
