const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

/** Extract the first complete JSON object without being confused by braces in strings. */
export function extractFirstJsonObject(text) {
  if (typeof text !== "string") throw new Error("模型没有返回文本结果");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === "{") { start = index; depth = 1; }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error("模型结果不是完整的 JSON 对象");
}

export function parseModelResult(output) {
  let value = output;
  // Workers AI may return the generated value directly or inside `response`.
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "response")) {
    value = value.response;
  }
  if (typeof value === "string") return JSON.parse(extractFirstJsonObject(value));
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new Error("模型结果不是 JSON 对象");
}

const cleanText = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const firstText = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim() || "";

function normalizeCoordinate(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeConfidence(value) {
  let number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number > 0 && number <= 1) number *= 100;
  return Math.round(Math.min(100, Math.max(0, number)));
}

function normalizeEvidence(value, fallback) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const evidence = items.filter((item) => typeof item === "string" && item.trim())
    .slice(0, 8).map((item) => item.trim().slice(0, 300));
  if (!evidence.length && fallback) evidence.push(fallback.slice(0, 300));
  if (!evidence.length) evidence.push("模型未提供详细判断依据，请结合地图核对。");
  return evidence;
}

export function normalizeResult(raw, deep = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型结果结构无效");
  let source = Array.isArray(raw.candidates) ? raw.candidates : [];
  if (!source.length && raw.location) source = [typeof raw.location === "object" ? raw.location : { name: raw.location }];
  if (!source.length && (raw.name || raw.city || raw.country)) source = [raw];

  const summary = cleanText(raw.summary, 500);
  const candidates = source.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const locationObject = item.location && typeof item.location === "object" ? item.location : {};
    const city = firstText(item.city, locationObject.city, item.region, locationObject.region).slice(0, 120);
    const country = firstText(item.country, locationObject.country).slice(0, 100);
    const location = firstText(
      typeof item.location === "string" ? item.location : "",
      item.name, locationObject.name, city && country ? `${city}, ${country}` : city || country,
    ).slice(0, 160);
    if (!location) return null;
    const lat = normalizeCoordinate(item.lat ?? item.latitude ?? locationObject.lat ?? locationObject.latitude, -90, 90);
    const lng = normalizeCoordinate(item.lng ?? item.longitude ?? locationObject.lng ?? locationObject.longitude, -180, 180);
    return {
      location,
      name: location,
      city,
      region: city,
      country,
      lat,
      lng,
      latitude: lat,
      longitude: lng,
      confidence: normalizeConfidence(item.confidence),
      evidence: normalizeEvidence(item.evidence ?? item.reasons ?? item.reason, summary),
    };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence);

  const unique = [];
  for (const candidate of candidates) {
    const key = `${candidate.location}|${candidate.city}|${candidate.country}`.toLocaleLowerCase();
    if (!unique.some((item) => item.key === key)) unique.push({ key, candidate });
  }
  const limited = unique.slice(0, deep ? 5 : 1).map(({ candidate }) => candidate);
  if (!limited.length) throw new Error("模型未返回候选位置");
  const status = String(raw.status || "uncertain").toLowerCase() === "confirmed" ? "confirmed" : "uncertain";
  return { status, summary: summary || "这是根据照片中可见线索得出的最可能位置，请结合判断依据核对。", candidates: limited };
}

function promptFor(deep, retry = false) {
  const count = deep
    ? "进行更广泛的分析，返回至少 1 个、最多 5 个彼此不同且有证据支持的候选，按置信度降序；证据只支持更少候选时不要凑数。"
    : "即使线索很弱，也必须给出最可能的 1 个候选，不得以不确定为由省略候选。";
  const correction = retry ? "你上一次的输出无法通过格式校验。请重新分析图片并严格修正输出格式。" : "";
  return `${correction}你是严谨的全球照片地理定位分析师。仔细检查图中所有可见文字和语言、道路标识、建筑风格、行车方向、车辆与车牌特征、地形、植被、气候、公共设施、店铺标识、路灯、电线杆及其他定位线索。用户没有提供国家或城市提示。${count}
不得虚构看不清的线索。无论 status 是 confirmed 还是 uncertain，candidates 都必须至少包含 1 项；请给出该候选的最合理坐标，确实无法估算时才使用 null。
你的完整回复必须且只能是一个合法 JSON 对象：禁止解释、前后缀文字、Markdown 和代码围栏。严格使用：{"status":"confirmed|uncertain","summary":"中文总结","candidates":[{"location":"地点名称","city":"城市或地区","country":"国家或地区","lat":数字或null,"lng":数字或null,"confidence":0到100的数字,"evidence":["中文判断依据"]}]}`;
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

function safeModelLog(output) {
  let text;
  try { text = typeof output === "string" ? output : JSON.stringify(output); }
  catch { text = "[无法序列化的返回]"; }
  return text.replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, "[图片已脱敏]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已脱敏]")
    .replace(/(?:bearer\s+|api[_-]?key["'=:\s]+)[\w.-]+/gi, "[凭据已脱敏]")
    .slice(0, 1000);
}

export async function requestAnalysis(env, image, deep) {
  let lastOutput;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    lastOutput = await runWithTimeout(env.AI.run(MODEL, {
      prompt: promptFor(deep, attempt === 1),
      image,
      max_tokens: deep ? 1800 : 900,
      temperature: attempt === 1 ? 0 : 0.15,
    }), 55000);
    try { return normalizeResult(parseModelResult(lastOutput), deep); }
    catch (error) { lastError = error; }
  }
  console.warn("Workers AI returned an invalid response after retry", safeModelLog(lastOutput));
  throw new Error("MODEL_OUTPUT_INVALID", { cause: lastError });
}

async function handleAnalyze(request, env) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("multipart/form-data")) return json({ error: "请使用表单上传图片" }, 415);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + 1024 * 1024) return json({ error: "上传内容过大，图片原始大小必须小于 12 MB" }, 413);
  const form = await request.formData();
  const file = form.get("image");
  const deep = form.get("mode") === "deep";
  if (!(file instanceof File)) return json({ error: "请选择一张图片" }, 400);
  if (!ALLOWED_TYPES.has(file.type)) return json({ error: "仅支持 JPG、JPEG、PNG 或 WEBP 图片" }, 415);
  if (!file.size || file.size > MAX_IMAGE_BYTES) return json({ error: "图片原始大小必须小于 12 MB" }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) return json({ error: "文件内容不是有效的 JPG、PNG 或 WEBP 图片" }, 415);
  return json(await requestAnalysis(env, [...bytes], deep));
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
      const message = error instanceof Error ? error.message : "未知错误";
      if (message !== "MODEL_OUTPUT_INVALID") console.error("API error", error);
      if (/license|agreement|agree/i.test(message)) return json({ error: "使用此模型前需要同意 Meta Llama 3.2 许可和可接受使用政策。" }, 428);
      if (message.includes("超时")) return json({ error: message }, 504);
      return json({ error: "AI 服务暂时不可用，请稍后重试。" }, 503);
    }
  },
};
