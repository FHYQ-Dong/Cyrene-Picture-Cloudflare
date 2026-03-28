# v8 代码实现计划（不写代码）：管理员删除图片（单图 + 批量）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-28
-   来源想法：`plan/0-idea-seed-backlog.md`（Idea-011）
-   前置文档：`code-plan-v5-hash-instant-upload.md`、`code-plan-v7-admin-repair-upload-token-hardening.md`
-   目标：在保持匿名上传模型不变的前提下，新增可审计、可限速、可回滚的管理员删除能力，覆盖“单图删除 + 批量删除”。

---

## 1. 本次范围

1. 新增管理员删除接口：支持按 `image_id` 删除单张图片。
2. 新增管理员批量删除接口：支持一次提交多张图片删除请求。
3. 删除流程统一接入：鉴权、限速、审计、dry-run、错误码体系。
4. 数据一致性保障：先软删元数据，再按引用计数条件删除 R2 对象。
5. 运维文档更新：补充“删除操作”运行手册与风险提示。

---

## 2. 非目标

-   不引入用户登录与 RBAC 多角色体系（沿用现有管理员 token）。
-   不实现回收站恢复（本版删除为不可恢复操作）。
-   不实现异步任务队列（MVP 先同步处理，批量限制上限）。
-   不实现按规则自动删除（如按时间/标签策略定时清理）。

---

## 3. 现状问题与设计约束

## 3.1 现状问题

1. 违规/误传图片处理依赖手工 SQL + R2 删除，操作风险高。
2. 缺少统一审计，难追踪“谁在何时删了什么”。
3. 共享对象（哈希复用）存在引用关系，粗暴删除会误伤其他图片。

## 3.2 设计约束

1. 不破坏现有 `image_objects`/`image_upload_events` 模型。
2. 删除必须可观测：有 `requestId`、逐项结果、审计落库。
3. 批量接口必须可控：严格限速 + 条数上限 + payload 大小约束。

---

## 4. 总体方案

1. **单图删除**：`POST /api/admin/delete-image`

    - 入参 `imageId`，可选 `dryRun`、`reason`。
    - 返回单项删除结果 + 对象处理结果 + 审计 ID。

2. **批量删除**：`POST /api/admin/delete-images`

    - 入参 `imageIds[]`（建议上限 50），可选 `dryRun`、`reason`、`continueOnError`。
    - 逐项独立执行，汇总成功/失败/跳过统计。

3. **统一删除内核**（共享函数）

    - 输入：`imageId`、`dryRun`、`actor`、`reason`。
    - 输出：`status`、`dbMutations`、`r2Actions`、`errorCode`。

4. **删除策略**

    - 第 1 步：校验图片是否存在且 `status='active'`。
    - 第 2 步：软删 `images.status='deleted'`，写 `updated_at`。
    - 第 3 步：根据 `object_id` 递减 `image_objects.ref_count`。
    - 第 4 步：若 `ref_count` 归零，删除 R2 原图与缩略图对象（幂等）。
    - 第 5 步：写入 `admin_action_logs`（单图与批量都落审计）。

---

## 5. API 设计

## 5.1 `POST /api/admin/delete-image`

### 5.1.1 请求体

```json
{
	"imageId": "uuid-or-id",
	"dryRun": true,
	"reason": "违规内容/测试清理/版权投诉"
}
```

### 5.1.2 响应体（建议）

```json
{
	"ok": true,
	"data": {
		"requestId": "...",
		"actionId": "...",
		"item": {
			"imageId": "...",
			"result": "deleted|skipped|would_delete|failed",
			"db": {
				"imageSoftDeleted": true,
				"objectRefDecremented": true
			},
			"storage": {
				"originObjectDeleted": false,
				"thumbObjectDeleted": false
			},
			"errorCode": null,
			"message": "..."
		}
	}
}
```

## 5.2 `POST /api/admin/delete-images`

### 5.2.1 请求体

```json
{
	"imageIds": ["id-1", "id-2"],
	"dryRun": false,
	"reason": "批量测试清理",
	"continueOnError": true
}
```

### 5.2.2 响应体（建议）

```json
{
	"ok": true,
	"data": {
		"requestId": "...",
		"actionId": "...",
		"summary": {
			"total": 2,
			"succeeded": 1,
			"failed": 1,
			"skipped": 0,
			"durationMs": 128
		},
		"items": [
			{
				"imageId": "id-1",
				"result": "deleted",
				"errorCode": null,
				"message": "ok"
			},
			{
				"imageId": "id-2",
				"result": "failed",
				"errorCode": "OBJECT_REF_CONFLICT",
				"message": "object still referenced"
			}
		]
	}
}
```

### 5.2.3 批量约束

-   单次 `imageIds` 上限：`50`（可配置 `ADMIN_DELETE_BATCH_MAX_ITEMS`）。
-   去重后执行（重复 ID 不重复删）。
-   `continueOnError=false` 时首错中止；`true` 时继续并汇总失败项。

---

## 6. 鉴权、限速与审计

## 6.1 鉴权

-   强制 `Authorization: Bearer <ADMIN_API_TOKEN>`。
-   使用常量时间比较，避免时序侧信道。

## 6.2 限速

-   复用 `admin_api` 分钟限速模型。
-   默认建议：
    -   单图删除：`20 req/min`
    -   批量删除：`5 req/min`

## 6.3 审计

-   复用 `admin_action_logs` 表。
-   `action_type` 新增：`delete_image`、`delete_images_batch`。
-   审计必须包含：`reason`、`dryRun`、`imageIds`（或数量）、成功失败统计、错误码聚合。

---

## 7. 数据与存储一致性设计

## 7.1 数据库层动作顺序（单项）

1. 查询 `images`：不存在或非 `active` 返回 `OBJECT_NOT_FOUND` / `IMAGE_ALREADY_DELETED`。
2. 将该行置 `status='deleted'`，写 `updated_at`。
3. 若存在 `object_id`：`ref_count = MAX(ref_count-1, 0)`。
4. 若 `ref_count` 变为 `0`：标记“可删对象”。

## 7.2 R2 层动作

-   仅删除“可删对象”关联的 `object_key` 与可用 `thumb_object_key`。
-   R2 删除采用幂等语义：对象不存在也视为成功（记录 `not_found`）。

## 7.3 失败补偿

-   若 DB 成功但 R2 失败：
    -   API 返回部分失败（`PARTIAL_DELETE_STORAGE_FAILED`）；
    -   记录审计并可由后续补偿任务重试。

---

## 8. 错误码建议

-   `ADMIN_AUTH_REQUIRED`
-   `ADMIN_AUTH_INVALID`
-   `ADMIN_RATE_LIMITED`
-   `INVALID_REQUEST`
-   `BATCH_LIMIT_EXCEEDED`
-   `OBJECT_NOT_FOUND`
-   `IMAGE_ALREADY_DELETED`
-   `OBJECT_REF_CONFLICT`
-   `R2_DELETE_FAILED`
-   `PARTIAL_DELETE_STORAGE_FAILED`
-   `INTERNAL_ERROR`

---

## 9. 配置项

-   `ADMIN_API_TOKEN`（已有，必需）
-   `ADMIN_API_RATE_LIMIT_PER_MIN`（已有）
-   `ADMIN_DELETE_BATCH_MAX_ITEMS`（新增，默认 `50`）
-   `ADMIN_DELETE_ALLOW_DRY_RUN`（新增，默认 `true`）

---

## 10. 实现拆分（建议）

1. `functions/_shared/db.js`

    - 新增删除相关 DB 操作：
        - `getImageForDelete(imageId)`
        - `softDeleteImage(imageId)`
        - `decrementObjectRefCount(objectId)`

2. `functions/_shared/admin-delete.js`（新建）

    - 封装单项删除内核：`deleteOneImage({ env, imageId, dryRun, reason, actor })`。

3. `functions/api/admin/delete-image.js`（新建）

    - 单图 API 入口，调用共享删除内核。

4. `functions/api/admin/delete-images.js`（新建）

    - 批量 API 入口，循环调用共享删除内核并汇总。

5. `README.md`
    - 新增管理员删除接口文档（调用示例、错误码、风险提示）。

---

## 11. 测试与验收计划

## 11.1 单图删除

1. `dryRun=true`：不改 DB/R2，仅返回 `would_delete`。
2. 正常删除：`active -> deleted`，引用计数正确递减。
3. 重复删除：返回 `IMAGE_ALREADY_DELETED`。
4. 对象无引用：触发 R2 删除动作并记录结果。

## 11.2 批量删除

1. 混合场景（存在/不存在/已删）可返回逐项结果。
2. `continueOnError=false` 首错中止；`true` 持续执行。
3. 超过上限返回 `BATCH_LIMIT_EXCEEDED`。

## 11.3 安全与审计

1. 无 token / 错 token 返回 401。
2. 超限返回 429。
3. 每次调用均有 `admin_action_logs` 记录。

---

## 12. 发布与回滚

## 12.1 发布顺序

1. 先上线共享删除内核与 API（默认仅 `dryRun` 演练）。
2. 运维验证审计与限速后再开启真实删除。
3. 最后放开批量删除（若风险高可先仅开放单图）。

## 12.2 回滚策略

-   紧急情况下临时关闭路由或将删除接口强制 `dryRun`。
-   保留审计与错误记录，不回滚历史日志。

---

## 13. DoD（完成定义）

1. 管理员可通过 API 完成单图删除与批量删除。
2. 删除流程具备鉴权、限速、审计与 dry-run。
3. 共享对象不会被误删，引用计数与 R2 处理一致。
4. README 与 runbook 补齐并可按文档独立执行。
