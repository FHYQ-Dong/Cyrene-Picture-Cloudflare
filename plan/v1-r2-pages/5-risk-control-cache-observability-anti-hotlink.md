# 5.x 详细设计：滥用上传 / 缓存一致性 / 可观测性 / 防盗链

-   文档日期：2026-03-26
-   适用范围：基于 `Cloudflare Pages + Pages Functions(Workers Free) + R2` 的二次元图片站
-   说明：本报告**按你的要求忽略 5.1 内容合规风险**，仅展开 5.2 ~ 5.5。

## 约束变更（本次）

1. 不引入用户登录与鉴权，所有访客都可上传。
2. 全部图片公开可访问。
3. 需考虑加入 Cloudflare 人类验证（Challenge）。

> 配套仪表盘点选清单：[`6-cloudflare-dashboard-click-runbook.md`](./6-cloudflare-dashboard-click-runbook.md)

## 0. 设计目标与约束

### 目标

1. 在免费层尽量控制资源被恶意消耗（请求、存储、R2 A/B 操作）。
2. 在图片更新后保持“用户看见新图”的一致体验。
3. 在免费层有限监控下，仍能看清核心健康度与成本趋势。
4. 降低公开图床被盗链、刷流量、批量爬取的风险。

### 已知约束（影响设计）

-   Workers Free：`100,000 requests/day`，`10ms CPU/invocation`。
-   R2 免费月配额：`10GB`、Class A `100万`、Class B `1000万`。
-   免费层观测能力有限，日志保留与高级分析能力不如付费。

---

## 1. 5.2 滥用上传风险：配额 + 白名单 + 大小限制 + 速率限制

> 核心原则：**“先拦截、再签发、后落盘”**。不要把任何用户输入直接转成可上传资格。

### 1.1 匿名上传识别与配额模型（最小可行）

在 `POST /api/upload-url` 中执行以下顺序：

1. 基于访客指纹进行匿名识别（IP + UA 哈希 + `CF-Connecting-IP` + Challenge 通行状态）。
2. 检查访客日配额：
    - `visitor_upload_count`
    - `visitor_upload_bytes`
3. 检查 IP 级配额（防共享网络下单访客绕过）：
    - `ip_upload_count`
    - `ip_upload_bytes`
4. 检查全站日配额（防止单日打爆免费层）：
    - `global_upload_count`
    - `global_upload_bytes`
5. 校验文件元数据：`mime`, `size`, `extension`。
6. 通过后签发 presigned PUT URL（短有效期，建议 5 分钟）。

推荐默认值（MVP）：

-   访客（visitor）`500 张/日`、`2GB/日`
-   同 IP `1,500 张/日`、`6GB/日`
-   全站保护阈值：`10,000 张/日`、`40GB/日`（建议按 R2 剩余容量动态降额）

### 1.2 类型白名单与“伪造 MIME”防护

只允许：

-   `image/jpeg`
-   `image/png`
-   `image/webp`
-   （可选）`image/avif`

策略：

1. 签发 URL 时把 `Content-Type` 写入签名约束（官方支持）。
2. 上传完成后执行二次校验：
    - 读取对象前几个字节（magic bytes）判定真实格式；
    - 若类型与声明不符，立即删除对象并记一次违规。

### 1.3 大小限制策略

-   单文件上限建议：`200MB`（初期大量上传场景）。
-   签发 URL 前校验 `declaredSize`。
-   前端也做一次阻断（提升体验），但以后端校验为准。
-   大于 `100MB` 的文件建议走分片/断点续传（multipart）以提升成功率。
-   对超限请求返回统一错误码（如 `UPLOAD_SIZE_EXCEEDED`）。

### 1.4 速率限制（四层）

1. **Cloudflare WAF / Rate Limiting**（边缘第一层）
    - 针对 `/api/upload-url` 做 IP 维度限速，例如：`300 req/min/IP`（初期冲量档）。
2. **Cloudflare Challenge（Managed Challenge / Under Attack Mode）**
    - 在高风险时段对上传入口页或上传 API 路径追加人类验证挑战。
3. **Turnstile（应用层人机验证）**
    - 上传前提交 token，后端验证通过才给签名 URL。
4. **应用层限流**（匿名访客维度）
    - 每访客每分钟请求签名次数上限（如 `30/min`）。
    - 每 IP 每分钟签名请求上限建议 `120/min`（防同网段聚合打满后端）。
    - 攻击态回退阈值：`60 req/min/IP` + `6/min/visitor`（与 Under Attack Mode 联动）。
5. **对象键策略**
    - key 不可由用户完全自定义，避免覆盖/探测：
    - 统一采用：`public/{yyyy}/{mm}/{dd}/{uuid}.{ext}`。

### 1.5 滥用事件处置

定义 `abuse_score`：

-   命中超频 +1
-   MIME 不一致 +2
-   重复失败上传 +1
-   短时大量申请签名但不上传 +1

当分数超过阈值：

-   临时封禁该 IP/访客上传 24 小时；
-   或提升到更严格 Challenge（先 Managed，再 Under Attack）。

---

## 2. 5.3 缓存一致性：更新图片后的失效策略

> 核心原则：优先 `versioned key`，把 purge 当补刀，不把 purge 当主流程。

### 2.1 推荐主策略：Versioned Key（强推荐）

不要覆盖原对象（同 key 替换），改为新 key：

-   旧：`img/123/avatar.jpg`
-   新：`img/123/avatar_v2.jpg` 或 `img/123/avatar.jpg?v=2`（更推荐直接新文件名）

然后在元数据表中把“当前生效 key”指向新对象。

优点：

-   天然避免边缘陈旧缓存；
-   几乎不依赖 purge；
-   回滚简单（切回旧 key）。

### 2.2 缓存头建议

对不可变资源（带版本 key）：

-   `Cache-Control: public, max-age=31536000, immutable`

对“指针型接口”（比如 `GET /api/image/:id` 返回最新 key）：

-   `Cache-Control: no-store` 或很短 `max-age`（5~30 秒）

### 2.3 何时使用 Purge

仅在以下情况触发 Cloudflare Cache Purge：

1. 历史原因沿用了“同 key 覆盖”；
2. 出现严重错误资源，需紧急全网下线；
3. 配置 CORS/缓存规则变更后，确保行为一致。

实践建议：

-   优先 `purge by URL`，少用全量 purge；
-   记录 purge 事件（谁触发、原因、URL 列表、结果）。

### 2.4 数据一致性状态机（建议）

上传更新流程：

1. `pending_upload`（拿到 presigned URL）
2. `uploaded`（对象已在 R2）
3. `active`（元数据指向新 key）
4. `old_retained`（旧 key 延迟清理）
5. `old_deleted`（异步回收）

通过状态机可减少“前端看到新旧混乱”的窗口期。

---

## 3. 5.4 可观测性不足：免费层可落地的埋点与看板

> 目标：即使没有完整 APM，也能回答三件事——“有没有坏”“坏在哪里”“会不会超额”。

### 3.1 最低埋点集合（必须有）

为每个 API 请求记录结构化日志（JSON）：

-   `timestamp`
-   `request_id`
-   `route`
-   `user_id`（可匿名化）
-   `status_code`
-   `error_code`（业务错误码）
-   `latency_ms`
-   `r2_ops_a_count` / `r2_ops_b_count`（本次估算）
-   `bytes_in` / `bytes_out`

### 3.2 四类核心指标

1. **请求量**
    - `api.requests.total`
    - `api.requests.by_route`
2. **失败率**
    - `api.errors.total`
    - `api.error_rate = errors / total`
3. **R2 操作趋势**
    - `r2.class_a.daily`
    - `r2.class_b.daily`
    - `r2.storage.estimated_gb`
4. **风控命中率**
    - `upload.blocked.rate_limit`
    - `upload.blocked.mime`
    - `upload.blocked.quota`

### 3.3 免费层实现路径（MVP）

-   日志：优先 Workers Logs + 应用结构化日志。
-   聚合：每日定时任务（Cron Worker）汇总当日计数写入 D1/KV。
-   展示：管理后台一个“运营看板页”读取 D1 聚合结果。

可先做“日级别”聚合，不追求秒级监控。

### 3.4 告警阈值建议

-   `error_rate > 5%`（持续 5 分钟，Warning）或 `> 8%`（持续 5 分钟，Critical）
-   `r2.class_b.daily > 600,000`（Warning）或 `> 900,000`（Critical）
-   `workers.requests.daily > 90,000`（Warning）或 `> 98,000`（Critical，接近 Free 上限）
-   `upload.blocked.rate_limit` 突增 5 倍（Warning）或突增 8 倍（Critical，疑似攻击）

### 3.5 告警触发后的自动动作矩阵

> 目标：在高流量起步期，将“检测 → 防护 → 回退”标准化，减少人工介入延迟。

| 级别     | 触发条件（任一满足）        | 自动动作                                                           | `upload-url` 限速策略                      | 解除条件                                                |
| -------- | --------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------- |
| Normal   | 未命中 Warning/Critical     | 正常放行，保留基础 WAF 规则                                        | `300 req/min/IP` + `30/min/visitor`        | 持续观察                                                |
| Warning  | 命中 `3.4` 的 Warning 阈值  | 自动启用 `Managed Challenge`（仅上传入口与上传 API）               | 调降为 `180 req/min/IP` + `20/min/visitor` | 指标连续 30 分钟回落到 Warning 以下                     |
| Critical | 命中 `3.4` 的 Critical 阈值 | 自动切换 `Under Attack Mode`（优先上传相关路径，必要时扩展到全站） | 调降为 `60 req/min/IP` + `6/min/visitor`   | 指标连续 60 分钟低于 Warning，先降级到 Warning 档再观察 |

执行细则：

1. 动作优先级：`Critical > Warning > Normal`，高等级可覆盖低等级策略。
2. 防抖机制：同一等级动作 10 分钟内只执行一次，避免频繁抖动。
3. 渐进回退：`Critical -> Warning -> Normal`，不允许一步从 Critical 直接回到 Normal。
4. 人工兜底：若 `Under Attack Mode` 持续 2 小时仍未回落，触发人工介入并临时下调访客配额。

---

## 4. 5.5 分享防盗链需求：全公开前提下的限滥用策略

> 核心原则：全部图片公开时，无法做到“严格防盗链”，目标改为“降低滥用成本 + 控制峰值损耗”。

### 4.1 三种访问级别

1. **公开图（Public）**：唯一访问级别，所有图片可直链访问。
2. **访问入口分流（Page vs Direct）**：区分页面访问与大规模直链请求。
3. **风险流量分级处理**：正常放行、可疑 Challenge、异常限速/阻断。

### 4.2 推荐方案：公开直链 + 边缘防滥用

实现方式（适合免费层）：

1. 图片通过 `img.example.com/<key>` 公开提供。
2. 对图片域名配置 WAF 自定义规则与 Rate Limiting（按 IP/AS/UA）。
3. 对异常高频请求返回 Challenge 或限速，而不是直接回源 R2。
4. 利用缓存策略提升命中，降低 Class B 消耗。

说明：在“全部公开”的前提下，不再使用下载 token 作为主链路。

### 4.3 防盗链附加策略

-   对公开图域名启用基础反爬和速率限制。
-   可校验 `Referer` 作为弱校验（不可单独依赖，易被绕过）。
-   热门资源可加“按 IP/UA 的突发限流”。
-   对可疑流量启用 `Managed Challenge`；遭受攻击时临时启用 `Under Attack Mode`。

### 4.4 成本与体验平衡

-   全部公开会提升被外链概率，但能降低 Functions 中转成本。
-   建议：
    -   所有图片走公开缓存链路；
    -   重点通过边缘限速与挑战防刷；
    -   对热点资源单独规则保护（例如更严格速率阈值）。

### 4.5 关于“Cloudflare 转圈验证”的落地建议

你提到的“点开网站前 Cloudflare 转圈”通常对应 Challenge/Under Attack 机制。建议：

1. **默认态**：不全站强制转圈，避免正常用户体验受损。
2. **高风险路径常驻**：对上传相关路径启用 `Managed Challenge`。
3. **攻击态开关**：当监控命中阈值（如异常请求暴涨）时，临时开启 `Under Attack Mode`。
4. **恢复策略**：攻击缓解后降级为 Managed Challenge，避免长期高摩擦。

---

## 5. 建议落地顺序（两周内）

### 第 1 周（先稳）

1. 上线 `upload-url` 风控链路（匿名配额/白名单/大小/Turnstile）。
2. 图片 key 改为 versioned key 规范。
3. 接入结构化日志与日级聚合。

### 第 2 周（再强）

1. 对图片域名与上传路径配置 `Managed Challenge` + 速率规则。
2. 管理后台增加“用量 + 错误 + 风控命中”看板。
3. 增加异常阈值告警，并预设 `Under Attack Mode` 启停流程。

---

## 6. 验收清单（可直接对照）

-   [ ] 上传接口在匿名模式下可用，但受配额与挑战规则保护。
-   [ ] 超配额、超大小、非白名单类型均被拦截。
-   [ ] 同 key 覆盖路径已下线，改为 versioned key。
-   [ ] 图片更新后，用户 5 秒内能看到新版本。
-   [ ] 有日维度请求量、失败率、R2 A/B 趋势图。
-   [ ] 盗链/爬取峰值出现时，Challenge 或限流规则生效。
-   [ ] 攻击态可一键切换到 `Under Attack Mode` 并可回退。

---

## 7. 与主报告关系

本报告是主文档 `cloudflare-r2-pages-anime-image-feasibility.md` 中“第 5 节风险与约束”的深化版，覆盖：

-   5.2 滥用上传风险
-   5.3 缓存一致性
-   5.4 可观测性不足
-   5.5 分享防盗链需求

并按要求不展开 5.1 内容合规风险。
