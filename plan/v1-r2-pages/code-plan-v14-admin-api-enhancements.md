# v14 代码实现计划：完善 Admin API 后台管理接口（Idea-015）

-   **文档日期**：2026-03-30
-   **对应 Idea**：[Idea-015] 完善 Admin API 接口功能
-   **状态**：方案设计中（仅做计划，不写代码）

## 1. 背景与动机 (Background & Motivation)

当前系统已经具备了基础的管理员能力（例如图片单期/批量删除、尺寸回填、缩略图重试等位于 `functions/api/admin/` 下的接口）。然而，要让本系统能够稳健运用于长时间生产与多用户场景下，目前的后台能力依然存在短板：

1. **缺乏宏观统计**：系统管理员无法直观获悉当前占用的 R2 总容量、文件总数、按媒体类型分布的占比情况。
2. **缺乏垃圾回收 (GC)**：此前排查了并修复了“幽灵秒传”Bug，但系统中仍会累积那些被软删除或 `ref_count = 0` 且未在 R2 物理清理的对象。需要一个主动清理废弃数据的 API。
3. **缺乏上传者大盘管控**：对“谁（Uploader/IP）上传了多少资源”没有全局视图汇总。
4. **全量资源检索短板**：对已有文件的条件查询（按体积超大过滤、按特定时间段、孤儿数据排查）不支持。

## 2. 目标功能范围 (MVP Scope)

此次计划将新增或完善以下几类管理员核心 API：

### 2.1 统计看板大盘 (Dashboard Statistics API)

-   目的：供管理员监控存储资源占用状态。
-   功能点：
    -   计算全站有效文件总数 (D1 `images` count)。
    -   计算全站占用物理容量 (D1 `image_objects` size_bytes 累加)。
    -   分类统计媒体总数（如 `image:*` 与 `audio:*` 分类的数量）。

### 2.2 软删除垃圾回收 (R2 Garbage Collection API)

-   目的：释放 R2 存储空间并清理 D1 冗余哈希记录。
-   功能点：
    -   扫描 D1 数据库中满足 `ref_count <= 0` 的 `image_objects` 记录。
    -   对这部分对应的 R2 Object 进行物理请求清理（`R2Bucket.delete()`）。
    -   清理成功后，将对应的 D1 废弃记录作彻底删除，保持数据库纯净。

### 2.3 上传者视图分析 (Uploaders Overview API)

-   目的：观察活跃的上传来源（可联动处理防刷风控）。
-   功能点：
    -   按 `uploader` 分组统计：该特定上传者的所有上传数量、累计文件总大小分布、最后活跃时间。
    -   支持按文件数目或体积排序。

### 2.4 超级列表检索 (Admin-only Media List API)

-   目的：比常规 `GET /api/list` 更强权限的查询。
-   功能点：
    -   允许列出包括被封禁/软删除（如果有相关状态）的资源。
-   允许按物理容量大小 (`size_bytes`) `ORDER BY` 排列，找出“空间刺客”（超大图片/超长音频）。

### 2.5 增强条件批量删除能力 (Enhanced Conditional Delete API)

-   目的：面对恶意爬虫刷图或特定用户的违规上传，能快速进行清理阻断。
-   功能点：
    -   巩固按指定的多个 `image_id` 列表进行大批量的删除操作。
    -   新增支持按 `uploader` 字段“一键批量删除”某位特定用户的全部上传内容。

## 3. API 接口设计草案 (API Design Draft)

1. `GET /api/admin/stats`
    - **鉴权**：Admin Token
    - **返回结构**：
        ```json
        {
        	"total_records": 10240,
        	"total_size_bytes": 10737418240,
        	"media_types": { "image": 10000, "audio": 240 }
        }
        ```
2. `POST /api/admin/gc-objects`
    - **鉴权**：Admin Token
    - **流程**：查询 `SELECT object_key FROM image_objects WHERE ref_count <= 0 LIMIT 100`，逐一调用 R2 删除并 `DELETE` 表中对应数据。考虑到 Worker 时间限制，支持批量处理与分页（继续/完毕机制）。
3. `GET /api/admin/uploaders-stats`
    - **鉴权**：Admin Token
    - **返回结构**：
        ```json
        [
        	{
        		"uploader": "admin",
        		"count": 500,
        		"total_size_bytes": 524288000,
        		"last_upload": "..."
        	},
        	{
        		"uploader": "anonymous",
        		"count": 25,
        		"total_size_bytes": 1024000,
        		"last_upload": "..."
        	}
        ]
        ```
4. `GET /api/admin/media/large`（可选，可整合进超级列表）
    - **参数**：`limit=20`, `threshold_bytes=10485760` (默认大于 10MB)
5. `DELETE /api/admin/media/bulk`（增强批量删除接口）
    - **鉴权**：Admin Token
    - **参数结构 (JSON Payload)**：
        - 按 ID 批量：`{ "image_ids": ["uuid-1", "uuid-2"] }`
        - 按上传者批量：`{ "uploader": "spam_user" }`

## 4. 数据库分析 (Database Impact)

-   **表结构变更**：
    不需要修改现有的 D1 表的 schema。现有的 `images` 与 `image_objects` 字段已经足以支撑上述查询。
-   **性能与优化查询**：
    鉴于 SQLite 在 D1 的运行机制，如果表达到几十万行，全局 `COUNT` 与 `SUM(size_bytes)` 可能出现慢查询。
    _方案选择_：初阶 (MVP) 可直接执行实时统计，考虑到我们有 D1 规模预估说明，在几十万条数据以下查询消耗尚可容忍；若未来有更大规模要求，再考虑单独设计一张 `system_metrics` 聚合表用来维护实时数据。

## 5. 安全与中间件控制 (Security)

-   所有新增接口必须接入 `_shared/auth.js` 中的 `requireAdminToken()` 统一处理流程。
-   管理员 Token 需要能够防猜测，保持在环境变量 `ADMIN_TOKEN` 中配置。

## 6. 实施切面 (Implementation Steps)

-   **Step 1**：创建 `functions/api/admin/stats.js` 聚合分析接口。在内部通过 D1 执行简单的汇总查询聚合。
-   **Step 2**：创建 `functions/api/admin/uploaders-stats.js` 执行基于 `GROUP BY uploader` 操作的统计，返回所有用户/别名上传者的行为分布。
-   **Step 3**：实现被期待已久的清理工具 `functions/api/admin/gc-objects.js`，设计安全的批批清理和并发删除（Promise.allSettled 限制并控制在 5~10 的 R2 QPS 内）来逐步淘汰长期无引用的孤儿文件（Orphan objects），完善删除逻辑的闭环。
-   **Step 4**：重构或扩充现有删除脚本 (`functions/api/admin/delete-images.js`)，增加路由对 `{ "uploader": "..." }` Payload 参数的支持，实现一条 DB 命令软删该用户名下的全部 `images` 并降低对应物理 `image_objects` 的 `ref_count`。

## 7. 非范围内容 (Out of Scope)

-   不包含前端可视化后台管理界面的编写（UI 部分暂缺，可由开发者通过 Curl、Apifox 或 Postman 发起命令管理，或者未来单开一个 `/admin` 纯净静态页路由）。
-   不包含 IP 维度的直接封堵 (IP Ban API)。由于 Cloudflare WAF 对请求 IP 拦截更加高效，后端层只需暴露统计发现异常行为即可，由管理员到 Cloudflare Dashboard 封禁（配合手册指导）。
