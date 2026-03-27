# Cloudflare Free Tier 可行性调研：二次元图片上传/保存/展示/分享站

-   调研日期：2026-03-26
-   目标：尽量仅使用 Cloudflare 免费层（R2 + Pages + Workers Free）实现可上线 MVP。

## 1. 结论（TL;DR）

**可行，但需按“直传 R2 + 静态优先 + 少函数调用”设计。**

在免费层下，做一个中小规模的二次元图片站（上传、展示、分享）是可行的。关键是：

1. 上传走 **R2 Presigned URL 直传**（浏览器直接 PUT 到 R2），避免大文件经过 Functions/Workers。
2. 图片展示走 **R2 自定义域名 + CDN 缓存**，尽量减少回源到 R2 的 Class B 读操作。
3. Pages Functions 仅做“轻 API”（签名 URL、元数据写入、分享页路由），控制在 Workers Free 请求和 CPU 限制内。

> 约束更新：当前版本按“无登录鉴权、所有用户可上传、全部图片公开”设计，并通过 Cloudflare Challenge/Turnstile 做人机与流量防护。

---

## 2. 官方免费额度与关键限制（与你需求直接相关）

### 2.1 R2（对象存储）

-   免费额度（月）：
    -   Storage：`10 GB-month`
    -   Class A：`1,000,000 requests`
    -   Class B：`10,000,000 requests`
    -   Egress：`Free`
-   计费关键点：
    -   Standard 存储有免费额度；Infrequent Access 不享受同样免费结构且有 retrieval/min-duration 约束。
    -   R2 对外流量（egress）免费，但**操作次数**（A/B）是主要成本点。

**对图片站的含义**：

-   存储 10GB 约等于：
    -   若均图 2MB，可存约 `~5,000` 张。
    -   若均图 500KB（压缩/WebP/AVIF），可存约 `~20,000` 张。
-   读热点高时，通常先撞到 Class B（读请求）上限，而不是 egress。

### 2.2 Pages（前端托管）

-   Free 计划限制（关键项）：
    -   每月构建次数：`500`
    -   每站点文件数：`20,000`
    -   单静态文件大小：`25 MiB`
-   静态资源请求（不触发 Functions）为免费无限。

**对图片站的含义**：

-   前端 UI 完全适合放 Pages。
-   大图不要打进 Pages 构建产物，应该放 R2。

### 2.3 Pages Functions / Workers Free（你的 API 能力）

-   Pages Functions 计费与 Workers 一致。
-   Workers Free 核心限制：
    -   请求：`100,000/day`
    -   CPU：`10 ms / invocation`
    -   内存：`128 MB`
    -   子请求：`50 / invocation`
-   请求体限制（与账号计划相关）：Free 通常 `100 MB`，超出会 `413`。

**对图片站的含义**：

-   Functions 适合轻逻辑 API，不适合承接大文件中转上传。
-   若上传直传 R2，则 Functions 的请求压力大幅下降。

---

## 3. 推荐 MVP 架构（免费层友好）

### 3.1 架构总览

1. `Pages`：承载前端页面（首页、图片瀑布流、详情页、上传页）。
2. `Pages Functions`：
    - `POST /api/upload-url`：匿名风控校验（配额/大小/MIME/Challenge）+ 生成 presigned PUT URL。
    - `POST /api/upload-complete`：写入元数据（可 D1/KV，MVP 可先 JSON 索引或对象命名约定）。
    - `GET /api/list`：返回图片列表（分页）。
3. `R2`：保存原图/缩略图。
4. `R2 Custom Domain`：公开读访问（生产），利用 Cloudflare Cache。

### 3.2 上传链路（最佳实践）

-   前端先请求 `/api/upload-url`。
-   Function 生成短时 presigned URL（例如 5~15 分钟），限制 `Content-Type`。
-   前端直接 PUT 到 R2 S3 endpoint。
-   上传成功后调用 `/api/upload-complete` 记录元数据。

这样可绕过 Worker 请求体和 CPU 压力，避免“后端中转大文件”带来的免费层瓶颈。

### 3.3 展示与分享链路

-   图片 URL 使用 R2 自定义域名（如 `img.example.com/<key>`）。
-   分享页为公开分享页，不做私密鉴权；防滥用依赖缓存、限速和 Challenge。
-   注意：R2 public bucket 不能直接列目录根内容，因此列表/检索需有元数据层（D1/KV/索引文件）。

---

## 4. 免费层容量评估（粗算）

> 以下为估算，用于判断是否“够用”；真实值取决于缓存命中率、平均图大小、访问模式。

### 场景 A：小社区 MVP（可行）

-   2,000 张图，均图 1.5MB => 约 3GB 存储（在 10GB 内）
-   每日新增 100 张（上传操作远低于 Class A 上限）
-   每日图片请求 20 万次，若 CDN 命中较高（例如 80%），回源到 R2 约 4 万次/日，月约 120 万次（低于 1000 万 Class B）

结论：**免费层可稳定跑**。

### 场景 B：中等热度分享站（可能触顶）

-   每日图片请求 100 万次，缓存命中 70%，回源 30 万/日，月约 900 万（接近 Class B 上限）
-   若命中率下降或图片版本较分散，可能快速超限

结论：**可跑但需强缓存策略 + 监控**。

### 场景 C：爆发流量（免费层不稳）

-   高并发 + 低缓存命中 + 大量动态接口

结论：会先触发 `Class B` 或 `Workers Free 请求/CPU` 限制，需升级付费或做更激进缓存与限流。

---

## 5. 风险与约束（必须提前设计）

> 风险专题深化（忽略 5.1，展开 5.2~5.5）：[5-risk-control-cache-observability-anti-hotlink.md](./5-risk-control-cache-observability-anti-hotlink.md)
> 本期策略约束：不做登录鉴权、全部图片公开、优先使用 Cloudflare Managed Challenge/Under Attack Mode + Turnstile。

1. **内容合规风险**：二次元图片可能涉及版权与违规内容，需设置投诉/下架流程与基础审核机制。
2. **滥用上传风险**：需要上传配额、类型白名单、大小限制、速率限制（WAF/Rate Limit/Turnstile）。
3. **缓存一致性**：更新图片后需考虑缓存失效（purge/versioned key）。
4. **可观测性不足**：免费层下日志与监控能力有限，至少要埋点请求量、失败率、R2 操作趋势。
5. **分享防盗链需求**：公开图床天然可被外链，需通过缓存、限速与 Challenge 做防滥用保护。

---

## 6. 实施建议（按优先级）

### P0（1~3 天）

-   落地最小功能：上传、列表、详情、分享。
-   上传必须采用 presigned URL 直传。
-   所有展示图片走 R2 自定义域名。

### P1（3~7 天）

-   增加元数据索引（推荐 D1）。
-   增加分页、标签、基础搜索。
-   接入 Turnstile 与基础限流。

### P2（持续优化）

-   自动生成缩略图（上传后异步任务）。
-   热图预热缓存与分层缓存策略。
-   建立用量告警（Class B、Workers 请求、存储占用）。

---

## 7. 是否值得做

如果你的目标是：

-   先快速上线一个“可用且成本近乎 0”的二次元图站；
-   初期用户量不算爆发式；
-   能接受“免费层有边界，后续可能升级”；

那么这个方案**非常值得做**，且 Cloudflare 生态（Pages + Functions + R2）在工程复杂度和全球访问体验上都很有优势。

---

## 8. 参考来源（官方）

-   R2 Pricing: https://developers.cloudflare.com/r2/platform/pricing/
-   Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
-   Workers Limits: https://developers.cloudflare.com/workers/platform/limits/
-   Pages Limits: https://developers.cloudflare.com/pages/platform/limits/
-   Pages Functions Pricing: https://developers.cloudflare.com/pages/functions/pricing/
-   R2 Presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
-   R2 Public Buckets: https://developers.cloudflare.com/r2/buckets/public-buckets/
-   R2 CORS: https://developers.cloudflare.com/r2/buckets/cors/
-   Reference Architecture (UGC): https://developers.cloudflare.com/reference-architecture/diagrams/storage/storing-user-generated-content/
