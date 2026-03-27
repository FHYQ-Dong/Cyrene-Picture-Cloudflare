# v1 实施计划（无代码版）

-   版本范围：`plan/v1-r2-pages` 全部文档
-   计划日期：2026-03-26
-   目标：在 Cloudflare 免费层下，落地“匿名可上传、图片全公开、可观测、可控风控”的二次元图片站 MVP。

## 1. 范围与约束

### 1.1 范围（In Scope）

1. 前端站点：`Pages` 承载上传、列表、详情、分享页。
2. 后端轻 API：`Pages Functions` 提供
    - `POST /api/upload-url`
    - `POST /api/upload-complete`
    - `GET /api/list`
3. 对象存储：`R2` 存储原图（可后续补缩略图策略）。
4. 公网访问：`R2 Custom Domain` + Cloudflare 缓存。
5. 安全与风控：Challenge / Turnstile / WAF / Rate Limiting。
6. 观测与告警：请求量、失败率、R2 A/B 趋势、风控命中。

### 1.2 约束（必须遵守）

1. 无登录鉴权，所有访客可上传。
2. 全部图片公开可访问。
3. 上传主链路必须为 `Presigned URL` 直传（不走后端大文件中转）。
4. 按 `v1` 当前阈值执行：
    - 访客：`500 张/日`、`2GB/日`
    - 同 IP：`1,500 张/日`、`6GB/日`
    - 全站：`10,000 张/日`、`40GB/日`
    - 单文件上限：`200MB`
5. 速率限制基线：`300 req/min/IP`（Normal 档）。

---

## 2. 里程碑总览

### M0：环境与账号就绪（D0）

**目标**：完成 Cloudflare 资源与域名基础配置。  
**交付物**：可访问的 Pages 项目、R2 Bucket、Custom Domain、基础 DNS。

### M1：MVP 主链路可用（D1-D3）

**目标**：打通上传、保存、展示、分享全链路。  
**交付物**：用户可上传并看到图片，分享链接可访问。

### M2：风控与防滥用（D3-D5）

**目标**：按 `5-risk-control...` 与 `6-click-runbook` 生效规则。  
**交付物**：WAF/Rate Limiting/Turnstile/Challenge 生效，具备 Normal/Warning/Critical 档位切换能力。

### M3：观测与告警（D5-D7）

**目标**：可看见系统健康与资源消耗趋势。  
**交付物**：日级聚合指标、告警阈值、自动动作矩阵可执行。

### M4：稳定性与发布验收（D7-D10）

**目标**：完成上线前压测、回退方案、运行手册。  
**交付物**：验收清单通过，具备生产可运营状态。

---

## 3. 分阶段任务清单

## 阶段 A：基础资源配置（M0）

1. 创建/确认 `R2` Bucket 与公开读访问策略（仅业务要求内开放）。
2. 绑定 `R2 Custom Domain`（示例：`img.example.com`）。
3. 创建 Pages 项目并配置 Functions。
4. 配置 Bucket CORS（支持浏览器 PUT/GET 及必要头）。
5. 建立最小目录与对象命名约定：`public/{yyyy}/{mm}/{dd}/{uuid}.{ext}`。

**验收标准**

-   `img.example.com` 可访问示例对象。
-   浏览器跨域上传预检通过。

## 阶段 B：MVP 业务链路（M1）

1. 上传前端流程：选择文件 -> 请求 `upload-url` -> 直传 R2 -> 回调 `upload-complete`。
2. 图片列表与详情页：基于元数据展示公开图片。
3. 分享页：公开访问，不做私密鉴权。
4. 错误码规范：`UPLOAD_SIZE_EXCEEDED` 等关键错误统一。

**验收标准**

-   单图上传成功率 >= 95%（正常网络下）。
-   上传完成后可在列表页看到图片。
-   分享页外网可稳定访问。

## 阶段 C：风控与挑战机制（M2）

1. 按文档配置上传配额（日维度 visitor / IP / global）。
2. 启用 MIME 白名单与上传后二次校验。
3. 设置单文件上限 `200MB`，并对大文件提示分片上传策略。
4. 落地四层限制：WAF / Challenge / Turnstile / 应用层限流。
5. 执行 `3.5` 自动动作矩阵：Normal/Warning/Critical 档位。

**验收标准**

-   非白名单 MIME 被拒绝。
-   超配额/超限速请求被拦截。
-   Warning 与 Critical 动作能按阈值触发并可回退。

## 阶段 D：缓存一致性（M2-M3 并行）

1. 采用 `versioned key` 更新策略，不使用同 key 覆盖。
2. 设置缓存头：
    - 资源对象：`public, max-age=31536000, immutable`
    - 指针接口：`no-store` 或短 TTL
3. 仅在必要场景使用 purge（优先 URL 级）。

**验收标准**

-   图片更新后 5 秒内用户可见新版本。
-   无大面积旧缓存污染。

## 阶段 E：观测、告警、运营（M3）

1. 结构化日志字段落地：`request_id`、`error_code`、`latency_ms`、`r2_ops_*` 等。
2. 日级聚合：汇总请求量、错误率、R2 A/B 趋势、风控命中率。
3. 告警阈值按高流量版执行：
    - `error_rate`: `>5%` Warning / `>8%` Critical
    - `r2.class_b.daily`: `>600k` Warning / `>900k` Critical
    - `workers.requests.daily`: `>90k` Warning / `>98k` Critical
    - `upload.blocked.rate_limit`: `5x` Warning / `8x` Critical
4. 自动动作矩阵执行与记录（含防抖、渐进回退、人工兜底）。

**验收标准**

-   可查看 24h 指标趋势。
-   告警触发后 10 分钟内动作生效。

## 阶段 F：发布与演练（M4）

1. 压测上传 API 与图片访问热点路径。
2. 进行攻击态演练：手动切 Warning/Critical 并回退。
3. 完成运行手册：值班流程、阈值调整流程、故障排查入口。
4. 确认数据备份与恢复流程。

**验收标准**

-   回退流程 `Critical -> Warning -> Normal` 可执行。
-   上线当天自检清单全部通过。

---

## 4. 角色与分工（建议）

1. **平台/运维**：Cloudflare 资源、WAF/Rate Limiting、告警动作矩阵。
2. **后端**：上传签名、配额校验、元数据管理、日志结构化。
3. **前端**：上传交互、失败重试、列表详情分享页。
4. **产品/运营**：阈值策略、活动高峰预案、异常处置流程。

---

## 5. 风险与应对（执行视角）

1. **免费层逼近上限**
    - 应对：优先提升缓存命中；必要时降低上传配额与限速阈值。
2. **误伤正常用户**
    - 应对：Challenge 分层开启，先 Log 后强拦截；保留灰度窗口。
3. **高峰上传失败率上升**
    - 应对：建议 `>100MB` 文件使用分片；前端加可恢复重试。
4. **缓存更新不一致**
    - 应对：坚持 versioned key，不把 purge 当主流程。

---

## 6. 发布门槛（Go / No-Go）

满足以下全部条件才进入正式发布：

1. 上传/展示/分享主链路可用。
2. 配额、MIME、大小限制、限流策略全部生效。
3. 监控看板可看到核心 4 类指标。
4. Warning/Critical 自动动作演练通过。
5. 自检清单（`6-cloudflare-dashboard-click-runbook.md`）通过。

---

## 7. 与 v1 文档映射

-   总体可行性与架构：`cloudflare-r2-pages-anime-image-feasibility.md`
-   风控/缓存/观测/防滥用：`5-risk-control-cache-observability-anti-hotlink.md`
-   Cloudflare 仪表盘配置步骤：`6-cloudflare-dashboard-click-runbook.md`
