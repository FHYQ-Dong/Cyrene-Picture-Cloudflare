# Cyrene Picture Cloudflare (v1)

基于 Cloudflare Pages + Functions + R2 + D1 的匿名公开图片站 MVP。

## 本次变更你需要做的操作（仅命令/步骤）

1. 拉取最新代码后执行数据库迁移（本地）：

```bash
npm run db:migrate:local
npm run db:migrate:v2:local
npm run db:migrate:v3:local
npm run db:migrate:v5:local
```

如果第二条出现 `duplicate column name: uploader_nickname`，表示 v2 迁移已经执行过，可直接继续下一步。
如果第三条出现 `duplicate column name: thumb_object_key` / `thumb_public_url` / `thumb_status`，表示 v3 迁移已经执行过，可直接继续下一步。
如果第四条出现 `table image_objects already exists`，表示 v5 迁移已经执行过，可直接继续下一步。

2. 复制并检查本地变量：

```bash
cp .dev.vars.example .dev.vars
```

PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars -Force
```

3. 本地推荐开启同源直传模式（避免 CORS）：

```env
LOCAL_UPLOAD_DIRECT="true"
```

4. 启动本地服务：

```bash
npm run dev
```

5. 本地访问路径：

-   展示页：`http://127.0.0.1:8788/`
-   上传页：`http://127.0.0.1:8788/upload.html`

6. 线上升级（已有旧库时）补一次 v2 字段迁移：

```bash
wrangler d1 execute cyrene_meta --remote --file=infra/d1/schema.sql
wrangler d1 execute cyrene_meta --remote --file=infra/d1/migrate-v2-uploader-nickname.sql
wrangler d1 execute cyrene_meta --remote --file=infra/d1/migrate-v3-thumbnails.sql
wrangler d1 execute cyrene_meta --remote --file=infra/d1/migrate-v5-hash-dedup.sql
```

7. 若启用 Turnstile 正式 key，请配置环境变量：

-   本地 `.dev.vars`：`TURNSTILE_SITE_KEY`
-   Pages（Production/Preview）变量：`TURNSTILE_SITE_KEY`

## 功能

-   匿名上传（Turnstile + 配额 + 限流）
-   R2 直传（Presigned URL）
-   本地直传模式（同源 `/api/upload-direct`，避免 CORS）
-   展示页/上传页分离（`/` 与 `/upload.html`）
-   图片瀑布流 + 按日期/上传者分隔
-   上传者昵称（可选，默认 `093`）
-   图片列表与详情
-   结构化日志与基础错误码

## 最新改动（Turnstile 挂件化）

-   前端已从“手填 token”改为“真实 Turnstile 挂件”。
-   变更文件：`public/upload.html`、`public/upload.js`、`functions/api/client-config.js`。
-   上传前会强制检查 Turnstile token；上传成功后会自动重置挂件，避免复用旧 token。
-   上传页通过 `/api/client-config` 从环境变量注入 Site Key，不再在 HTML 中硬编码。
-   开发/生产环境通过各自变量自动切换，避免误用测试 key。

## 最新改动（v2 UI）

-   首页改为展示页（Blog 风格标题栏，标题默认“昔涟”）。
-   上传页面独立为 `public/upload.html`，展示页右上角可进入上传页。
-   列表支持 `groupBy=date|uploader|none`，并支持按上传者筛选。
-   数据新增上传者昵称字段 `uploader_nickname`。

## 最新改动（v3 缩略图与详情导航）

-   展示页优先使用 `thumb_url` 渲染，失败时自动回退 `public_url`。
-   `upload-complete` 改为异步缩略图流程：先写 `thumb_status=pending`，后台任务完成后回写 `ready/failed`。
-   详情接口 `/api/image/:id` 扩展返回 `prev/next`，详情页可直接“上一张/下一张”。

## 最新改动（v5 哈希预检秒传）

-   新增 `POST /api/upload-hash/check`，上传前按 `SHA-256` 预检是否已存在对象。
-   单图上传接入“预检 -> 命中秒传 / 未命中再上传”流程。
-   新增 `image_objects`、`image_upload_events` 数据结构用于对象复用与上传事件留痕。

## 最新改动（v4 批量上传接口）

-   新增 `POST /api/upload-batch/prepare`（批量申请上传凭证）。
-   新增 `POST /api/upload-batch/complete`（批量写入元数据与结果聚合）。
-   上传页支持多文件选择与批量流程（预检命中项直接秒传，未命中项上传后统一 complete）。

## 真实缩略图生成（线上接入）

当前版本已支持通过 Cloudflare Image Resizing 生成真实缩略图（不是复制原图）。

### 1) 前置条件

-   你的源图访问地址（`PUBLIC_IMAGE_BASE_URL`）可被公网访问。
-   你有一个开启了 Cloudflare 代理（橙云）的域名，用于承载 `/cdn-cgi/image/...`。
-   该域名可访问并启用 Cloudflare Image Resizing 能力。

### 2) 生产变量

在 Pages 项目变量（Production）中新增/确认：

```env
THUMBNAIL_ENABLED="true"
THUMBNAIL_GENERATOR="enabled"
THUMBNAIL_WIDTH="360"
THUMBNAIL_FORMAT="webp"
THUMBNAIL_QUALITY="80"

# 这里填“开启了 Cloudflare 代理的站点根地址”
THUMBNAIL_RESIZE_BASE_URL="https://your-zone.example.com"

# 这里填“原图对外访问根地址”，用于拼接 source URL
PUBLIC_IMAGE_BASE_URL="https://img.your-zone.example.com"
```

说明：

-   当 `THUMBNAIL_GENERATOR="enabled"` 时，后台任务会请求：
    `THUMBNAIL_RESIZE_BASE_URL/cdn-cgi/image/.../PUBLIC_IMAGE_BASE_URL/<objectKey>`
-   成功后会将缩放结果写入 R2 的 `thumb/...` 路径，并把 `thumb_status` 置为 `ready`。
-   若失败会置为 `failed`，前端自动回退展示 `public_url`。

### 3) 生产部署顺序

```bash
npm run deploy
npm run db:migrate:v3:remote
```

如是全新库，先执行：

```bash
wrangler d1 execute cyrene_meta --remote --file=infra/d1/schema.sql
wrangler d1 execute cyrene_meta --remote --file=infra/d1/migrate-v2-uploader-nickname.sql
wrangler d1 execute cyrene_meta --remote --file=infra/d1/migrate-v3-thumbnails.sql
```

## 本地如何验证真实缩略图

本地 `wrangler pages dev` 不会模拟 Cloudflare 边缘的 `/cdn-cgi/image`，所以推荐“本地触发 + 线上缩放服务”联合验证。

### 1) 本地变量（`.dev.vars`）

```env
LOCAL_UPLOAD_DIRECT="true"
THUMBNAIL_ENABLED="true"
THUMBNAIL_GENERATOR="enabled"
THUMBNAIL_WIDTH="360"
THUMBNAIL_FORMAT="webp"
THUMBNAIL_QUALITY="80"

# 指向已开橙云并支持 /cdn-cgi/image 的线上域名
THUMBNAIL_RESIZE_BASE_URL="https://your-zone.example.com"

# 指向线上可访问原图域名（不是 localhost）
PUBLIC_IMAGE_BASE_URL="https://img.your-zone.example.com"
```

### 2) 启动与上传

```bash
npm run db:migrate:local
npm run db:migrate:v2:local
npm run db:migrate:v3:local
npm run db:migrate:v5:local
npm run dev
```

访问 `http://127.0.0.1:8788/upload.html` 上传一张大图（如 2MB+ JPEG）。

### 3) 验收检查点

1. 在本地 D1 看状态是否变为 `ready`：

```bash
wrangler d1 execute cyrene_meta --local --command "SELECT image_id,thumb_status,object_key,thumb_object_key,size FROM images ORDER BY created_at DESC LIMIT 5"
```

2. 对比原图与缩略图大小（`thumb` 应明显更小）：

```bash
curl -I "http://127.0.0.1:8788/api/object?key=<object_key>"
curl -I "http://127.0.0.1:8788/api/object?key=<thumb_object_key>"
```

3. 打开展示页，确认卡片优先加载 `thumb_url`，点击详情后显示 `public_url` 原图。

若 `thumb_status=failed`：

-   优先检查 `THUMBNAIL_RESIZE_BASE_URL` 是否可访问 `/cdn-cgi/image/...`。
-   检查 `PUBLIC_IMAGE_BASE_URL/<object_key>` 是否能被公网访问。
-   检查该域名是否在 Cloudflare 代理下并已启用 Image Resizing。

## 批量重试 `failed` 缩略图（自动触发）

新增管理接口：`POST /api/admin/thumbnail-repair`

### 1) 先配置管理令牌（Pages Secret）

```bash
wrangler pages secret put ADMIN_API_TOKEN --project-name cyrene-picture-cloudflare
```

请求时通过 Header 传入：`x-admin-token: <ADMIN_API_TOKEN>`。

也支持：`Authorization: Bearer <ADMIN_API_TOKEN>`。

### 2) 先 dry-run 看将处理哪些记录

```bash
curl -X POST "https://cyrene.fhyq.cloud/api/admin/thumbnail-repair?limit=50&dryRun=true" \
    -H "x-admin-token: <ADMIN_API_TOKEN>"
```

### 3) 真正执行批量重试

```bash
curl -X POST "https://cyrene.fhyq.cloud/api/admin/thumbnail-repair?limit=50" \
    -H "x-admin-token: <ADMIN_API_TOKEN>"
```

返回会包含 `picked/processed/succeeded/failed` 与每条记录结果。

> 兼容说明：旧路径 `/api/admin/retry-thumbnails` 仍可用，但建议迁移到 `/api/admin/thumbnail-repair`。

### 4) 重试后查看状态分布

```bash
wrangler d1 execute cyrene_meta --remote --command "SELECT thumb_status, COUNT(*) AS cnt FROM images GROUP BY thumb_status ORDER BY cnt DESC;"
```

## 目录

-   `public/`: 前端页面
-   `functions/`: Pages Functions
-   `infra/d1/schema.sql`: D1 表结构
-   `tests/`: 最小测试
-   `plan/v1-r2-pages/`: 需求与实施文档

## 环境准备（线上）

1. 创建 Cloudflare 资源
    - Pages 项目：`cyrene-picture-cloudflare`
    - D1 数据库：`cyrene_meta`
    - R2 Bucket：`cyrene-images`（可另配 preview bucket）
    - Turnstile 小组件：获取 `Site Key` 和 `Secret Key`
2. 本地安装依赖

```bash
npm install
```

3. 在 `wrangler.toml` 中确认绑定
    - `[[d1_databases]]` 的 `database_id`
    - `[[r2_buckets]]` 的 `bucket_name/preview_bucket_name`
    - `[vars]` 中限流、配额、公开域名等变量
4. 配置 Pages Secrets / Variables（生产环境）
    - `TURNSTILE_SECRET_KEY`
    - `R2_ACCESS_KEY_ID`
    - `R2_SECRET_ACCESS_KEY`
    - `CLOUDFLARE_ACCOUNT_ID`
    - `UPLOAD_TOKEN_SECRET`
    - `ADMIN_API_TOKEN`
    - `TURNSTILE_SITE_KEY`（**Pages Variable**，不是 Secret）

```bash
wrangler pages secret put TURNSTILE_SECRET_KEY --project-name cyrene-picture-cloudflare
wrangler pages secret put R2_ACCESS_KEY_ID --project-name cyrene-picture-cloudflare
wrangler pages secret put R2_SECRET_ACCESS_KEY --project-name cyrene-picture-cloudflare
wrangler pages secret put CLOUDFLARE_ACCOUNT_ID --project-name cyrene-picture-cloudflare
wrangler pages secret put UPLOAD_TOKEN_SECRET --project-name cyrene-picture-cloudflare
wrangler pages secret put ADMIN_API_TOKEN --project-name cyrene-picture-cloudflare
# TURNSTILE_SITE_KEY 请在 Pages 项目 Variables 中配置
```

5. 运行 v7 迁移（新增 upload token 与 admin 审计表）

```bash
npm run db:migrate:v7:local
npm run db:migrate:v7:remote
```

6. 配置前端 Turnstile Site Key（生产环境变量）
    - 在 Pages 项目 Variables 中新增：`TURNSTILE_SITE_KEY="<your-site-key>"`
    - 不需要再修改 `public/*.html`

## 本地运行

```bash
npm install
npm run db:migrate:local
npm run db:migrate:v2:local
npm run db:migrate:v3:local
npm run db:migrate:v5:local
npm run dev
```

`db:migrate:v2:local` 仅需执行一次；重复执行可能出现 `duplicate column name: uploader_nickname`，属于可忽略提示。

本地默认访问：`http://127.0.0.1:8788`

### 本地 Turnstile 配置（必须）

如果上传时报：`TURNSTILE_INVALID` + `details: "missing-secret"`，说明本地没有注入 `TURNSTILE_SECRET_KEY`。
如果上传页提示“未配置 Turnstile site key”，说明本地没有注入 `TURNSTILE_SITE_KEY`。

1. 从模板复制本地变量文件：

```bash
cp .dev.vars.example .dev.vars
```

PowerShell 可用：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

2. 确认 `.dev.vars` 中至少包含：

```env
TURNSTILE_SITE_KEY="1x00000000000000000000AA"
TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"
```

3. 选择一种本地上传模式：

**A) 推荐：本地直传模式（不需要 R2 签名三项）**

```env
LOCAL_UPLOAD_DIRECT="true"
```

该模式下，浏览器上传会走同源 `/api/upload-direct`，不会出现 R2 CORS 问题。
图片预览会走同源 `/api/object?key=...`，因此本地列表/详情可直接显示。

**B) 远程预签名模式（会直传真实 R2）**

```env
CLOUDFLARE_ACCOUNT_ID="your-account-id"
R2_ACCESS_KEY_ID="your-r2-access-key-id"
R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"
```

4. 重启本地服务（必须重启才能生效）：

```bash
npm run dev
```

## 测试

```bash
npm test
```

## 线上部署（Pages）

1. 首次部署静态站点 + Functions

```bash
npm run deploy
```

2. 生产 D1 执行迁移

```bash
wrangler d1 execute cyrene_meta --remote --file=infra/d1/schema.sql
wrangler d1 execute cyrene_meta --remote --file=infra/d1/migrate-v2-uploader-nickname.sql
```

说明：`migrate-v2-uploader-nickname.sql` 是针对已存在 v1 数据库的一次性升级脚本。

3. 部署后检查
    - 打开 Pages 域名，确认首页可访问
    - `GET /api/health` 返回 `ok: true`
    - 完成人机验证后，执行一次上传并确认列表展示

## R2 CORS 配置（浏览器直传必需）

如果页面显示“正在上传到 R2 -> TypeError: Failed to fetch”或“R2 上传请求被浏览器拦截”，通常是 R2 CORS 未配置。

请在 R2 Bucket 的 CORS 中添加规则（示例）：

```json
[
	{
		"AllowedOrigins": [
			"http://127.0.0.1:8788",
			"https://your-project.pages.dev",
			"https://your-custom-domain.com"
		],
		"AllowedMethods": ["PUT", "GET", "HEAD"],
		"AllowedHeaders": ["*"],
		"ExposeHeaders": ["ETag"],
		"MaxAgeSeconds": 3600
	}
]
```

注意：`AllowedOrigins` 需要与你实际访问前端的域名完全匹配（协议 + 域名 + 端口）。

说明：当 `LOCAL_UPLOAD_DIRECT="true"` 时，本地上传走同源 Functions，不需要这段 CORS。

## 常见问题

-   `turnstile verification failed`：检查 `TURNSTILE_SECRET_KEY` 是否正确、是否与前端 Site Key 成对。
-   `missing-secret`：本地请创建 `.dev.vars` 并设置 `TURNSTILE_SECRET_KEY`，然后重启 `npm run dev`。
-   `CONFIG_MISSING` + `missing R2 signing env vars`：补齐 `.dev.vars` 中 `CLOUDFLARE_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。
-   浏览器 `TypeError: Failed to fetch`（上传到 R2 时）：优先检查 R2 Bucket CORS（见上节）。
-   本地不想配置 R2 签名三项：设置 `LOCAL_UPLOAD_DIRECT="true"`，并重启 `npm run dev`。
-   `no such table: ...`：D1 未迁移，先执行：`npm run db:migrate:local`（本地）或 `wrangler d1 execute ... --remote`（线上）。
-   `no such column: uploader_nickname`：执行 `npm run db:migrate:v2:local`（本地）或 `npm run db:migrate:v2:remote`（线上）。
-   `no such column: thumb_status`：执行 `npm run db:migrate:v3:local`（本地）或 `npm run db:migrate:v3:remote`（线上）。
-   `no such table: image_objects` / `image_upload_events`：执行 `npm run db:migrate:v5:local`（本地）或 `npm run db:migrate:v5:remote`（线上）。

## 说明

-   本项目按 `plan/v1-r2-pages/code-plan-v1-core.md` 实现，并已落地 `code-plan-v2-ui.md` 的主要交互目标。
-   默认策略为“无登录鉴权 + 全公开图片”。
