# v4 代码实现计划（不写代码）：批量上传图片（Idea-007）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-27
-   来源想法：`plan/0-idea-seed-backlog.md`（Idea-007）
-   前置文档：`code-plan-v1-core.md`、`code-plan-v2-ui.md`、`code-plan-v3-thumbnail-navigation.md`、`code-plan-v5-hash-instant-upload.md`
-   目标：在保持匿名上传、风控与公开展示策略不变的前提下，基于 v5 预检秒传能力实现“多文件一次选择 + 队列上传 + 每项状态可见”。

> 适配说明：当前按“先落地 v5，再实现 v4”执行。v4 不重复实现哈希去重内核，直接消费 v5 的 `upload-hash/check` 能力。

---

## 1. 目标与范围

### 1.1 本次目标

1. 上传页支持一次选择多张图片（批量选择）。
2. 前端批量流程先调用 v5 预检接口，命中项直接秒传，未命中项再进入上传。
3. 后端批量辅助接口承接“未命中上传 + 命中直写”的统一完成逻辑。
4. 每张图片展示独立状态：`等待中`、`上传中`、`成功`、`失败`。
5. 支持单项失败重试与整批取消（MVP 可先实现“停止后不再启动新任务”）。
6. 完成后可汇总结果：成功数、失败数、失败原因分布。

### 1.2 非目标

-   不引入账号体系、相册系统、私密权限。
-   不实现断点续传（chunk/resumable）与近似去重算法（如 pHash）。
-   不在 v4 重新实现内容哈希判重内核（由 v5 提供）。
-   不在 v4 引入复杂的动态并发自适应算法。

---

## 2. 现状复用与约束

## 2.1 可复用能力

-   现有单图链路：`/api/upload-url` -> R2 上传 -> `/api/upload-complete`。
-   v5 预检能力：`POST /api/upload-hash/check`（命中前不上传）。
-   现有风控能力：Turnstile、分钟级限流、日配额、大小/MIME 校验。
-   现有本地模式：`LOCAL_UPLOAD_DIRECT=true` 可同源上传避免 CORS。

## 2.2 关键约束

-   批量上传本质是“短时间高频调用单图接口”，容易触发限流/配额。
-   大批量并发会放大失败率与 UI 状态复杂度。
-   需保证失败可解释，不出现“静默丢图”。

---

## 3. 总体方案

## 3.1 策略选择

采用“**前端队列 + v5 预检优先 + 批量接口承接**”方案：

-   先调用 `POST /api/upload-hash/check` 对全量文件做哈希预检。
-   命中项不上传文件，直接进入“待完成写入”集合。
-   未命中项调用 `POST /api/upload-batch/prepare` 获取上传凭证并执行上传。
-   统一通过 `POST /api/upload-batch/complete` 回传“命中项 + 上传项”结果。
-   当批量接口不可用时，自动回退单图链路。
-   队列统一调度并发度（建议默认并发 `2`）。
-   保持对既有单图接口兼容，降低升级风险。

## 3.2 队列状态模型

每项任务状态建议：

-   `queued`：已加入队列，未开始。
-   `hash-checking`：计算哈希并请求预检。
-   `instant-ready`：命中秒传，无需上传对象。
-   `preparing`：申请上传地址中。
-   `uploading`：上传对象中。
-   `finalizing`：写元数据中。
-   `success`：完成并拿到 `imageId`。
-   `failed`：失败，记录 `errorCode/errorMessage`。
-   `canceled`：用户取消后未执行或中止。

批次状态建议：

-   `idle`、`running`、`paused`（可选）、`completed`、`partially_failed`、`canceled`。

---

## 4. 前端实现规划

## 4.1 交互与页面结构（`public/upload.html`）

新增/调整区域：

1. 文件选择区
    - `input[type=file][multiple]`
    - 显示已选数量、总大小。
2. 队列列表区
    - 每项显示：文件名、大小、状态、进度条（MVP 可先百分比文本）。
3. 批次操作区
    - `开始上传`、`停止队列`、`重试失败项`、`清空已完成`。
4. 汇总区
    - 成功数、失败数、进行中数量、预计剩余（可选）。

## 4.2 调度与并发（`public/upload.js`）

建议新增模块化能力：

-   `createBatchSession(files, options)`：构建任务数组。
-   `computeHash(task)`：客户端预哈希。
-   `runHashCheck(session)`：批量调用 `upload-hash/check`。
-   `runQueue(session)`：按并发池执行。
-   `runSingleTask(task)`：复用单图上传流程。
-   `cancelSession(session)`：停止拉起新任务。
-   `retryFailed(session)`：重置失败任务并重新入队。

并发策略：

-   默认并发：`2`。
-   上限建议：`3`（避免触发分钟限流）。
-   当连续出现 `RATE_LIMITED` / `QUOTA_EXCEEDED`：
    -   当前批次自动降速到串行，或暂停并提示用户（二选一，MVP 推荐暂停）。

## 4.3 Turnstile 使用策略

建议以“每文件一次 token”作为默认安全口径：

-   每启动一个文件上传前，确保 token 有效。
-   token 失效时自动提示用户重新验证后继续队列。
-   不建议在 v4 默认复用单次 token 覆盖整批（风险较高）。

---

## 5. 后端与 API 规划（v4 MVP 直接实现）

## 5.1 复用 `POST /api/upload-hash/check`（v5 前置能力）

目标：批量流程优先判重，命中项不上传对象。

请求体（复用 v5）：

-   `items: [{ clientFileId, fileName, mime, size, contentHash, uploaderNickname, batchId? }]`
-   `turnstileToken`

响应体（复用 v5）：

-   `results: [{ clientFileId, exists, objectId?, objectKey?, dedupHit, errorCode?, message? }]`
-   `hitCount`、`missCount`

约束：

-   v4 仅消费该接口，不在本阶段重复定义哈希判定规则。

## 5.2 `POST /api/upload-batch/prepare`

目标：一次申请 N 个文件的上传凭证，减少前端多次往返。

请求体（规划）：

-   `files: [{ fileName, mime, size, uploaderNickname }]`
-   `turnstileToken`
-   `batchId`（前端生成 UUID）

响应体（规划）：

-   `batchId`
-   `items: [{ clientFileId, objectKey, uploadUrl, expiresAt, requiredHeaders }]`
-   `acceptedCount`、`rejectedCount`
-   `rejectedItems: [{ clientFileId, errorCode, message }]`

约束：

-   单次 `prepare` 数量上限建议：`20`。
-   仅为“`upload-hash/check` 未命中项”发放上传凭证。

## 5.3 `POST /api/upload-batch/complete`

目标：批量写入上传完成结果，统一返回每项状态。

请求体（规划）：

-   `batchId`
-   `items: [{ clientFileId, dedupHit, contentHash, objectKey?, mime, size, etag?, uploaderNickname }]`

响应体（规划）：

-   `batchId`
-   `results: [{ clientFileId, ok, uploadMode, imageId?, publicUrl?, thumbUrl?, dedupObjectId?, errorCode?, message? }]`
-   `successCount`、`failedCount`

约束：

-   每项独立事务语义：单项失败不影响其他项。
-   响应必须返回“与请求同长度”的逐项结果，便于前端准确落状态。

## 5.4 兼容与兜底

-   现有单图接口继续保留：`POST /api/upload-url`、`POST /api/upload-complete`。
-   批量流程异常时，前端可降级到单图接口，保证可用性。

---

## 6. 风控与配额策略

## 6.1 限流协同

批量上传容易踩分钟阈值，需明确交互：

-   命中限流时，不清空队列。
-   将当前任务标记失败并给出可重试按钮。
-   批次层提示“建议降低并发/稍后重试”。

## 6.2 配额协同

当返回配额超限：

-   后续任务直接进入 `canceled` 或 `failed`（统一文案：今日额度已达上限）。
-   提供“仅保留未上传清单”导出（可选）。

---

## 7. 数据与日志规划

## 7.1 数据库

-   `images` 表无需新增字段（MVP 可直接复用）。
-   v4 依赖 v5 新增的数据结构（`image_objects`、`image_upload_events`），不在 v4 重复建模。
-   批次会话不落库（前端内存态），降低实现复杂度。

## 7.2 日志

建议新增前后端关键日志字段：

-   前端：`batch_id`、`task_index`、`file_name`、`file_size`、`stage`、`result`。
-   后端：`batch_id`、`client_file_id`、`route`、`status_code`、`error_code`、`items_count`。

---

## 8. 错误码与用户提示规划

需要在上传页统一映射：

-   `TURNSTILE_INVALID`：请完成人机验证后继续。
-   `RATE_LIMITED`：上传过快，请稍后重试或降低并发。
-   `QUOTA_EXCEEDED`：今日额度用尽。
-   `MIME_NOT_ALLOWED`：文件格式不支持。
-   `FILE_TOO_LARGE`：文件超出限制。
-   `HASH_CHECK_FAILED`：哈希预检失败，请重试。
-   `HASH_MISMATCH`：服务端校验哈希不一致。
-   `INTERNAL_ERROR`：服务异常，请重试。

MVP 要求：

-   每项失败必须能看到失败原因。
-   整批结束必须给出结果摘要。

---

## 9. 测试与验收规划

## 9.1 功能验收

1. 一次选择 10 张图可完整执行。
2. 命中秒传项在命中前不上传对象，且可正常完成入库。
3. 失败项可单独重试并成功。
4. 停止队列后不会继续启动新任务。

## 9.2 异常验收

1. 人机验证过期后，队列可恢复继续。
2. 命中限流时，UI 明确提示且不崩溃。
3. 网络波动下，失败项状态准确。

## 9.3 性能与体验指标（建议）

-   20 张图批量上传时，页面交互保持可响应。
-   队列状态刷新平滑，无明显卡顿。

---

## 10. 实施拆分（建议）

### Sprint A：v5 前置能力对齐

-   校验 `upload-hash/check` 契约与返回字段
-   确认秒传命中项完成写入链路可复用
-   对齐错误码与风控口径

### Sprint B：批量接口与契约

-   定义 `upload-batch/prepare` 与 `upload-batch/complete` 请求/响应结构
-   实现“命中项 + 上传项”统一逐项返回结果
-   保持单图接口兼容

### Sprint C：队列基础能力

-   多文件选择
-   对接 `upload-hash/check` + `prepare` 结果并创建任务
-   列表状态展示

### Sprint D：并发与重试

-   并发池（默认 2）
-   单项重试
-   批次停止

### Sprint E：风控协同与体验

-   限流/配额提示优化
-   失败原因标准化文案
-   结果汇总与清理操作

### Sprint F：回归与文档

-   本地/线上场景回归
-   README 补充批量上传操作说明

---

## 11. 风险与缓解

1. 队列状态复杂导致前端 bug
    - 缓解：状态机枚举固定，禁止隐式状态跳转。
2. 并发过高触发大量失败
    - 缓解：默认小并发 + 限流后降速/暂停。
3. Turnstile 与批量流程冲突
    - 缓解：明确“每文件校验一次”的续传策略。

---

## 12. 与 Idea Seed 回链

-   对应想法：`Idea-007 批量上传图片`
-   当前阶段：`已转入 v4 代码实现计划（仅规划）`
-   计划文档：`plan/v1-r2-pages/code-plan-v4-batch-upload.md`
