# v13 代码实现计划（不写代码）：图片/音频页面与上传链路分离（承接 Idea-013）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-29
-   来源想法：`plan/0-idea-seed-backlog.md`（Idea-013）
-   目标：在保持现有图片链路稳定的前提下，将“图片”和“音频”在展示页与上传页彻底分离，并满足音频单文件上传与标题录入要求。

---

## 1. 问题与目标

## 1.1 当前问题

1. 当前站点仅支持图片（上传、列表、详情）；
2. 无法承载 BGM、语音片段、音频投稿等需求；
3. 展示和上传交互未区分媒体类型，无法满足“图片页只看图、音频页只看音频”的产品边界。

## 1.2 v13 目标

1. 将展示页拆分为两个页面：
    - 图片展示页：只显示图片；
    - 音频展示页：只显示音频。
2. 音频展示页不显示封面，统一显示音频 `title` + 播放器（避免无封面资源造成 UI 不一致）。
3. 将上传页拆分为两个页面：
    - 图片上传页：保留现有批量上传能力；
    - 音频上传页：仅支持单文件上传（禁止批量），并增加必填 `audio title` 输入框。
4. 支持常见音频格式：MVP `audio/mpeg`、`audio/wav`、`audio/ogg`、`audio/mp4`；扩展 `audio/webm`、`audio/flac`、`audio/aac`、`audio/x-m4a`、`audio/opus`。
5. 元数据支持 `media_type=audio`、`duration_seconds`、`audio_title`，并与现有限流、配额、审计、管理员删除保持兼容。

---

## 2. 总体方案

采用“**统一数据模型 + 前端页面分离 + 上传入口分离**”策略：

1. 数据层在 `images` 上增量字段：`media_type`、`duration_seconds`；
2. 新增 `audio_title` 字段，音频记录要求标题可展示；
3. 上传链路沿用现有后端接口能力，但前端入口分离：图片与音频走不同页面与不同表单约束；
4. 展示链路分离：图片页只查询 `media_type=image`，音频页只查询 `media_type=audio`。

---

## 3. 数据模型改造

## 3.1 D1 Schema 迁移（新增 v13 migration）

建议新增：`infra/d1/migrate-v13-audio-media-support.sql`

对 `images` 表增量字段：

-   `media_type TEXT NOT NULL DEFAULT 'image'`（值域：`image|audio`）
-   `duration_seconds REAL NULL`
-   `audio_title TEXT NULL`

索引建议：

-   `CREATE INDEX IF NOT EXISTS idx_images_media_type_created_at ON images(media_type, created_at DESC);`

兼容性：

-   历史图片数据自动视为 `media_type='image'`；
-   `duration_seconds` 对图片为 `NULL`。
-   `audio_title` 对图片为 `NULL`。

---

## 4. 后端改造清单

## 4.1 配置与白名单

文件：`functions/_shared/env.js`

-   扩展 `allowedMime`，按两层支持音频 MIME：

### 4.1.1 第一层（v13 MVP 必开）

-   `audio/mpeg`（mp3）
-   `audio/wav`（wav）
-   `audio/ogg`（ogg/opus）
-   `audio/mp4`（m4a/mp4 audio）

### 4.1.2 第二层（v13.1 建议扩展）

-   `audio/webm`（webm/opus）
-   `audio/flac`（flac）
-   `audio/aac`（aac）
-   `audio/x-m4a`（部分端上会报该 MIME）
-   `audio/opus`（部分浏览器直接上报）

> 兼容建议：后端白名单优先按 MIME 校验，同时允许前端按文件扩展名做辅助识别并提示“可能可播/不可播”。

## 4.2 上传完成接口

文件：`functions/api/upload-complete.js`

-   新增字段接收：
    -   `mediaType`（可选，默认按 MIME 推导）
    -   `durationSeconds`（音频可选）
    -   `audioTitle`（音频必填）
-   规则：
    -   图片：按现有 `width/height` 逻辑；
    -   音频：`width/height=null`，写入 `duration_seconds` + `audio_title`；
    -   若音频缺少 `audioTitle`：返回 `INVALID_REQUEST`（或新增 `AUDIO_TITLE_REQUIRED`）。

## 4.3 DB 写入方法

文件：`functions/_shared/db.js`

-   `upsertImageMetadata` 增加绑定字段：`media_type`、`duration_seconds`、`audio_title`；
-   `listImages` / `getImageById` 查询结果补充返回以上字段。

## 4.4 列表与详情接口

文件：

-   `functions/api/list.js`
-   `functions/api/image/[id].js`（或当前详情接口）

改造点：

-   增加查询参数 `mediaType=image|audio`（默认 `image`，保持首页图片优先）；
-   返回 `media_type`、`duration_seconds`、`audio_title`；
-   音频列表不返回封面依赖字段（或前端忽略），以标题为主。

---

## 5. 前端改造清单

## 5.1 上传页分离

### 5.1.1 图片上传页

-   继续使用现有 `public/upload.html` + `public/upload.js`（批量能力保留）；
-   限定选择图片 MIME。

### 5.1.2 音频上传页

-   新增 `public/upload-audio.html` + `public/upload-audio.js`；
-   文件选择改为单文件（无 `multiple`）；
-   新增输入框：`audioTitle`（必填）；
-   音频上传明确禁止批量。

### 5.1.3 音频上传元数据

-   新增音频时长提取函数：
    -   `getAudioDurationFromFile(file)`（`HTMLAudioElement` + `loadedmetadata`）。
-   `complete` 请求携带：
    -   `mediaType: 'audio'`
    -   `durationSeconds`
    -   `audioTitle`

## 5.2 展示页分离

### 5.2.1 图片展示页

-   `public/index.html` + `public/main.js` 保持图片展示，列表请求固定 `mediaType=image`。

### 5.2.2 音频展示页

-   新增 `public/audio.html` + `public/audio.js`；
-   列表请求固定 `mediaType=audio`；
-   每条记录展示：`audio_title` + 上传者 + 日期 + `<audio controls>`；
-   不展示封面卡片（即使对象可提供封面也不使用）。

### 5.2.3 交互一致性

-   两个页面都保留上传者筛选、分组、分页；
-   但各自仅处理对应媒体类型。

## 5.3 详情页策略

-   图片详情继续使用 `public/image.html`；
-   可选新增 `public/audio-detail.html`（或先不做独立详情，v13 仅做音频列表可播放）；
-   若复用一个详情页，必须按 `media_type` 分支渲染且音频展示标题。

---

## 6. 管理与删除兼容

文件：`functions/_shared/admin-delete.js` 及 `api/admin/delete-*`

-   删除逻辑应继续按 `images.object_key` 删除原对象；
-   音频对象无需缩略图删除分支（除非后续引入音频封面对象）。

---

## 7. 错误码与校验

复用现有错误码优先，必要时新增：

-   `MEDIA_TYPE_NOT_ALLOWED`（可选）
-   `AUDIO_DURATION_PARSE_FAILED`（可选，建议降级为 `duration_seconds=null` 而非硬失败）
-   `AUDIO_TITLE_REQUIRED`（建议新增）
-   `AUDIO_BATCH_NOT_ALLOWED`（建议新增）

校验策略：

-   MIME 决定媒体类型，不信任前端裸传 `mediaType`；
-   `durationSeconds` 非法时置空并继续。
-   音频上传必须单文件 + 必填 `audioTitle`。

---

## 8. 测试计划

## 8.1 后端自动化测试

新增建议：

-   `tests/api-upload-complete-audio.test.js`

    -   音频 MIME 写入成功；
    -   `media_type='audio'`、`duration_seconds`、`audio_title` 正确；
    -   列表返回音频记录。

-   `tests/api-list-media-type.test.js`

    -   `mediaType=image` 仅返回图片；
    -   `mediaType=audio` 仅返回音频；
    -   字段兼容历史图片。

-   `tests/api-upload-audio-validation.test.js`
    -   缺少 `audioTitle` 拒绝；
    -   音频批量上传请求拒绝。

## 8.2 前端手工验证

1. 图片页仅显示图片，音频页仅显示音频；
2. 音频页不显示封面，显示 `audioTitle` + 播放器；
3. 音频上传页仅允许单文件，缺少标题不可提交；
4. 图片上传页仍支持批量；
5. 管理员删除音频后音频页对应条目消失。

---

## 9. 发布策略

1. **Phase A（后端先行）**
    - 上线 D1 v13 migration；
    - 上线后端字段兼容写入/读取（前端暂不依赖）。
2. **Phase B（前端切换）**
    - 上线音频上传独立页面；
    - 上线音频展示独立页面；
    - 图片上传与图片展示页面保持单媒体职责。
3. **Phase C（回归收口）**
    - 验证图片链路无回归；
    - 验证音频上传展示与删除链路完整。

---

## 10. 完成定义（DoD）

1. 支持音频文件上传并成功入库；
2. 图片与音频展示页面已分离且互不混显；
3. 音频页面不显示封面，仅显示标题与播放器；
4. 上传页分离，音频上传为单文件且标题必填；
5. 现有图片上传/展示/删除能力无回归；
6. 自动化测试 + 手工回归通过。
