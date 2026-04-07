# v15 代码实现计划：媒体资源标签 (Tag) 系统支持

> 对应 Idea-016：实现图片和音频打 Tag (标签) 的功能。

## 1. 背景与目标

随着站点媒体资源（图片、音频等）数量的不断增加，单纯的“按上传者”或“按时间”浏览已经无法满足内容发现的需求。
为了增强内容的聚合性、可用性与搜索体验，需要引入细粒度的标签（Tag）系统。此举既可以方便管理员进行圈层和管控，也能让高频上传者/创作者对内容进行二次整理。

**MVP（最小可行性产品）目标**：

1. **上传时关联标签**：支持在单张/批量上传时输入或分配标签。
2. **存量编辑功能**：允许上传者自己或 Admin 为已经存在的媒体资源补充或修改标签。
3. **标签分类浏览**：列表页展示时包含标签信息，并支持点击特定标签筛选相关内容。
4. **热门标签榜单**：展示全站目前最高频使用的标签列表，便于导航。

---

## 2. 数据库变更 (Schema Changes)

利用 SQLite 关系型结构，我们采用专门的联结表（Junction Table）来保存资源的标签映射关系，而非将所有内容硬塞入 JSON 字段，以保证长期的查询性能和跨表统计分析的便捷。

追加以下 SQL：

```sql
-- 文件：infra/d1/migrate-v15-tag-system.sql

-- 1. 创建标签映射表（按媒体类型隔离命名空间）
CREATE TABLE IF NOT EXISTS item_tags (
   image_id TEXT NOT NULL,
   media_type TEXT NOT NULL,
   tag_name TEXT NOT NULL,
   created_at TEXT NOT NULL,
   PRIMARY KEY (image_id, media_type, tag_name),
   FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE
);

-- 2. 面向“按媒体类型 + 标签查询”的业务构建索引
CREATE INDEX IF NOT EXISTS idx_item_tags_media_tag_image ON item_tags(media_type, tag_name, image_id);
```

> **注意 1**：D1 默认不一定强校验 `PRAGMA foreign_keys = ON`，所以在后端删除逻辑（`soft delete` 或 Admin 硬删）中，需要配套清理或忽略这部分数据，保持数据一致性。
>
> **注意 2（新增）**：同名 Tag 在图片与音频中视为两个独立命名空间，必须通过 `media_type` 显式隔离，避免“图片 Tag 池”和“音频 Tag 池”串联。

---

## 3. 后端 API 扩展协议

### 3.1 上传链路支持传入 Tags

-   **受影响接口**：`POST /api/upload-batch/prepare` 或 `POST /api/upload-batch/complete`（根据元数据写入的具体时机）。
-   **参数变动**：接收可选的 `tags: string[]`（做长度限制，如每个 tag 最长 30 字符，最多单次 10 个 tag）。
-   **逻辑**：在插入 `images` 表成功后，同步向 `item_tags` 插入映射，并写入当前资源 `media_type`（`image` 或 `audio`）。

### 3.2 列表接口返回 Tags 与支持按 Tag 过滤

-   **接口**：`GET /api/images/list`
-   **入参扩展**：支持 `?tag=xxx` 查询参数，并与 `mediaType` 联动。
-   **返回体扩展**：在 `images` 对象数组的响应体中，每个项额外携带 `tags: ["anime", "landscape"]`。
-   **SQL 逻辑**：
    若携带 `tag` 参数：`JOIN item_tags t ON images.image_id = t.image_id WHERE t.media_type = images.media_type AND t.tag_name = ?`
    并在获取结果后，统一采用一条 `SELECT media_type, tag_name FROM item_tags WHERE image_id IN (...)` 聚合提取返回列表中的标签，避免 N+1 查询。
    同时，图片页仅请求 `mediaType=image` 的 Tag，音频页仅请求 `mediaType=audio` 的 Tag。

### 3.3 新增：修改已有项目标签

-   **接口**：`POST /api/images/tags`
-   **鉴权**：校验当前请求如果是普通端端直传用户，得校验他是不是原始 `uploader_nickname`，或者是具备 Token 的 Admin。
-   **参数**：`{ imageId: "xxx", tags: ["alpha", "beta"] }`
-   **逻辑**：此操作采取覆盖式（先 `DELETE FROM item_tags WHERE image_id = ? AND media_type = ?`，后批量 `INSERT`）。

### 3.4 新增：获取热门/全量标签

-   **接口**：`GET /api/tags/hot` (或 `/api/tags`)
-   **逻辑**：按 `mediaType` 分池统计，例如：
    `SELECT tag_name, COUNT(image_id) as count FROM item_tags WHERE media_type = ? GROUP BY tag_name ORDER BY count DESC LIMIT 100`。
    为前端 Tag 选择器和数据筛选提供聚合源；图片端与音频端互不混用。
    可以用内存级 KV 或 CDN 进行一定的短时缓存（比如 `Cache-Control: s-maxage=600`）。

### 3.5 清理逻辑补充

-   **Admin 删除功能**：在 `/api/admin/delete-image(s)` 中，一并执行 `DELETE FROM item_tags WHERE image_id IN (...)` 完成级联软物理删除。
-   **空标签自动清理（新增）**：当某个 `media_type + tag_name` 下不再存在任何 `status='active'` 资源时，自动删除该映射集合（或通过 `tags` 聚合表删除该标签条目），保证 Tag 列表无“空壳标签”。

### 3.6 标签回收策略（新增）

-   **触发时机**：

1. 资源删除（单删/批删/按 uploader 批删）后；
2. 资源标签被覆盖更新后。

-   **回收规则**：
-   对受影响的 `media_type + tag_name` 执行存在性检查；
-   若关联活跃资源数为 0，则从标签索引池中移除该 Tag；
-   图片与音频分别回收，互不影响。

---

## 4. 前端展示与交互改进

### 4.1 上传 UI (`public/upload.js` / HTML)

-   新增一个 **“全局标签”（Tag Selector）** 选择框组件：
    -   在组件初始化时，调用 `GET /api/tags/all` (或复用热门标签接口) 获取全站现有的标签列表并在下拉框中展示。
    -   用户可以在输入框中输入文字，如果输入的标签存在于列表中，则进行模糊匹配供用户选择；如果不存在，则允许用户直接按回车或顿号将其作为“新建标签”（Create New Tag）添加为小胶囊。
    -   在批量上传发起时，将选取的所有标签一并附加进 `prepare` 表单。

### 4.2 资源卡片展示 (`public/index.html` / `app.js`)- 在现有的图片卡片下方区域（或 Hover 查看信息区），渲染所属的 Tags 小标签。

-   小标签样式：半透明带圆角的 Badge，色调与卡片主色匹配。

### 4.3 标签过滤交互

-   在页面顶部的筛选工具栏中引入独立的 **“Tag 筛选器” (Dropdown / 自动完成选择器)** ：从 `/api/tags/hot` (或 `/api/tags`)获取已有标签构建选项。支持选择进行过滤，前端将选项值转为 `?tag=xxx` 追加到列表接口请求。
-   用户点击任意卡片展示上的 Tag 胶囊，也可自动联动触发页面级过滤（联动更新筛选工具栏选中的 Tag，并刷新列表）。
-   **媒体隔离（新增）**：图片页面仅展示图片 Tag 池；音频页面仅展示音频 Tag 池；同名 Tag 在两个页面独立出现、独立统计。

---

## 5. 预计开发拆解与步骤

1. **Phase 1: DB Schema & D1 存量更新**  
   编写并执行 `migrate-v15-tag-system.sql` 建表。
2. **Phase 2: 核心写逻辑**  
   修改后端 `upload-batch/complete.js` 以及补充独立的 `POST /api/images/tags` 覆盖编辑接口。
3. **Phase 3: 核心查逻辑**  
   修改 `GET /api/images/list` 支持按照 `mediaType + tag` 过滤，并支持一次性外挂 `tags` 数组返回。新增按 `mediaType` 分池的 `/api/tags/hot` 榜单接口。
4. **Phase 4: Admin API 完善级联删除**  
   更新 `delete-images.js`，包含对于 `item_tags` 的清理，并在删除后触发空标签回收。
5. **Phase 5: 前端 UI 对接**  
   在展示界面的 DOM 渲染中补充 Badge 展示，调整主过滤框，以及上传页的 Tag 输入栏；并确保图片/音频 Tag 选项隔离显示。

## 6. 风险及注意事项

-   **注入及字符控制**：严控单个 Tag 最大长度（如 32 字符），禁止插入不可见控制符，前后 trim，入库统一小写或限制格式以便检索。
-   **性能评估**：`item_tags` 表条目数会随着资源总量的线性倍数增加，需要确保基于 `tag_name` 再 JOIN `images` 的联合过滤能够走通索引避免全表扫描。
-   **缓存策略**：`hot tags` 查询不必每次击穿倒库，对接口加少许 CDN 短期缓存能够抵挡爬虫/重复首屏调用的消耗。
-   **一致性风险（新增）**：空标签回收应在同一事务或可补偿流程中执行，避免出现“资源已删但 Tag 暂未回收”的短暂不一致。
