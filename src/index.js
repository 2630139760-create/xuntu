const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function cleanModelJson(value) {
  if (typeof value !== "string") throw new Error("模型没有返回文本结果");
  let text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型结果不是有效的 JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeResult(raw, deep) {
  if (!raw || !["confirmed", "uncertain"].includes(raw.status) || !Array.isArray(raw.candidates)) {
    throw new Error("模型结果结构无效");
  }
  const candidates = raw.candidates.slice(0, deep ? 5 : 1).map((item) => {
    if (!item || typeof item !== "object") throw new Error("模型返回了异常的候选位置");
    const latitude = item.latitude == null ? null : Number(item.latitude);
    const longitude = item.longitude == null ? null : Number(item.longitude);
    const confidence = Number(item.confidence);
    if (typeof item.name !== "string" || !item.name.trim() ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 100 ||
        (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
        (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) ||
        !Array.isArray(item.evidence)) throw new Error("模型返回了异常的候选位置");
    return {
      name: item.name.trim().slice(0, 160),
      country: typeof item.country === "string" ? item.country.trim().slice(0, 100) : "",
      region: typeof item.region === "string" ? item.region.trim().slice(0, 120) : "",
      latitude, longitude, confidence: Math.round(confidence),
      evidence: item.evidence.filter((v) => typeof v === "string" && v.trim()).slice(0, 8).map((v) => v.trim().slice(0, 300)),
    };
  }).sort((a, b) => b.confidence - a.confidence);
  if (!candidates.length) throw new Error("模型未返回候选位置");
  // A model may claim certainty too eagerly; only strong results are presented as confirmed.
  const status = raw.status === "confirmed" && candidates[0].confidence >= 75 ? "confirmed" : "uncertain";
  return { status, summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 500) : "", candidates };
}

function promptFor(deep) {
  const count = deep ? "返回最多 5 个彼此不同、按置信度降序排列的候选；证据只支持更少候选时绝对不要凑数。" : "只返回最可能的 1 个候选。";
  return `你是严谨的全球照片地理定位分析师。仔细检查图中所有可见文字和语言、道路标识、建筑风格、行车方向、车辆与车牌特征、地形、植被、气候、公共设施、店铺标识、路灯、电线杆，以及任何其他可定位线索。用户没有提供国家或城市提示。${count}
不要虚构看不清的内容。证据充分且 confidence 至少 75 才可将 status 设为 confirmed，否则必须为 uncertain。坐标不能合理确定时必须为 null。
只输出一个 JSON 对象，不要 Markdown，不要解释，严格使用：{"status":"confirmed|uncertain","summary":"中文总结","candidates":[{"name":"地点名称","country":"国家","region":"地区或城市","latitude":数字或null,"longitude":数字或null,"confidence":0到100的数字,"evidence":["中文依据"]}]}`;
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
  const output = await runWithTimeout(env.AI.run(MODEL, {
    prompt: promptFor(deep),
    image,
    max_tokens: deep ? 1800 : 900,
    temperature: 0.15,
  }), 55000);
  return json(normalizeResult(cleanModelJson(output?.response), deep));
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
      if (error instanceof SyntaxError || message.includes("模型")) return json({ error: "AI 返回的结果无法解析，请重试或更换图片。" }, 502);
      return json({ error: "分析暂时不可用，请稍后重试。" }, 500);
    }
  },
};
