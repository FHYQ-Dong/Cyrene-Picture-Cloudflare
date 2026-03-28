# v9-fixv6-detail-resolution-ratio（设计方案，不写代码）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-29
-   问题来源：v6 展示尺寸适配上线后，详情页仍出现“分辨率：未知”与图片显示比例异常
-   目标：修复详情页分辨率展示与缩放比例，确保新老数据都可正确显示

---

## 1. 问题定义

### 1.1 现象

1. 图片详情页经常显示：`分辨率：未知`。
2. 详情页图片在部分尺寸下出现“看起来被拉伸/不成比例”。

### 1.2 影响

-   用户无法获取真实像素信息，降低可信度。
-   详情页主图视觉失真，影响浏览体验。
-   v6“尺寸适配”价值未完整兑现。

---

## 2. 根因分析（基于当前代码）

## 2.1 分辨率未知的根因

-   `public/image.js` 仅根据 `data.width`/`data.height` 显示分辨率。
-   但上传主链路 `functions/api/upload-complete.js` 当前未写入 `width/height` 到 `images`。
-   `upsertImageMetadata` 支持写入 `width/height`，但调用方未提供，导致大量记录为空。

## 2.2 详情图不成比例的根因

-   当前 `.detail-image` 样式为：
    -   `width: 100%`
    -   `height: auto`
    -   `max-height: 78vh`
-   在某些高宽组合下，固定宽度 + 高度上限组合会引发布局压缩观感，表现为“比例不对”。
-   缺少更稳妥的“按容器自适应且保持原始比例”的展示策略（应以 `max-width/max-height` 约束，非强制铺满宽度）。

---

## 3. v9 修复目标（DoD）

1. 新上传图片：`images.width/height` 入库完整率接近 100%。
2. 历史图片：详情页不再长期显示“未知”（至少有前端回退兜底）。
3. 详情图：任意方向图片均保持原始比例，不出现拉伸。
4. 对现有接口兼容，不破坏 v5/v7/v8 主流程。

---

## 4. 修复方案总览

采用“三层修复”：

1. **源头修复（写库）**：上传时补齐宽高元数据。
2. **历史修复（回填）**：批量回填历史 `width/height`。
3. **展示兜底（前端）**：即使 DB 暂缺，也通过 `naturalWidth/naturalHeight` 临时展示真实分辨率并修正布局比例。

---

## 5. 详细设计

## 5.1 源头修复：上传链路补齐宽高

### 5.1.1 前端（推荐）

在 `public/upload.js` 构建 `completeItems` 时加入：

-   `width`
-   `height`

获取方式：

-   对每个 `File` 在浏览器端创建 `ImageBitmap` 或 `Image` 对象读取尺寸；
-   将尺寸缓存到任务项，最终随 `upload-batch/complete` 或单图 complete 一并提交。

优势：

-   服务端无额外对象下载成本；
-   对 R2 / Worker 计算压力最小。

### 5.1.2 后端

在 `functions/api/upload-complete.js`（及批量 complete 汇总路径）接收并校验：

-   `width > 0`
-   `height > 0`

然后传入 `upsertImageMetadata({ width, height, ... })`。

### 5.1.3 回退策略（可选增强）

若客户端未传或异常：

-   保持可上传（不阻断），但打日志 `missing_dimensions`；
-   交由异步回填任务补齐。

---

## 5.2 历史修复：宽高回填

### 5.2.1 新增管理员回填接口（建议）

新增：`POST /api/admin/backfill-dimensions`

入参建议：

-   `limit`（默认 50，最大 200）
-   `dryRun`（默认 true）
-   `onlyMissing=true`（默认）

行为：

1. 查询 `images` 中 `width IS NULL OR height IS NULL OR width <= 0 OR height <= 0` 的记录；
2. 逐项读取对象尺寸（实现可选：读取对象头 + 轻量解析 / 生成临时 URL 后在受控环境解析）；
3. 更新 `images.width/height/updated_at`；
4. 写审计日志到 `admin_action_logs`。

### 5.2.2 风险控制

-   dry-run 先看命中范围；
-   限速 + 每次小批处理，避免长时执行超时；
-   失败项返回明细，支持重试。

---

## 5.3 详情页展示修复

### 5.3.1 分辨率展示逻辑

在 `public/image.js` 改为三层优先级：

1. `data.width/data.height`（后端权威值）；
2. 图片加载后的 `preview.naturalWidth/naturalHeight`；
3. 都不可得时显示“未知”。

并在 `preview.onload` 后二次刷新详情信息。

### 5.3.2 比例展示逻辑

在 `.detail-image` 与容器样式改为：

-   `width: auto;`
-   `height: auto;`
-   `max-width: 100%;`
-   `max-height: 78vh;`
-   `display: block; margin: 0 auto;`

避免强制 `width:100%` 导致在高度受限场景下的压缩观感。

### 5.3.3 可选增强

-   在加载前用 `aspect_ratio` 占位，减少 CLS；
-   详情区域根据横/竖图切换布局时，优先用真实尺寸而不是仅靠后端可能为空的数据。

---

## 6. 接口与数据契约变更

## 6.1 `POST /api/upload-complete`

新增/确认支持字段：

-   `width`（number）
-   `height`（number）

## 6.2 `POST /api/upload-batch/complete`

`items[]` 新增字段：

-   `width`
-   `height`

## 6.3 `GET /api/image/:id`

保持兼容，继续返回：

-   `width`
-   `height`
-   `aspect_ratio`

---

## 7. 实施步骤（建议顺序）

1. **Step A**：先修前端详情页样式与分辨率回退显示（用户立即感知修复）。
2. **Step B**：补上传链路宽高写入（阻止新增脏数据）。
3. **Step C**：上线管理员回填接口并执行历史回填。
4. **Step D**：回归验证 + 指标观察。

---

## 8. 验收与回归清单

## 8.1 功能验收

1. 新上传图片详情可显示真实 `width × height`。
2. 历史缺失记录在回填后可显示真实分辨率。
3. 横图/竖图/方图/超长图在详情页均无拉伸。

## 8.2 回归点

-   列表页卡片加载不受影响；
-   详情页前后翻页不受影响；
-   v8 管理接口鉴权/限速/审计不受影响。

## 8.3 观测指标

-   `width/height` 缺失率：

```sql
SELECT
  SUM(CASE WHEN width IS NULL OR height IS NULL OR width<=0 OR height<=0 THEN 1 ELSE 0 END) AS missing_cnt,
  COUNT(*) AS total_cnt
FROM images;
```

-   详情页前端错误日志中“dimension unknown”占比。

---

## 9. 风险与缓解

1. **前端读取尺寸失败（极少数格式/损坏文件）**
    - 缓解：不阻断上传，标记待回填。
2. **回填任务耗时过长**
    - 缓解：分批执行 + 限速 + 可重入。
3. **样式修复引发布局抖动**
    - 缓解：先上占位比例策略，增加视觉回归样例集。

---

## 10. 结论

v9 重点不是新增功能，而是“补齐 v6 的数据闭环与展示闭环”：

-   源头补数据（上传写宽高）
-   存量做回填（管理员批量）
-   前端加兜底（自然尺寸 + 比例安全样式）

这样可同时解决“分辨率未知”和“详情图比例异常”两类问题。
