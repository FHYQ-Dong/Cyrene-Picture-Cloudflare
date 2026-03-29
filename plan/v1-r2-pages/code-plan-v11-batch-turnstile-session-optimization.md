# v11 代码实现计划（不写代码）：批量上传一次 Turnstile 验证会话化（承接 v10）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-29
-   承接文档：`code-plan-v10-batch-upload-over20-stuck-fix.md`
-   来源问题：大批量分片上传时每片都需要重新人机验证，体验变慢，且在长流程中容易触发 `turnstile verification failed`
-   目标：保留分片上传稳定性，同时将 Turnstile 验证降为“整批一次验证”。

---

## 1. 问题与目标

## 1.1 当前痛点

1. v10 已解决 >20 卡住，但分片流程中 `prepare` 仍可能多次触发 Turnstile。
2. 大批次（如 60 张）会增加用户交互负担，影响上传时长与体验。
3. token 一次性语义导致“复用失败”，需要额外重试逻辑。

## 1.2 v11 目标

1. 一次批量上传仅做 **一次** Turnstile 验证。
2. 后续所有分片 `prepare` 请求改用批次会话令牌，不再要求新的 Turnstile token。
3. 维持 v10 的分片与终态收敛，避免回归卡住问题。

---

## 2. 方案总览

新增“批次验证会话”接口：

1. 前端在开始批量上传前调用 `POST /api/upload-batch/session`，提交 `turnstileToken` + `batchId`。
2. 后端完成 Turnstile 校验后签发 `batchSessionToken`（短 TTL，绑定 `batchId/visitorId/ipHash`）。
3. 前端分片调用 `upload-batch/prepare` 时仅携带 `batchSessionToken`。
4. 后端 `prepare` 验签会话令牌并继续现有限流/配额逻辑。

> 关键点：把“人机验证”从“每片请求”抽离为“整批会话初始化”。

---

## 3. 接口设计

## 3.1 新增 `POST /api/upload-batch/session`

### 请求体

```json
{
	"batchId": "uuid",
	"turnstileToken": "cf-turnstile-token"
}
```

### 响应体

```json
{
	"ok": true,
	"data": {
		"batchId": "uuid",
		"batchSessionToken": "signed-token",
		"expiresAt": "2026-03-29T10:00:00.000Z",
		"ttlSeconds": 900
	}
}
```

## 3.2 修改 `POST /api/upload-batch/prepare`

-   新增入参：`batchSessionToken`（必填，v11 模式）。
-   当缺失或无效时返回：`UPLOAD_BATCH_SESSION_INVALID` / `UPLOAD_BATCH_SESSION_EXPIRED`。
-   不再要求每片都传 Turnstile token（仍保留兼容窗口可选）。

---

## 4. 会话令牌设计

## 4.1 载荷字段

-   `sid`：会话 ID
-   `batchId`
-   `visitorId`
-   `ipHash`
-   `issuedAt`
-   `expiresAt`

## 4.2 签名机制

-   HMAC-SHA256（复用 upload token 方案风格）
-   新 secret：`UPLOAD_BATCH_SESSION_SECRET`

## 4.3 TTL 建议

-   默认 900 秒（15 分钟），可配置：`UPLOAD_BATCH_SESSION_TTL_SECONDS`

---

## 5. 代码改造清单

1. `functions/_shared/env.js`

    - 新增配置：
        - `uploadBatchSessionSecret`
        - `uploadBatchSessionTtlSeconds`

2. `functions/_shared/upload-batch-session.js`（新建）

    - `issueBatchSessionToken(config, payload)`
    - `verifyBatchSessionToken(config, token)`

3. `functions/api/upload-batch/session.js`（新建）

    - 校验 Turnstile
    - 签发 `batchSessionToken`

4. `functions/api/upload-batch/prepare.js`

    - 增加 `batchSessionToken` 验证
    - 兼容期内支持旧 `turnstileToken`（可选）

5. `public/upload.js`
    - 开始上传前先请求 session token
    - 每个分片 prepare 使用该 token
    - token 过期时提示用户重新验证一次并续传

---

## 6. 错误码与提示文案

新增错误码：

-   `UPLOAD_BATCH_SESSION_MISSING`
-   `UPLOAD_BATCH_SESSION_INVALID`
-   `UPLOAD_BATCH_SESSION_EXPIRED`

前端文案建议：

-   “批次验证已过期，请重新完成人机验证后继续剩余上传。”

---

## 7. 安全与风控

1. 会话令牌绑定 `visitorId/ipHash`，防止跨端复用。
2. 仍保留原有分钟限流与配额控制（visitor/ip/global）。
3. 会话 TTL 短，过期后需重新验证。

---

## 8. 发布策略

1. **Phase A（兼容）**
    - 上线 `upload-batch/session` 和 `prepare` 的会话校验逻辑；
    - `prepare` 临时兼容旧 `turnstileToken`。
2. **Phase B（前端切换）**
    - 前端改为先拿 `batchSessionToken` 再执行分片；
    - 监控失败率与平均上传耗时。
3. **Phase C（收口）**
    - 移除 `prepare` 对旧模式依赖（仅保留会话模式）。

---

## 9. 测试计划

1. 批量 60 张上传：仅首阶段要求一次人机验证，后续分片无需再次人工交互。
2. 会话过期后继续上传：返回过期错误并可重新验证续传。
3. 非法会话令牌：被拒绝且不消耗上传配额。
4. 回归 v10：>20 不再卡住，终态收敛仍正确。

---

## 10. DoD

1. 60 张上传场景中，不再出现每片验证带来的体验中断。
2. 分片上传仍稳定，失败项可解释且可重试。
3. Turnstile 只在批次初始化阶段触发一次。
4. 回归测试（21/50/60）通过。
