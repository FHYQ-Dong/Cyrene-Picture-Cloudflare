# v5 代码实现计划（不写代码）：图片哈希秒传与元数据关联（Idea-008）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-27
-   来源想法：`plan/0-idea-seed-backlog.md`（Idea-008）
-   前置文档：`code-plan-v1-core.md`、`code-plan-v4-batch-upload.md`
-   目标：在保持匿名上传与风控策略不变的前提下，引入“内容哈希去重 + 秒传复用 + 上传事件独立留痕”。

---

## 1. 目标与范围

### 1.1 本次目标

1. 为图片建立稳定内容哈希（MVP 使用 `SHA-256`）。
2. 上传前先进行哈希预检，命中已存在哈希时不落盘 R2（秒传），直接复用已有对象。
3. 每次上传都生成独立“上传事件”元数据，保留上传者、上传时间、来源批次。
4. 保证并发上传同图时不会产生重复对象记录（幂等与唯一约束）。
5. 前端能明确展示“正常上传 / 秒传命中”两类结果。

### 1.2 非目标

-   不做近似去重（`pHash`、视觉相似度）。
-   不做跨格式归一化去重（如 PNG 与 JPEG 视为同图）。
-   不做客户端分片哈希与断点续传融合。
-   不在 v5 引入内容审核规则变更。

---

## 2. 核心设计原则

1. **对象唯一，事件多次**
    - 同一内容对象只存一份；每次上传都写一条事件。
2. **去重不丢语义**
    - 秒传仅复用对象，不覆盖历史上传者与上传时间。
3. **可回溯**
    - 任意展示记录可追溯到对象与上传事件链路。
4. **并发安全**
    - 通过 DB 唯一键 + 冲突处理保证幂等。

---

## 3. 数据模型规划

## 3.1 新增表：`image_objects`（内容对象层）

建议字段：

-   `object_id TEXT PRIMARY KEY`（UUID）
-   `content_hash TEXT NOT NULL`（`sha256:<hex>`）
-   `object_key TEXT NOT NULL`
-   `mime TEXT NOT NULL`
-   `size INTEGER NOT NULL`
-   `r2_etag TEXT`
-   `created_at TEXT NOT NULL`
-   `ref_count INTEGER NOT NULL DEFAULT 1`

建议约束/索引：

-   `UNIQUE(content_hash)`
-   `INDEX idx_image_objects_created_at (created_at DESC)`

## 3.2 新增表：`image_upload_events`（上传事件层）

建议字段：

-   `upload_event_id TEXT PRIMARY KEY`
-   `object_id TEXT NOT NULL`（FK -> `image_objects.object_id`）
-   `uploader_nickname TEXT NOT NULL`
-   `source_batch_id TEXT`（与 v4 批量上传关联）
-   `source_client_file_id TEXT`
-   `upload_mode TEXT NOT NULL`（`normal | instant`）
-   `created_at TEXT NOT NULL`

建议索引：

-   `INDEX idx_upload_events_object_created (object_id, created_at DESC)`
-   `INDEX idx_upload_events_batch (source_batch_id)`

## 3.3 与现有 `images` 表关系（过渡策略）

两种策略中，v5 建议选 A：

-   方案 A（推荐）：`images` 作为“展示聚合视图表”继续保留，新增 `object_id`、`upload_event_id` 外键字段。
-   方案 B：逐步由 `image_upload_events` 替代 `images` 直出（改动大，非 v5 MVP）。

v5 采用 **A**，保证现有列表/详情接口改动最小。

---

## 4. 哈希计算与秒传判定流程

## 4.1 哈希来源

MVP 采用“客户端预哈希 + 服务端复核”双阶段：

-   客户端：在上传前使用 WebCrypto 计算文件 `SHA-256`（用于预检）。
-   服务端：
    -   对“哈希命中且走秒传”的请求按策略抽样复核（可配置）；
    -   对“哈希未命中并实际上传”的对象执行强制复算，防止伪造哈希。

说明：预检哈希用于“是否上传”判定，最终可信口径以服务端校验策略为准。

## 4.2 秒传判定（服务端）

1. 客户端先计算 `content_hash` 并调用 `POST /api/upload-hash/check`。
2. 服务端查询 `image_objects` 是否存在该哈希。
3. 若命中（`exists=true`）：
    - 直接返回可复用对象信息；
    - 客户端不上传对象到 R2；
    - 通过完成接口写入 `image_upload_events(upload_mode=instant)` 与 `images` 展示记录。
4. 若未命中（`exists=false`）：
    - 客户端再走上传链路（批量 `prepare` 或单图 `upload-url`）；
    - 上传完成后服务端复算哈希并写入/关联 `image_objects(upload_mode=normal)`；
    - 写入 `image_upload_events` 与 `images` 展示记录。
5. 响应统一返回 `dedupHit` 与 `uploadMode`，前端可统一展示。

## 4.3 并发冲突处理

-   依赖 `UNIQUE(content_hash)`。
-   插入 `image_objects` 时采用 `INSERT ... ON CONFLICT(content_hash) DO UPDATE`（或等价事务逻辑）。
-   若并发冲突，回查冲突记录并继续写事件，不返回失败。

---

## 5. API 规划（v5，预检接口为 MVP 核心）

## 5.1 `POST /api/upload-hash/check`（MVP 必做）

目标：上传前判重，命中时直接走秒传，不上传对象。

请求体（规划）：

-   `items: [{ clientFileId, fileName, mime, size, contentHash, uploaderNickname, batchId? }]`
-   `turnstileToken`

响应体（规划）：

-   `results: [{ clientFileId, exists, objectId?, objectKey?, dedupHit, errorCode?, message? }]`
-   `hitCount`、`missCount`

行为约束：

-   命中项：前端标记为 `instant-ready`，不再上传文件。
-   未命中项：进入后续上传准备流程。
-   单次检查数量上限建议：`20`。

## 5.2 与 v4 批量接口协同

在批量上传场景下，流程改为：

1. `upload-hash/check`（全量文件）
2. 对未命中项调用 `POST /api/upload-batch/prepare`
3. 上传未命中文件
4. `POST /api/upload-batch/complete` 回传“命中项 + 已上传项”的统一结果

`upload-batch/complete` 结果字段扩展：

-   `uploadMode: normal | instant`
-   `contentHash`
-   `dedupObjectId`
-   `dedupHit: boolean`

## 5.3 单图接口兼容

单图上传流程同样先调 `upload-hash/check`：

-   若命中：直接调用 `POST /api/upload-complete`（带复用对象信息）完成元数据写入。
-   若未命中：按原链路上传后再 `upload-complete`。

`POST /api/upload-complete` 返回字段扩展：

-   `uploadMode`
-   `contentHash`
-   `dedupHit`

---

## 6. 缩略图与去重协同

1. 同一 `content_hash` 只维护一份主对象缩略图。
2. 秒传命中时不重复触发缩略图生成。
3. 展示层按上传事件展示，但读取对象与缩略图可复用同一 `object_id`。

---

## 7. 风控与配额策略

## 7.1 配额计量口径（需明确）

建议 v5 采用“双口径并存”：

-   行为配额：每次上传事件都计数（防刷）。
-   存储配额：仅新对象计入字节增量（更公平）。

## 7.2 限流口径

-   秒传命中也计入请求频率限流。
-   防止利用秒传绕过高频请求保护。

---

## 8. 迁移与回填规划

## 8.1 新增迁移脚本（建议）

-   `infra/d1/migrate-v5-hash-dedup.sql`
    -   创建 `image_objects`
    -   创建 `image_upload_events`
    -   为 `images` 增加 `object_id`、`upload_event_id`（若采用方案 A）

## 8.2 历史数据回填

1. 扫描现有 `images` 活跃记录。
2. 对每个 `object_key` 计算哈希并写 `image_objects`。
3. 为每条历史 `images` 生成对应 `image_upload_events`。
4. 回填 `images.object_id/upload_event_id`。

回填策略：离线批处理，失败可断点续跑。

---

## 9. 前端交互规划

1. 上传前新增“预检阶段”：`计算哈希 -> 调用 upload-hash/check`。
2. 命中项直接展示 `秒传命中（未上传文件）` 标签。
3. 未命中项进入正常上传队列。
4. 批量结果汇总新增：
    - `dedupHitCount`
    - `hashCheckDurationMs`
5. 详情页（可选）显示“首次上传时间 / 最近一次上传时间 / 上传次数”。

---

## 10. 日志与可观测性

建议新增日志字段：

-   `content_hash`
-   `upload_mode`
-   `dedup_hit`
-   `object_id`
-   `upload_event_id`
-   `dedup_conflict_resolved`（并发冲突是否发生）

指标建议：

-   秒传命中率 = `instant / total`
-   去重节省字节数 = `sum(reused_object_size)`
-   并发冲突率

---

## 11. 验收标准（DoD）

1. 重复上传同一文件时，第二次可走秒传并返回 `dedupHit=true`。
2. 秒传命中场景在命中前不上传对象到 R2。
3. 秒传后仍生成新的上传事件记录，上传者/时间不丢失。
4. 并发上传同图不会生成多个 `image_objects` 记录。
5. 展示与详情页面仍可正常访问，不出现断链。
6. v4 批量接口路径与单图路径都支持“先预检后上传”。

---

## 12. 实施阶段（建议）

### Sprint A：数据模型与迁移

-   建表与索引
-   约束与冲突策略
-   历史回填脚本设计

### Sprint B：后端秒传主链路

-   实现 `upload-hash/check` 与判重主链路
-   完成“命中不上传、未命中再上传”流程
-   完成对象复用与事件落库
-   扩展单图接口返回字段

### Sprint C：批量接口协同

-   在 `upload-batch/complete` 接入“命中项 + 上传项”统一落库逻辑
-   增加逐项 `dedupHit` 返回

### Sprint D：前端展示与观测

-   客户端 WebCrypto 预哈希与预检流程
-   上传结果标签与统计
-   日志字段与监控面板
-   回归测试与文档更新

---

## 13. 主要风险与缓解

1. **哈希计算成本增加**
    - 缓解：限制单文件上限、异步化或流式计算。
2. **对象回收误删**
    - 缓解：先软删除并延迟清理，依赖 `ref_count` 或事件引用校验。
3. **并发竞态导致重复对象**
    - 缓解：数据库唯一约束 + 冲突回查 + 幂等重试。
4. **元数据语义混淆**
    - 缓解：强制“对象层”与“事件层”分离，不复用上传事件记录。

---

## 14. 与 Idea Seed 回链

-   对应想法：`Idea-008 基于图片哈希的秒传与元数据关联`
-   当前阶段：`已转入 v5 代码实现计划（仅规划）`
-   计划文档：`plan/v1-r2-pages/code-plan-v5-hash-instant-upload.md`
