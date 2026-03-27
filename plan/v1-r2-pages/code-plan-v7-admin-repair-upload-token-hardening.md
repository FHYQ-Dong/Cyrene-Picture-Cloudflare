# v7 代码实现计划（不写代码）：管理补偿接口正式化 + upload-complete 一次性令牌校验

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-28
-   前置文档：`code-plan-v5-hash-instant-upload.md`、`code-plan-v6-adaptive-gallery-progress-ui.md`
-   目标：
    1. 提供“仅管理员可调用 + 限速 + 审计日志”的正式缩略图补偿接口；
    2. 为 `POST /api/upload-complete` 引入一次性 `uploadToken` 校验（短 TTL，绑定 `objectKey/mime/size`）；
    3. 下线临时调试路由 `api/debug-thumbnail`。

---

## 1. 本次范围

1. 新增正式管理接口（替代临时调试/临时补偿做法）。
2. 上传主链路升级：`upload-url` 签发一次性令牌，`upload-complete` 强制验签 + 一次性消费。
3. 数据层新增令牌与审计日志表（D1 migration v7）。
4. 更新运维 runbook 与 README 的安全操作说明。

---

## 2. 非目标

-   不引入完整用户登录系统。
-   不改动前端上传交互样式（仅协议字段增加）。
-   不做跨项目统一 IAM（仅本项目最小可行安全闭环）。
-   不重构现有全部风控规则（仅补齐关键缺口）。

---

## 3. 问题复盘与设计约束

## 3.1 当前风险

1. `upload-complete` 目前可被绕过 Turnstile 直接调用（只要参数可构造）。
2. 临时 `debug` 路由具备高权限诊断能力，不应长期暴露。
3. 批量补偿缺少正式鉴权、限速、审计落地。

## 3.2 约束

1. 保持匿名上传模型，不引入账号体系。
2. 继续兼容 Cloudflare Pages Functions + D1 + R2。
3. 方案需支持快速灰度与可回滚。

---

## 4. 总体方案（高层）

1. **上传链路双闸门**

    - 闸门 A：`upload-url` 保留 Turnstile + 配额 + 限流。
    - 闸门 B：`upload-complete` 新增 `uploadToken` 一次性校验（短 TTL + 绑定字段 + 消费态）。

2. **管理补偿接口正式化**

    - 新增 `/api/admin/thumbnail-repair`（建议路径，或沿用 `retry-thumbnails` 但升级契约）。
    - 强制管理员令牌、限速、审计日志。

3. **下线临时调试路由**
    - 移除 `/api/debug-thumbnail`。
    - README 与 runbook 清理临时命令，改为正式管理接口流程。

---

## 5. uploadToken 设计

## 5.1 签发位置与返回字段

### 5.1.1 签发位置

-   由 `POST /api/upload-url` 在通过 Turnstile/限流/配额后签发。

### 5.1.2 新增响应字段

-   `uploadToken`：一次性令牌字符串。
-   `uploadTokenExpiresAt`：ISO 时间戳。
-   （可选）`uploadTokenTtlSeconds`：便于客户端展示与重试控制。

## 5.2 令牌绑定内容

建议绑定以下字段（最小必要集合）：

-   `jti`：随机唯一 ID。
-   `objectKey`
-   `mime`
-   `size`
-   `issuedAt`
-   `expiresAt`
-   `visitorId`（可选，若要绑定发起端）

> 说明：是否绑定 `visitorId` 可配置。若担心移动网络 IP/标识漂移，可先仅绑定 `objectKey/mime/size`，再逐步加严。

## 5.3 签名机制

-   算法：`HMAC-SHA256`（Web Crypto）。
-   秘钥：`UPLOAD_TOKEN_SECRET`（Pages Secret）。
-   令牌格式（建议）：`base64url(payload).base64url(signature)`。

## 5.4 一次性消费机制（关键）

仅签名无法实现“真正一次性”，需落库消费态。

### 5.4.1 新表建议：`upload_tokens`

字段建议：

-   `token_id`（TEXT, PK，对应 `jti`）
-   `object_key`（TEXT）
-   `mime`（TEXT）
-   `size_bytes`（INTEGER）
-   `expires_at`（TEXT）
-   `issued_at`（TEXT）
-   `consumed_at`（TEXT, nullable）
-   `issued_visitor_id`（TEXT, nullable）
-   `issued_ip_hash`（TEXT, nullable）

索引建议：

-   `idx_upload_tokens_expires_at`
-   `idx_upload_tokens_object_key`

### 5.4.2 消费语义

`upload-complete` 校验通过后，执行原子消费：

-   条件：`token_id` 存在、未过期、`consumed_at IS NULL`、绑定字段一致。
-   动作：更新 `consumed_at=now`。
-   若更新行为 0 行：视为无效/已消费/过期，返回 `403`。

---

## 6. upload-complete 契约变更

## 6.1 请求新增字段

-   `uploadToken`（必填，灰度结束后）

## 6.2 校验顺序（建议）

1. 基础参数校验（`objectKey/mime/size`）。
2. 校验 `uploadToken` 格式与签名。
3. 校验 `expiresAt` 与绑定字段匹配。
4. 消费 `upload_tokens`（一次性）。
5. 进入现有 `object head/hash/object reuse/thumb` 主逻辑。

## 6.3 错误码建议

-   `UPLOAD_TOKEN_MISSING`
-   `UPLOAD_TOKEN_INVALID`
-   `UPLOAD_TOKEN_EXPIRED`
-   `UPLOAD_TOKEN_ALREADY_USED`
-   `UPLOAD_TOKEN_BINDING_MISMATCH`

---

## 7. 正式管理补偿接口设计

## 7.1 路由与能力

建议：`POST /api/admin/thumbnail-repair`

能力：

-   `dryRun=true|false`
-   `limit`（默认 50，最大 200）
-   `statusFilter`（默认 `failed`）
-   （可选）`createdAfter`、`createdBefore`

## 7.2 鉴权

至少满足：

1. Header：`Authorization: Bearer <ADMIN_API_TOKEN>`（Pages Secret）。
2. token 常量时间比较。

增强（推荐）：

-   Cloudflare Access 仅允许管理员身份访问该路径。

## 7.3 限速

-   复用现有分钟计数器模型，新增 scope：`admin_api`。
-   限速粒度：`admin_token_hash + ip_hash`。
-   默认阈值建议：`10 req/min`。

## 7.4 审计日志（D1）

### 7.4.1 新表建议：`admin_action_logs`

字段建议：

-   `action_id`（TEXT, PK）
-   `action_type`（TEXT，例如 `thumbnail_repair`）
-   `actor_token_hash`（TEXT）
-   `ip_hash`（TEXT）
-   `request_id`（TEXT）
-   `params_json`（TEXT）
-   `result_json`（TEXT）
-   `status`（TEXT：`ok|error`）
-   `created_at`（TEXT）

### 7.4.2 审计最小集

-   入参（limit/dryRun/filter）
-   处理总数、成功数、失败数
-   失败错误码聚合

## 7.5 返回结构（建议）

-   `requestId`
-   `picked`
-   `processed`
-   `succeeded`
-   `failed`
-   `durationMs`
-   `items`（可选，默认不返回明细，防止过大）

---

## 8. 临时 debug 路由下线方案

1. 移除 `functions/api/debug-thumbnail.js`。
2. 文档移除临时调试接口说明。
3. 若需保留诊断能力，改为仅管理员可调的 `admin` 路由子能力（受鉴权+限速+审计）。
4. 上线后做一次回归确认：`/api/debug-thumbnail` 应为 404。

---

## 9. 配置项与密钥

## 9.1 新增 Secrets

-   `UPLOAD_TOKEN_SECRET`（必需）
-   `ADMIN_API_TOKEN`（必需）

## 9.2 新增 Vars（建议）

-   `UPLOAD_TOKEN_TTL_SECONDS`（默认 900）
-   `UPLOAD_COMPLETE_REQUIRE_TOKEN`（灰度开关，默认 `false`，上线后改 `true`）
-   `ADMIN_API_RATE_LIMIT_PER_MIN`（默认 10）

---

## 10. 数据迁移（v7）

新增迁移文件建议：`infra/d1/migrate-v7-upload-token-admin-audit.sql`

包含：

1. `upload_tokens` 表 + 索引
2. `admin_action_logs` 表 + 索引

并在 README 中追加：

-   `npm run db:migrate:v7:local`
-   `npm run db:migrate:v7:remote`

---

## 11. 兼容性与灰度发布

## 11.1 阶段化

### Phase A（灰度兼容）

-   `upload-url` 开始签发 `uploadToken`；
-   `upload-complete` 支持“有 token 则校验，无 token 仅告警日志”（受开关控制）。

### Phase B（强制启用）

-   前端稳定携带 token 后，开启 `UPLOAD_COMPLETE_REQUIRE_TOKEN=true`。

### Phase C（收口）

-   下线 `debug` 路由；
-   仅保留正式 admin 补偿接口。

## 11.2 回滚

-   紧急情况下可将 `UPLOAD_COMPLETE_REQUIRE_TOKEN=false` 临时放开；
-   不回滚数据库结构，仅回滚校验策略。

---

## 12. 测试与验收计划

## 12.1 uploadToken 链路

1. 正常流程：`upload-url -> upload-direct/presign -> upload-complete` 成功。
2. token 缺失：`upload-complete` 返回 `UPLOAD_TOKEN_MISSING`。
3. token 过期：返回 `UPLOAD_TOKEN_EXPIRED`。
4. token 复用（第二次）：返回 `UPLOAD_TOKEN_ALREADY_USED`。
5. token 绑定不匹配（改 `size`/`mime`）：返回 `UPLOAD_TOKEN_BINDING_MISMATCH`。

## 12.2 管理接口

1. 无 token 调用：admin 接口 401。
2. 超限调用：返回 429。
3. `dryRun=true` 不落库变更。
4. 执行模式：有审计记录写入，结果计数准确。

## 12.3 下线验证

-   `/api/debug-thumbnail` 返回 404。

---

## 13. 风险与缓解

1. **客户端漏传 token 导致上传失败**
    - 缓解：分阶段灰度 + 明确错误码 + 前端兜底提示。
2. **D1 令牌表增长**
    - 缓解：定期清理过期且已消费 token（计划任务或后台维护命令）。
3. **管理员 token 泄露**
    - 缓解：短周期轮换 + Cloudflare Access 二次保护 + 审计告警。

---

## 14. DoD（验收标准）

1. `upload-complete` 在强制模式下无法绕过 `uploadToken`。
2. 同一 `uploadToken` 只能成功消费一次。
3. 正式补偿接口满足：管理员鉴权、限速、审计三项全部生效。
4. 临时 `debug` 路由完成下线并通过回归验证。
5. README / runbook / migration 文档更新齐全。

---

## 15. 交付清单（仅设计阶段）

1. 本文档：`plan/v1-r2-pages/code-plan-v7-admin-repair-upload-token-hardening.md`
2. 待实现任务拆解（开发阶段执行）：
    - Token 签发/验签与一次性消费
    - Admin 正式补偿接口
    - D1 v7 迁移
    - Debug 路由下线
    - 文档与运维脚本更新
