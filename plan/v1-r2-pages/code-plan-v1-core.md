# v1 代码实现计划（不写代码）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-26
-   目标：在不改变 v1 业务约束的前提下，给出可直接进入开发排期的代码实现规划。

## 1. 实现边界与硬约束

1. 不做账号登录与鉴权，所有访客可上传。
2. 全部图片公开访问。
3. 上传主路径固定为：前端请求签名 URL -> 直传 R2 -> 上传完成回调。
4. 风控阈值沿用 v1：
    - 访客：`500 张/日`、`2GB/日`
    - 同 IP：`1,500 张/日`、`6GB/日`
    - 全站：`10,000 张/日`、`40GB/日`
    - 单文件：`200MB`
5. 速率基线：`300 req/min/IP`（Normal），并支持 Warning/Critical 回退阈值。

---

## 2. 代码工程结构规划

## 2.1 推荐目录

-   `src/pages/`：前端页面（上传页、列表页、详情页、分享页）
-   `functions/api/`：Pages Functions API 路由
-   `functions/_shared/`：共享逻辑（校验、限流、日志、错误码、配置读取）
-   `functions/_types/`：请求/响应 DTO 与领域类型定义
-   `infra/`：Cloudflare 配置说明（Wrangler、WAF 规则映射、部署说明）
-   `docs/`：接口与运维文档（可选）
-   `tests/`：API 契约测试、核心风控单元测试、端到端流程测试

## 2.2 模块拆分

1. `upload-url` 模块：签名 URL 申请与前置风控。
2. `upload-complete` 模块：上传结果确认、元数据写入、二次校验触发。
3. `list` 模块：公开图片分页查询。
4. `image-meta` 模块：详情页元数据查询。
5. `quota` 模块：visitor/IP/global 配额统计与判断。
6. `rate-limit` 模块：应用层速率限制（与 WAF 互补）。
7. `object-key` 模块：统一 key 生成与 versioned key 规则。
8. `observability` 模块：结构化日志与指标聚合事件。

---

## 3. API 契约计划（实现目标）

## 3.1 `POST /api/upload-url`

**职责**：

-   校验文件元数据（类型、大小）
-   校验 Turnstile token
-   校验 visitor/IP/global 配额
-   生成并返回 R2 presigned PUT URL

**请求字段（计划）**：

-   `filename`
-   `mime`
-   `size`
-   `turnstileToken`
-   `checksum`（可选）

**响应字段（计划）**：

-   `uploadUrl`
-   `objectKey`
-   `expiresAt`
-   `requiredHeaders`

**错误码（计划）**：

-   `UPLOAD_SIZE_EXCEEDED`
-   `MIME_NOT_ALLOWED`
-   `QUOTA_EXCEEDED_VISITOR`
-   `QUOTA_EXCEEDED_IP`
-   `QUOTA_EXCEEDED_GLOBAL`
-   `TURNSTILE_INVALID`
-   `RATE_LIMITED`

## 3.2 `POST /api/upload-complete`

**职责**：

-   确认对象是否存在
-   记录元数据
-   标记对象状态（`uploaded` -> `active`）
-   触发二次校验结果写入

**请求字段（计划）**：

-   `objectKey`
-   `originalFilename`
-   `mime`
-   `size`
-   `etag`（可选）

**响应字段（计划）**：

-   `imageId`
-   `publicUrl`
-   `status`

## 3.3 `GET /api/list`

**职责**：

-   分页返回公开图片列表
-   支持排序（时间/热度，热度可后续）

**查询参数（计划）**：

-   `cursor` / `page`
-   `limit`
-   `sort`

**响应字段（计划）**：

-   `items[]`（`imageId`、`objectKey`、`publicUrl`、`createdAt`、`width`、`height` 等）
-   `nextCursor`

## 3.4 `GET /api/image/:id`（可选）

**职责**：

-   返回详情元数据与当前生效 versioned key
-   指针接口设置短缓存或 no-store

---

## 4. 数据模型与存储计划

## 4.1 元数据存储选型

-   MVP 推荐：`D1`
-   备选：`KV`（结构简单时）

## 4.2 关键实体（计划）

1. `images`
    - `image_id`
    - `object_key`
    - `public_url`
    - `mime`
    - `size_bytes`
    - `status`（`pending_upload` / `uploaded` / `active` / `old_retained` / `old_deleted`）
    - `created_at` / `updated_at`
2. `quota_daily`
    - `bucket_date`
    - `visitor_id`
    - `ip_hash`
    - `upload_count`
    - `upload_bytes`
3. `events`
    - `event_id`
    - `event_type`
    - `severity`
    - `payload`
    - `created_at`

## 4.3 对象命名与版本策略

-   基础格式：`public/{yyyy}/{mm}/{dd}/{uuid}.{ext}`
-   更新策略：只新增 versioned key，不覆盖旧对象

---

## 5. 风控实现计划

## 5.1 访问识别

-   访客标识：IP + UA + 设备特征（匿名）哈希
-   IP 使用 `CF-Connecting-IP`

## 5.2 校验顺序（固定）

1. 参数合法性
2. Turnstile 验证
3. MIME 白名单
4. 文件大小
5. 应用层速率限制
6. 配额（visitor -> IP -> global）
7. 签名 URL 下发

## 5.3 云边协同

-   边缘：WAF + Rate Limiting + Managed Challenge / Under Attack Mode
-   应用：配额、MIME、大小、业务错误码、审计日志

## 5.4 路径白名单（图片域）

按 v2 补充方案预留实现位（可选启用）：

-   仅允许 `img.example.com/validate/<image_key>`
-   非 `/validate/` 路径边缘直接拦截，不回源
-   应用层做路径重写到真实对象路径

---

## 6. 可观测性与告警实现计划

## 6.1 结构化日志字段

-   `timestamp`
-   `request_id`
-   `route`
-   `visitor_id`
-   `ip_hash`
-   `status_code`
-   `error_code`
-   `latency_ms`
-   `r2_ops_a_count`
-   `r2_ops_b_count`
-   `bytes_in` / `bytes_out`

## 6.2 指标聚合任务

-   周期：日级（MVP）
-   产物：
    -   请求总量与分路由
    -   失败率
    -   R2 A/B 趋势
    -   风控命中率

## 6.3 阈值与动作矩阵

-   阈值使用 v1 高流量版：
    -   `error_rate`、`r2.class_b.daily`、`workers.requests.daily`、`upload.blocked.rate_limit`
-   动作矩阵：
    -   Normal：`300 req/min/IP + 30/min/visitor`
    -   Warning：`Managed Challenge` + `180 req/min/IP + 20/min/visitor`
    -   Critical：`Under Attack Mode` + `60 req/min/IP + 6/min/visitor`

---

## 7. 前端实现计划

1. 上传页
    - 文件选择与预校验
    - Turnstile 集成
    - 上传进度与失败重试提示
2. 列表页
    - 分页加载
    - 缩略图优先策略（后续）
3. 详情/分享页
    - 公开访问
    - 统一错误页（404/资源不可用）

---

## 8. 配置与密钥管理计划

## 8.1 环境变量（计划）

-   R2 相关：bucket、account、S3 endpoint
-   Turnstile：site key、secret key
-   风控阈值：visitor/IP/global 限额、大小上限、速率阈值
-   日志开关：`LOG_LEVEL`、采样率

## 8.2 密钥管理

-   使用 Cloudflare Secrets 存储敏感值
-   不在前端暴露任何私钥或签名密钥

---

## 9. 测试计划（不写测试代码）

## 9.1 单元测试

-   MIME 校验
-   大小限制边界
-   配额计算与重置
-   错误码映射

## 9.2 契约测试

-   `upload-url` 成功与各类失败路径
-   `upload-complete` 状态流转
-   `list` 分页稳定性

## 9.3 端到端测试

-   上传 -> 完成 -> 列表可见 -> 分享可访问
-   告警触发下的 Warning/Critical 行为
-   回退流程可执行

---

## 10. 发布计划（代码层面）

1. 开发环境：最小闭环跑通
2. 预发环境：开启 Challenge 与限流灰度
3. 生产发布：
    - 先开 Normal
    - 观察后启用自动 Warning/Critical
4. 发布后 48h：重点看失败率、R2 Class B、Workers 请求量

---

## 11. 任务拆分（可排期）

### Sprint 1（核心链路）

-   上传签名 API
-   上传完成 API
-   列表 API
-   前端上传与列表页

### Sprint 2（风控与观测）

-   配额模块
-   应用层限流
-   Turnstile 接入
-   结构化日志
-   日级聚合

### Sprint 3（稳定与上线）

-   告警阈值接入
-   自动动作矩阵联动
-   压测与回退演练
-   发布门槛核验

---

## 12. 完成定义（Definition of Done）

1. 三个核心 API 满足契约并通过测试计划。
2. 风控阈值与云边规则与文档一致。
3. 告警可触发且自动动作可回退。
4. 上传、展示、分享全链路稳定可用。
5. 不引入登录鉴权，不偏离 v1 业务约束。
