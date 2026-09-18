import test from "node:test";
import assert from "node:assert/strict";
import { extractFirstJsonObject, parseModelResult, normalizeResult, requestAnalysis } from "../src/index.js";

const payload = { status: "uncertain", summary: "线索有限", candidates: [{ location: "上海外滩", city: "上海", country: "中国", lat: 31.2401, lng: 121.4905, confidence: 0.62, evidence: ["临江建筑"] }] };

test("parses all supported Workers AI response shapes", () => {
  for (const value of [JSON.stringify(payload), { response: JSON.stringify(payload) }, { response: payload }, payload, { response: `说明文字\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n结束` }]) {
    assert.deepEqual(parseModelResult(value), payload);
  }
});

test("extracts the first balanced object while respecting strings and escapes", () => {
  const first = { summary: "括号 } 和转义引号 \\\" 不会提前结束", candidates: [{ name: "A" }] };
  const text = `前言 ${JSON.stringify(first)} 后记 {"ignored":true}`;
  assert.deepEqual(JSON.parse(extractFirstJsonObject(text)), first);
});

test("initial normalization always returns the single most likely candidate", () => {
  const result = normalizeResult({ status: "uncertain", summary: "判断", candidates: [
    { name: "次选", confidence: 20, evidence: "道路" },
    { location: { name: "首选", city: "巴黎", country: "法国", lat: "48.8566", lng: "2.3522" }, confidence: 80 },
  ] }, false);
  assert.equal(result.status, "uncertain");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].location, "首选");
  assert.equal(result.candidates[0].latitude, 48.8566);
  assert.ok(result.candidates[0].evidence.length >= 1);
});

test("deep normalization returns one to five distinct candidates", () => {
  const candidates = Array.from({ length: 7 }, (_, index) => ({ name: `地点 ${index}`, confidence: 90 - index, evidence: [`依据 ${index}`] }));
  candidates.splice(1, 0, { ...candidates[0] });
  const result = normalizeResult({ status: "confirmed", candidates }, true);
  assert.equal(result.candidates.length, 5);
  assert.equal(new Set(result.candidates.map((item) => item.location)).size, 5);
});

test("degrades gracefully for missing optional fields and alternate top-level location", () => {
  const result = normalizeResult({ location: "未知山区", status: "anything" });
  assert.equal(result.status, "uncertain");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].confidence, 0);
  assert.deepEqual([result.candidates[0].lat, result.candidates[0].lng], [null, null]);
});

test("automatically retries once with a stricter prompt after invalid model output", async () => {
  const prompts = [];
  const env = { AI: { run: async (_model, input) => {
    prompts.push(input.prompt);
    return prompts.length === 1 ? { response: "not json" } : { response: payload };
  } } };
  const result = await requestAnalysis(env, [1, 2, 3], false);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /上一次的输出无法通过格式校验/);
  assert.equal(result.candidates.length, 1);
});
