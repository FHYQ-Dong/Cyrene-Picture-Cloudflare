# Cloudflare 仪表盘点选操作清单（可直接照着点）

-   日期：2026-03-26
-   目标：把 `5-risk-control-cache-observability-anti-hotlink.md` 中的 `3.4` 与 `3.5` 方案落到 Cloudflare Dashboard。
-   适用：`Pages + Pages Functions + R2`，匿名上传、全公开图片。

## 0. 开始前检查

1. 登录 Cloudflare Dashboard，进入你的站点（Zone）。
2. 确认已有两个域名入口（推荐）：
    - 主站：`www.example.com`（Pages）
    - 图片域：`img.example.com`（R2 Custom Domain）
3. 确认上传 API 路径（示例）：
    - `POST /api/upload-url`
    - `POST /api/upload-complete`

> 如果你的菜单名称与本文略有差异，优先按关键词搜索：`WAF`、`Rate Limiting`、`Under Attack Mode`、`Turnstile`。

---

## 1. 基础模式（Normal）配置

### 1.1 新建 WAF 自定义规则（上传路径）

路径：`Security` -> `WAF` -> `Custom rules` -> `Create rule`

规则名：`upload-path-baseline`

表达式示例：

```text
(http.request.uri.path eq "/api/upload-url" and http.request.method eq "POST")
or
(http.request.uri.path eq "/api/upload-complete" and http.request.method eq "POST")
```

动作：`Managed Challenge`（建议先 `Log` 观察 10~30 分钟，再切挑战）

保存并部署。

### 1.2 新建 WAF 自定义规则（图片域异常 UA 可疑）

路径：`Security` -> `WAF` -> `Custom rules` -> `Create rule`

规则名：`img-suspicious-ua`

表达式（示例，按需调整）：

```text
http.host eq "img.example.com"
and
(http.user_agent eq "" or lower(http.user_agent) contains "python-requests")
```

动作：`Managed Challenge`

保存并部署。

### 1.3 配置 `upload-url` 的 Rate Limiting（Normal 档）

路径：`Security` -> `WAF` -> `Rate limiting rules` -> `Create rule`

-   规则名：`rl-upload-url-normal`
-   匹配：

```text
http.request.uri.path eq "/api/upload-url" and http.request.method eq "POST"
```

-   统计维度：`IP`（若支持可叠加 JA3/ASN）
-   阈值：`300 requests / 1 minute`
-   动作：`Managed Challenge`（或 `Block 1 min`，取决于你想要的严格度）

保存并部署。

### 1.4 Turnstile（应用层）

路径：`Turnstile` -> `Add widget`

1. 创建站点小组件，拿到 `site key` 与 `secret key`。
2. 前端上传按钮提交 Turnstile token。
3. 后端 `POST /api/upload-url` 中验证 token，失败直接拒绝签名 URL。

---

## 2. Warning 档自动动作（对应 3.5）

目标：触发 Warning 时执行以下动作。

### 2.1 切换上传路径挑战为强制挑战

路径：`Security` -> `WAF` -> `Custom rules`

-   将 `upload-path-baseline` 动作改为 `Managed Challenge`（若此前为 Log）。
-   如已是 Challenge，则保持不变并记录触发时间。

### 2.2 调整 Rate Limiting 为 Warning 档

路径：`Security` -> `WAF` -> `Rate limiting rules`

-   编辑 `rl-upload-url-normal`
-   阈值改为：`180 requests / 1 minute / IP`
-   动作改为：`Managed Challenge`

### 2.3 运营记录

在你的运维文档中记录：

-   告警触发时间
-   触发指标（`error_rate` / `r2.class_b.daily` / `workers.requests.daily` / `upload.blocked.rate_limit`）
-   已执行动作

---

## 3. Critical 档自动动作（对应 3.5）

目标：触发 Critical 时进入强保护状态。

### 3.1 启用 Under Attack Mode

路径：`Security` -> `Settings` -> `Security Level`

-   切换为 `Under Attack`（或启用等价开关）
-   若支持按路径/规则启用，优先先覆盖上传路径与图片域

> 部分账号/套餐界面可能略有差异；若看不到入口，可在 `Security` 页内搜索 `Under Attack`。

### 3.2 调整 `upload-url` 速率到 Critical 档

路径：`Security` -> `WAF` -> `Rate limiting rules`

-   编辑 `rl-upload-url-normal`
-   阈值改为：`60 requests / 1 minute / IP`
-   动作：`Managed Challenge` 或 `Block 1~5 min`

### 3.3 临时加固图片域（可选）

新增规则：`rl-img-hotlink-critical`

匹配示例：

```text
http.host eq "img.example.com"
```

建议阈值（起步）：`1200 requests / 1 minute / IP`

动作：`Managed Challenge`

---

## 4. 回退流程（Critical -> Warning -> Normal）

### 4.1 从 Critical 回退到 Warning

条件：指标连续 60 分钟低于 Warning 线。

动作：

1. `Under Attack` 关闭。
2. `upload-url` 速率恢复到 Warning 档：`180 req/min/IP`。
3. 上传路径继续保留 `Managed Challenge`。

### 4.2 从 Warning 回退到 Normal

条件：指标连续 30 分钟低于 Warning 线。

动作：

1. `upload-url` 速率恢复到 Normal 档：`300 req/min/IP`。
2. 上传路径挑战可降级为 `Log`（如果你希望降低摩擦）。
3. 保留 Turnstile，不建议关闭。

---

## 5. 推荐的最终规则清单（最小闭环）

-   `upload-path-baseline`（Custom Rule，上传路径）
-   `img-suspicious-ua`（Custom Rule，图片域可疑 UA）
-   `rl-upload-url-normal`（Rate Limiting，上传 API）
-   `rl-img-hotlink-critical`（Rate Limiting，图片域 Critical 临时规则）
-   Turnstile widget（前端）+ 服务端校验

---

## 6. 自检清单（上线当天）

-   [ ] 正常用户可上传，不会被频繁挑战。
-   [ ] 压测到 `300 req/min/IP` 附近时出现 Managed Challenge。
-   [ ] 手动切到 Critical 时，`Under Attack` 能生效。
-   [ ] 回退流程可按 `Critical -> Warning -> Normal` 执行。
-   [ ] 运维日志记录了每次切换动作与触发指标。

---

## 7. 与风险文档对应关系

-   本清单对应：`plan/5-risk-control-cache-observability-anti-hotlink.md`
-   主要落实章节：
    -   `3.4 告警阈值建议`
    -   `3.5 告警触发后的自动动作矩阵`
