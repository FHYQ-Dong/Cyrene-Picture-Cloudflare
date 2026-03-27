# v3 代码实现计划（不写代码）：缩略图 + 详情上下张 + 上传页样式深化

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-27
-   来源想法：`plan/0-idea-seed-backlog.md`（Idea-004 / Idea-005 / Idea-006）
-   前置文档：`code-plan-v1-core.md`、`code-plan-v2-ui.md`
-   目标：在保持现有匿名上传与风控约束不变的前提下，提升浏览性能与连续浏览体验，并完善上传页视觉反馈。

---

## 1. 本次范围

1. 上传页 CSS 专项优化（Idea-004）
    - 强化信息层级、状态反馈、响应式可读性。
2. 展示页使用缩略图优先加载（Idea-005）
    - 列表卡片默认加载缩略图，详情仍显示原图。
3. 详情页“上一张 / 下一张”导航（Idea-006）
    - 基于稳定顺序提供连续浏览路径。

---

## 2. 非目标

-   不引入账号体系与私有图片权限。
-   不改变配额、限流、Turnstile 校验逻辑。
-   不在 v3 引入复杂推荐算法或自动播放。

---

## 3. 设计原则

1. 向后兼容：
    - 老数据没有缩略图时可回退原图，不阻塞展示。
2. 可灰度：
    - 缩略图策略可通过配置开关启用/回退。
3. 低侵入：
    - 在 v2 结构上增量实现，不重构核心上传链路。

---

## 4. 数据模型与迁移计划

## 4.1 `images` 表增量字段

建议新增字段：

-   `thumb_object_key TEXT`：缩略图对象 key
-   `thumb_public_url TEXT`：缩略图可访问地址
-   `thumb_status TEXT NOT NULL DEFAULT 'none'`
    -   枚举：`none | pending | ready | failed`

建议索引：

-   `idx_images_thumb_status_created_at (thumb_status, created_at DESC)`

## 4.2 迁移策略

-   本阶段采用“直接重构”策略：删除现有数据库，按最新 `schema` 直接重建。
-   不再维护 v3 一次性增量迁移脚本。
-   重建后以全新数据结构为准，默认 `thumb_status='none'`。
-   数据导入（如需）走离线回灌，不在本次实现计划中处理旧库兼容。

---

## 5. 缩略图生成与存储策略

## 5.1 方案确定（采用 A）

### 方案 A：上传后异步生成（执行方案）

-   流程：`upload-complete` 记录任务 -> 后台 Worker/Queue 生成缩略图 -> 更新 DB。
-   采用原因：主上传链路稳定、前台延迟小、可独立扩展缩略图任务吞吐。
-   约束：需要异步任务组件（Queue/Worker）与失败重试机制。
-   执行口径：v3 仅按方案 A 落地，不在本阶段实现 B/C。

## 5.2 缩略图规格（v3 MVP）

-   宽度：`360px`（等比）
-   编码：`webp`（优先）
-   质量：`75~82`
-   命名：`thumb/{yyyy}/{mm}/{dd}/{image_id}.webp`

---

## 6. API 契约调整计划

## 6.1 `GET /api/list`

返回字段扩展：

-   `thumb_url`：优先给前端展示
-   `public_url`：原图地址（保留）
-   `thumb_status`

前端渲染规则：

-   `thumb_url` 存在且 `thumb_status='ready'` -> 用缩略图
-   否则回退 `public_url`

## 6.2 `GET /api/image/:id`

返回字段扩展：

-   `prev: { image_id, thumb_url } | null`
-   `next: { image_id, thumb_url } | null`
-   `uploader_nickname`（沿用 v2）

> 顺序规则：`created_at DESC, image_id DESC`。

---

## 7. 详情页上下张实现计划

## 7.1 交互

-   在详情图下方放置：`上一张`、`下一张` 按钮。
-   边界行为：
    -   无上一张时禁用上一张按钮。
    -   无下一张时禁用下一张按钮。

## 7.2 导航一致性

-   与列表同排序规则，防止用户感知错乱。
-   详情页 URL 仍保持 `image.html?id=...`。

---

## 8. 上传页 CSS 专项优化计划

## 8.1 视觉层级

-   上传者昵称输入、文件选择、Turnstile、上传按钮形成主流程区。
-   错误/成功提示统一色彩语义：
    -   错误：红系
    -   成功：绿系
    -   处理中：中性提示

## 8.2 可用性

-   按钮状态：`默认 / hover / disabled / loading`
-   字段提示：`maxlength`、默认昵称说明。
-   移动端：表单间距与点击区域最小尺寸优化。

## 8.3 可访问性

-   保证对比度
-   输入框 `label` 完整关联
-   状态信息可读文本化

---

## 9. 前端改造边界

建议涉及文件（规划层）：

-   展示页：`public/index.html`, `public/main.js`, `public/styles.css`
-   上传页：`public/upload.html`, `public/upload.js`, `public/styles.css`
-   详情页：`public/image.html`, `public/image.js`
-   主题配置：`public/site-config.js`

---

## 10. 配置项规划

新增可选配置（建议）：

-   `THUMBNAIL_ENABLED=true|false`
-   `THUMBNAIL_WIDTH=360`
-   `THUMBNAIL_FORMAT=webp`
-   `THUMBNAIL_QUALITY=80`

前端开关（可选）：

-   `USE_THUMBNAIL_IN_GALLERY=true|false`

---

## 11. 验收标准（DoD）

1. 展示页卡片优先加载缩略图，首屏明显更快。
2. 无缩略图时自动回退原图，不出现断图。
3. 详情页具备“上一张 / 下一张”按钮并可正确跳转。
4. 上传页样式优化后，核心状态反馈清晰。
5. 本地与线上模式均可运行（直传模式 / 预签名模式）。

---

## 12. 实施顺序（建议）

### Sprint A：数据与接口

-   完成 v3 迁移脚本
-   扩展 `list` / `image` 响应
-   预留缩略图状态字段

### Sprint B：前端渲染与导航

-   展示页接入 `thumb_url` 回退逻辑
-   详情页上下张按钮与禁用态

### Sprint C：上传页样式专项

-   表单视觉层级、状态反馈、移动端细节

### Sprint D：联调与验收

-   本地联调 + 线上验收
-   回归上传/展示/详情三条主链路

---

## 13. 风险与缓解

1. 缩略图任务积压导致延迟
    - 缓解：回退原图显示，异步重试。
2. 上下张顺序不稳定
    - 缓解：统一排序键，接口与前端一致。
3. 样式更新影响旧交互
    - 缓解：逐页面回归清单与截图比对。

---

## 14. 与想法池映射

-   `Idea-004` -> 上传页 CSS 专项优化
-   `Idea-005` -> 展示页缩略图优先
-   `Idea-006` -> 详情页上一张/下一张
