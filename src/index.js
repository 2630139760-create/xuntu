const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

class ModelOutputError extends Error {}

// Finds the first balanced JSON object while respecting braces and escapes in strings.
export function extractFirstJsonObject(text) {
  if (typeof text !== "string") throw new ModelOutputError("模型没有返回文本结果");
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        const candidate = text.slice(start, index + 1);
        try { return JSON.parse(candidate); } catch { break; }
      }
    }
  }
  throw new ModelOutputError("模型结果中没有完整的 JSON 对象");
}

export function parseModelOutput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(value.candidates)) return value;
    if (Object.hasOwn(value, "response")) return parseModelOutput(value.response);
    // Some runtimes deserialize a JSON response before returning it.
    return value;
  }
  return extractFirstJsonObject(value);
}

const textValue = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const coordinate = (value, minimum, maximum) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
};

export function normalizeResult(raw, deep = false) {
  if (!raw || typeof raw !== "object") throw new ModelOutputError("模型结果结构无效");
  const sourceCandidates = Array.isArray(raw.candidates) ? raw.candidates :
    (raw.candidate && typeof raw.candidate === "object" ? [raw.candidate] : []);
  const candidates = sourceCandidates.map((item) => {
    if (!item || typeof item !== "object") return null;
    const country = textValue(item.country, 100);
    const region = textValue(item.region ?? item.city, 120);
    const name = textValue(item.name ?? item.location, 160) || region || country;
    if (!name) return null;
    const parsedConfidence = Number.parseFloat(String(item.confidence ?? ""));
    const confidence = Number.isFinite(parsedConfidence) ? Math.min(100, Math.max(0, Math.round(parsedConfidence))) : 20;
    const rawEvidence = Array.isArray(item.evidence) ? item.evidence :
      (typeof item.evidence === "string" ? [item.evidence] : []);
    const evidence = rawEvidence.map((value) => textValue(value, 300)).filter(Boolean).slice(0, 8);
    return {
      name, country, region,
      latitude: coordinate(item.latitude ?? item.lat, -90, 90),
      longitude: coordinate(item.longitude ?? item.lng ?? item.lon, -180, 180),
      confidence,
      evidence: evidence.length ? evidence : ["模型未提供详细判断依据，请谨慎核对此推测。"],
    };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence).slice(0, deep ? 5 : 1);
  if (!candidates.length) throw new ModelOutputError("模型未返回可用的候选位置");
  const status = raw.status === "confirmed" ? "confirmed" : "uncertain";
  return { status, summary: textValue(raw.summary, 500), candidates };
}

function promptFor(deep, retry = false) {
  const count = deep ? "返回最多 5 个彼此不同、按置信度降序排列的候选；证据只支持更少候选时绝对不要凑数。" : "只返回最可能的 1 个候选。";
  const retryInstruction = retry ? "上一次回答格式无效。这是自动格式修复重试，务必严格遵循输出格式。" : "";
  return `${retryInstruction}你是严谨的全球照片地理定位分析师。仔细检查图中所有可见文字和语言、道路标识、建筑风格、行车方向、车辆与车牌特征、地形、植被、气候、公共设施、店铺标识、路灯、电线杆，以及任何其他可定位线索。用户没有提供国家或城市提示。${count}
无论证据强弱，candidates 都必须至少包含一个最可能的位置；可以给低置信度，但不得回答无法判断或返回空数组。不要虚构看不清的证据。坐标不能合理确定时必须为 null。
你的完整回答必须且只能是一个可由 JSON.parse 解析的 JSON 对象。禁止输出解释文字、Markdown、代码围栏或 JSON 之外的任何字符。严格结构：{"status":"confirmed或uncertain","summary":"中文总结","candidates":[{"name":"地点名称","country":"国家","region":"地区或城市","latitude":数字或null,"longitude":数字或null,"confidence":0到100的数字,"evidence":["中文依据"]}]}`;
}

function safeOutputForLog(output) {
  let value;
  try { value = typeof output === "string" ? output : JSON.stringify(output); } catch { value = "[unserializable output]"; }
  return String(value ?? "[empty output]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, "[redacted-number]")
    .slice(0, 1500);
}

async function runWithTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("分析超时，请稍后重试")), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function handleLicense(env) {
  await runWithTimeout(env.AI.run(MODEL, { prompt: "agree" }), 30000);
  return json({ ok: true });
}

async function handleAnalyze(request, env) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("multipart/form-data")) return json({ error: "请使用表单上传图片" }, 415);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + 1024 * 1024) {
    return json({ error: "上传内容过大，图片原始大小必须小于 12 MB" }, 413);
  }
  const form = await request.formData();
  const file = form.get("image");
  const deep = form.get("mode") === "deep";
  if (!(file instanceof File)) return json({ error: "请选择一张图片" }, 400);
  if (!ALLOWED_TYPES.has(file.type)) return json({ error: "仅支持 JPG、JPEG、PNG 或 WEBP 图片" }, 415);
  if (!file.size || file.size > MAX_IMAGE_BYTES) return json({ error: "图片原始大小必须小于 12 MB" }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) return json({ error: "文件内容不是有效的 JPG、PNG 或 WEBP 图片" }, 415);
  // Workers AI vision models accept the encoded image as an array of byte values.
  const image = [...bytes];
  const runAnalysis = (retry) => runWithTimeout(env.AI.run(MODEL, {
    prompt: promptFor(deep, retry),
    image,
    max_tokens: deep ? 1800 : 900,
    temperature: retry ? 0 : 0.15,
  }), 55000);

  let output = await runAnalysis(false);
  try {
    return json(normalizeResult(parseModelOutput(output), deep));
  } catch (error) {
    if (!(error instanceof ModelOutputError) && !(error instanceof SyntaxError)) throw error;
    // A malformed answer is retried once with a stricter formatting instruction before the UI sees an error.
    output = await runAnalysis(true);
    try {
      return json(normalizeResult(parseModelOutput(output), deep));
    } catch (retryError) {
      console.error("Workers AI returned unusable output after format retry", {
        error: retryError instanceof Error ? retryError.message : "unknown parse error",
        output: safeOutputForLog(output),
      });
      throw new ModelOutputError("模型在格式修复后仍未返回可用结果");
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "仅支持 POST 请求" }, 405);
    try {
      if (url.pathname === "/api/license") return await handleLicense(env);
      if (url.pathname === "/api/analyze") return await handleAnalyze(request, env);
      return json({ error: "接口不存在" }, 404);
    } catch (error) {
      console.error("API error", error);
      const message = error instanceof Error ? error.message : "未知错误";
      if (/license|agreement|agree/i.test(message)) return json({ error: "使用此模型前需要同意 Meta Llama 3.2 许可和可接受使用政策。" }, 428);
      if (message.includes("超时")) return json({ error: message }, 504);
      if (error instanceof ModelOutputError || error instanceof SyntaxError) return json({ error: "AI 暂时未能生成有效的位置结果，请稍后重试。" }, 502);
      return json({ error: "分析暂时不可用，请稍后重试。" }, 500);
    }
  },
};
