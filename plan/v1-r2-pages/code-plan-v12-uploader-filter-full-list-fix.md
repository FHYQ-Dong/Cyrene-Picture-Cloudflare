# v12 代码实现计划（不写代码）：修复展示页“上传者筛选下拉不完整”问题（承接 Idea-014）

-   适用版本：`plan/v1-r2-pages`
-   文档日期：2026-03-29
-   来源想法：`plan/0-idea-seed-backlog.md`（Idea-014）
-   目标：首次进入展示页时，“上传者筛选”下拉即可显示完整上传者集合，不再依赖点击“加载更多”。

---

## 1. 问题定义

## 1.1 现象

在展示页（`public/main.js`）中：

1. 首次加载列表后点击“上传者筛选”，仅看到当前页（默认 20 条）中出现过的上传者；
2. 点击“加载更多”后，下拉才逐步出现更多上传者；
3. 用户会误以为某些上传者不存在。

## 1.2 当前根因（已确认）

当前 `refreshUploaderFilter(items)` 的数据源来自 `/api/list` 返回的 `data.items`，它只代表当前分页结果，不是全局上传者列表。  
因此下拉选项被“分页加载进度”绑定，导致首次不完整。

---

## 2. 设计目标（DoD）

1. 首次进入页面即能看到全量上传者（至少是可筛选范围内的完整集合）。
2. 下拉选项数据源与列表分页解耦，“加载更多”不再影响选项完整性。
3. 在上传者数量较大时保持可接受的加载性能与交互响应。
4. 不破坏现有 `/api/list` 分页、分组（`groupBy`）与筛选行为。

---

## 3. 方案总览

采用“**独立上传者列表接口 + 前端初始化并缓存**”方案：

1. 新增 `GET /api/uploaders` 接口，返回去重后的上传者昵称列表；
2. 页面初始化时并行请求：
    - `/api/list?...`（首屏图片）
    - `/api/uploaders`（下拉数据）
3. `uploaderFilter` 下拉由 `/api/uploaders` 全量数据构建；
4. 列表分页（`load more`）不再调用 `refreshUploaderFilter(data.items)` 去“增量拼接选项”。

---

## 4. 后端改造设计

## 4.1 新增 DB 查询方法

建议在 `functions/_shared/db.js` 新增：

-   `listDistinctUploaders(db, limit = 500, cursorNickname = null)`

查询建议（D1）：

-   仅统计 `status='active'`；
-   `SELECT uploader_nickname FROM images GROUP BY uploader_nickname` 或 `SELECT DISTINCT uploader_nickname`；
-   排序建议：按昵称字典序（稳定、可分页）。

> 说明：若后续希望按“最近活跃度”排序，可额外返回 `latest_created_at` 并改排序策略，但 v12 MVP 先保守。

## 4.2 新增 API 路由

新增 `functions/api/uploaders.js`（`onRequestGet`）：

-   入参（可选）：
    -   `limit`（默认 200，最大 1000）
    -   `cursor`（昵称游标，可选）
-   返回：
    -   `items: [{ nickname: "xxx" }]`
    -   `nextCursor: string|null`

错误码复用：

-   `INVALID_REQUEST`
-   `INTERNAL_ERROR`

---

## 5. 前端改造设计

目标文件：`public/main.js`

## 5.1 下拉数据源解耦

新增方法：

-   `fetchUploaders()`：请求 `/api/uploaders`，构建完整下拉选项；
-   `setUploaderFilterOptions(uploaders)`：一次性重建 `uploaderFilter`（保留“全部上传者”默认项）。

调整：

-   移除（或停用）`refreshUploaderFilter(data.items)` 在分页流程中的调用；
-   `loadMore` 仅负责列表内容，不修改筛选选项。

## 5.2 初始化流程

页面初始化阶段改为：

1. 先创建 custom-select 组件；
2. 并行执行：`fetchUploaders()` 与 `fetchList({ append:false })`；
3. 当上传者列表返回后，重建下拉并触发 custom-select `rebuild()`。

## 5.3 回退策略

若 `/api/uploaders` 请求失败：

-   不阻塞列表展示；
-   下拉至少保留“全部上传者”；
-   可显示轻量提示（控制台 warn 或页面非阻断提示）。

---

## 6. 兼容性与性能

1. **数据量控制**：
    - MVP 默认为最多 200~500 个昵称（站点当前规模足够）；
    - 超过上限时开启 cursor 分页加载（可后续增强）。
2. **缓存策略**：
    - 可对 `/api/uploaders` 添加短期缓存（如 `cache-control: max-age=60`）；
    - 由于昵称变化频率低，短缓存通常可接受。
3. **默认昵称处理**：
    - 保留 `093` 等默认昵称在列表中参与去重。

---

## 7. 测试计划

## 7.1 后端测试

新增 `tests/api-uploaders.test.js`：

1. 返回去重昵称集合；
2. 仅返回 `active` 图片对应昵称；
3. `limit/cursor` 参数生效；
4. 空数据时返回空数组。

## 7.2 前端行为验证（手工）

1. 首次打开页面，不点击“加载更多”，下拉应包含全量上传者；
2. 点击“加载更多”前后，下拉选项集合不应因分页而“新增”；
3. 选择任一上传者筛选，列表结果正确；
4. `/api/uploaders` 故障时，页面列表仍可加载。

---

## 8. 发布策略

1. 先上线后端 `/api/uploaders` 接口与测试；
2. 再上线前端解耦改造；
3. 线上验收：
    - 首屏下拉完整性；
    - 筛选准确性；
    - 分页与筛选组合行为。

---

## 9. 完成定义（DoD）

1. 首屏下拉可见完整上传者列表；
2. “加载更多”不再影响下拉选项完整性；
3. 现有列表分页、筛选、分组无回归；
4. 新增测试通过并完成线上手工验收。
