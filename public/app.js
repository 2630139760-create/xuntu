const $ = (selector) => document.querySelector(selector);
const views = [...document.querySelectorAll(".view")];
let selectedFile = null;
let previewUrl = "";
let latestResult = null;
let pendingAfterLicense = null;

function showView(id) {
  views.forEach((view) => view.classList.toggle("active", view.id === id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setPreview(blob) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  $("#preview").src = previewUrl;
  $("#loadingImage").src = previewUrl;
  $("#previewWrap").classList.remove("hidden");
  $("#dropzone").classList.add("hidden");
  $("#analyzeButton").disabled = false;
}

async function compressImage(file) {
  if (file.size <= 2.5 * 1024 * 1024) return file;
  const bitmap = await createImageBitmap(file);
  const maxSide = 2048;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  canvas.width = canvas.height = 1;
  if (!blob) throw new Error("无法压缩这张图片，请换一张图片重试");
  return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
}

async function chooseFile(file) {
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!file || !allowed.includes(file.type)) return showError("请选择 JPG、JPEG、PNG 或 WEBP 图片。", "upload");
  if (file.size > 12 * 1024 * 1024) return showError("原始图片不能超过 12 MB。", "upload");
  try {
    $("#analyzeButton").disabled = true;
    selectedFile = await compressImage(file);
    setPreview(selectedFile);
  } catch (error) { showError(error.message, "upload"); }
}

function showError(message, returnView = "upload") {
  $("#errorMessage").textContent = message;
  $("#retryButton").dataset.returnView = returnView;
  showView("error");
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function analyze(mode = "initial") {
  if (!selectedFile) return;
  if (!localStorage.getItem("xuntu-llama-license")) {
    pendingAfterLicense = mode;
    $("#licenseDialog").showModal();
    return;
  }
  showView("loading");
  const stages = mode === "deep" ? ["正在扩大线索范围", "正在比较不同国家与地区", "正在整理候选位置"] : ["正在读取画面线索", "正在分析文字、建筑、道路和自然环境", "正在推测可能位置"];
  let stage = 0;
  $("#loadingTitle").textContent = stages[0];
  const ticker = setInterval(() => { stage = Math.min(stage + 1, stages.length - 1); $("#loadingTitle").textContent = stages[stage]; }, 4500);
  const form = new FormData();
  form.append("image", selectedFile);
  form.append("mode", mode === "deep" ? "deep" : "initial");
  try {
    const response = await fetch("/api/analyze", { method: "POST", body: form });
    const data = await response.json().catch(() => ({ error: "服务器返回了无法读取的结果" }));
    if (!response.ok) {
      if (response.status === 428) localStorage.removeItem("xuntu-llama-license");
      throw new Error(data.error || "分析失败，请稍后重试");
    }
    latestResult = data;
    renderResults(data, mode === "deep");
  } catch (error) { showError(error.message); }
  finally { clearInterval(ticker); }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function linksFor(place) {
  const hasCoords = Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
  const query = hasCoords ? `${place.latitude},${place.longitude}` : [place.name, place.region, place.country].filter(Boolean).join(", ");
  const encoded = encodeURIComponent(query);
  return {
    maps: `https://www.google.com/maps/search/?api=1&query=${encoded}`,
    street: hasCoords ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${place.latitude}%2C${place.longitude}` : `https://www.google.com/maps/search/?api=1&query=${encoded}`,
  };
}

function mapEmbed(place) {
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return `<div class="map-empty">暂无可靠坐标，可通过下方链接搜索地点</div>`;
  const lat = place.latitude, lon = place.longitude, d = 0.035;
  const bbox = `${lon-d},${lat-d},${lon+d},${lat+d}`;
  return `<iframe title="${escapeHtml(place.name)}地图" loading="lazy" referrerpolicy="no-referrer" src="https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat}%2C${lon}"></iframe>`;
}

function renderResults(data, deep) {
  $("#resultTitle").textContent = "已为你找到此图位置";
  $("#resultSummary").textContent = data.summary || "请结合判断依据核对结果。";
  $("#cards").innerHTML = data.candidates.map((place, index) => {
    const links = linksFor(place);
    const coords = place.latitude == null ? "坐标：暂无可靠数据" : `坐标：${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`;
    return `<article class="location-card"><div class="card-info"><img class="card-photo" src="${previewUrl}" alt="用户上传的待定位照片"><span class="rank">候选 ${String(index + 1).padStart(2,"0")}</span><h2>${escapeHtml(place.name)}</h2><p class="place-line">${escapeHtml([place.country, place.region].filter(Boolean).join(" · ") || "地区未知")}</p><div class="confidence"><strong>${place.confidence}%</strong><span class="meter" aria-label="置信度 ${place.confidence}%"><i style="width:${place.confidence}%"></i></span><span>置信度</span></div><p class="coords">${coords}</p><h3>判断依据</h3><ul class="evidence">${place.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>暂无具体依据</li>"}</ul></div><div class="map-side">${mapEmbed(place)}<div class="map-actions"><a href="${links.maps}" target="_blank" rel="noopener">在 Google 地图中打开</a><a href="${links.street}" target="_blank" rel="noopener">查看 Google 实景</a></div></div></article>`;
  }).join("");
  $("#deepButton").classList.toggle("hidden", deep);
  showView("results");
}

function resetUpload() {
  selectedFile = latestResult = null;
  $("#fileInput").value = "";
  $("#previewWrap").classList.add("hidden");
  $("#dropzone").classList.remove("hidden");
  $("#analyzeButton").disabled = true;
  showView("upload");
}

$("#startButton").addEventListener("click", () => showView("upload"));
document.querySelectorAll(".goHome").forEach((button) => button.addEventListener("click", () => showView("home")));
$("#homeLogo").addEventListener("click", () => showView("home"));
$("#fileInput").addEventListener("change", (event) => chooseFile(event.target.files[0]));
$("#changeButton").addEventListener("click", () => $("#fileInput").click());
$("#analyzeButton").addEventListener("click", () => analyze());
$("#deepButton").addEventListener("click", () => analyze("deep"));
$("#restartButton").addEventListener("click", resetUpload);
$("#retryButton").addEventListener("click", (event) => showView(event.target.dataset.returnView || "upload"));
$("#cancelLicense").addEventListener("click", () => { pendingAfterLicense = null; $("#licenseDialog").close(); });
$("#agreeButton").addEventListener("click", async () => {
  const button = $("#agreeButton");
  button.disabled = true; button.textContent = "正在确认…"; $("#licenseError").textContent = "";
  try {
    const response = await fetch("/api/license", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "许可确认失败，请稍后重试");
    localStorage.setItem("xuntu-llama-license", "accepted");
    $("#licenseDialog").close();
    if (pendingAfterLicense) { const mode = pendingAfterLicense; pendingAfterLicense = null; await wait(100); analyze(mode); }
  } catch (error) { $("#licenseError").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "我已阅读并同意"; }
});
const dropzone = $("#dropzone");
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", (event) => chooseFile(event.dataTransfer.files[0]));
