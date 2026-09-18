# 寻图

“寻图”是一个部署于单个 Cloudflare Worker 的照片地理位置推测网页。用户上传照片后，Workers AI 会根据文字、道路、建筑、车辆和自然环境等视觉线索，返回一个谨慎的初步推测；用户也可以要求进行深度分析并查看至多五个有证据支持的候选位置。

> 结果是 AI 推测，准确度取决于照片中的可辨识线索，不适合紧急救援、法律判断等高风险用途。应用不会把上传图片写入数据库、KV、R2 或日志存储。

## 项目结构

```text
├── public/
│   ├── index.html       # 单页界面与无障碍结构
│   ├── styles.css       # 响应式布局（优先适配 iPad）
│   └── app.js           # 压缩、上传、结果卡片和地图链接
├── src/index.js         # API、Workers AI 调用、校验与错误处理
├── wrangler.jsonc       # Worker、Static Assets 与 AI 绑定
└── package.json
```

非 `/api/*` 请求由 Cloudflare Static Assets 从 `public` 提供；`/api/*` 会优先经过 Worker。服务端通过 `env.AI` 调用 `@cf/meta/llama-3.2-11b-vision-instruct`，图像按照 Workers AI 的二进制字节数组输入格式传递，不需要也不会在浏览器中暴露 API Key。

## 本地开发与检查

需要 Node.js 18.17 或更新版本，并登录拥有 Workers AI 权限的 Cloudflare 账户。

```bash
npm install
npx wrangler dev
```

基础检查：

```bash
npm run check
```

## 首次模型许可

Meta 要求在首次使用 Llama 3.2 模型前接受 **Llama 3.2 License** 和 **Acceptable Use Policy**。应用不会暗中代替用户接受：浏览器首次分析时会展示许可链接与说明。只有用户主动点击“我已阅读并同意”后，前端才调用 `POST /api/license`，由 Worker 向模型发送 `prompt: "agree"`。成功后，本浏览器会在 `localStorage` 记录已完成提示，再允许上传图片进行分析。

该同意状态实际由 Cloudflare 针对账户处理；浏览器记录仅用于避免重复展示界面。清除浏览器站点数据后会再次提示。

## 部署

1. 在 Cloudflare 控制台创建或选择账户，确保 Workers AI 可用。
2. 在本机执行 `npx wrangler login`（CI 中使用 Cloudflare 官方的 API Token 环境变量）。
3. 安装依赖并部署：

```bash
npm install
npx wrangler deploy
```

无需填写 Google Maps API Key，也无需绑定 KV、D1 或 R2。`wrangler.jsonc` 已包含名为 `AI` 的 Workers AI 绑定和 `public` 静态资源配置。Google 地图和实景按钮使用官方 Maps URL；卡片内地图使用无需密钥的 OpenStreetMap 嵌入页面。

## 限制与隐私

- 接受 JPG/JPEG、PNG、WEBP，原图最大 12 MB；浏览器会将超过 2.5 MB 的图片最长边缩至 2048 像素并转为 JPEG，以控制 iPad 内存与上传量。
- 图片只存在于当前浏览器预览、本次请求内存和 Workers AI 推理流程中，本项目不做持久化。Cloudflare 平台本身的数据处理仍受 Cloudflare 服务条款约束。
- Workers AI 有账户级免费每日额度；额度和计费规则可能调整，超出免费额度会失败或按 Cloudflare 账户设置计费。部署前请在 Cloudflare 官方 Workers AI 定价页确认当前额度，不要假设无限免费。
- AI 可能误读文字或地标。低置信度结果会明确标为“不完全确认”，经纬度缺少合理依据时为空。
- Google 实景并非全球覆盖；无坐标时按钮会退化为地点搜索。OpenStreetMap 嵌入和 Google 外链需要浏览器能访问相应第三方服务。
- Worker 设置了应用层超时提示，但已提交到托管 AI 的推理不一定能被中途取消。
