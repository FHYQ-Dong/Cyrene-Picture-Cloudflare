# 调试与开发经验沉淀 (Debug Lessons)

本文档用于记录项目开发过程中遇到的经典问题、Root Cause（根本原因）深度分析以及解决方案，作为后续开发的避坑指南。

## 1. 幽灵秒传现象 (Ghost Deduplication Bug)

**日期**: 2026-03-30
**模块**: 哈希秒传 (Hash Deduplication) / 批量上传

### 1.1 表现症状 (Symptom)

用户在通过批量上传大批图片（例如 500+ 张）后，部分图片上传接口虽然返回 `200 Success` 并且提示为 `dedup_hit: true`（秒传命中），但进入图片列表和详情页后，发现缩略图和原图全部 404（图片无法显示）。
使用 `wrangler d1 execute` 检查数据库发现，数据库中存在对这些 R2 object 的引用，但是实际的 R2 Bucket 中该 object 不存在。

### 1.2 根本原因 (Root Cause)

系统实现了基于 `sha256` 结合 `size` 的文件去重秒传机制。该机制的逻辑漏洞在于：**未能正确处理被删除文件残留的 Hash 记录**。
具体触发路径如下：

1. **初次上传**：文件 A 被上传成功。D1 数据库 `image_objects` 表记录了它的 hash 和对象路径，此时 `ref_count = 1`。R2 中存在物理文件。
2. **发生删除**：管理员删除了这张图片，`ref_count` 递减为 0。为了节省存储空间，R2 的物理文件被删除。但是为了某些历史日志追踪（或是其他软删除原因），`image_objects` 表中 `ref_count = 0` 的废弃记录和它的 `content_hash` 并未被删除。
3. **幽灵秒传**：用户在将来某天（如批量上传时）再次上传**相同**内容的文件 A。
    - `upload-hash/check.js` 检查数据库，发现该 hash 存在，它直接认为**物理文件还在**，返回给客户端“秒传命中”。
    - 客户端跳过物理文件流的上传。
    - `upload-complete.js` 直接在引用表增加新的 `images` 记录，并引用之前的 `object_key`。
    - **结果**：产生了一个僵尸引用，新记录指向了一个早就被物理删除的 R2 对象，导致后续 404。

### 1.3 修复方案 (Solution)

**第一步：API 层阻断假秒传**
在哈希检查和结算接口中，引入 `ref_count` 状态进行双重校验：只有在 `ref_count > 0` 的情况下，才认可这是一次真正的“秒传命中”。
修改前：

```javascript
const object = await db.prepare(`SELECT * FROM image_objects WHERE content_hash = ?1 AND size_bytes = ?2`).bind(hash, size).first();
if (object) { ... hit ... }
```

修改后 (`functions/api/upload-hash/check.js`):

```javascript
if (object && Number(object.ref_count) > 0) { ... hit ... }
```

**第二步：DB 层覆盖“死记录” (SQLite ON CONFLICT 高级运用)**
当被判定为非秒传（因为 `ref_count <= 0`），客户端会进入完整的物理文件直传流程。在物理上传完毕并写入数据库时，我们需要更新已存在的无用 Hash 的记录行，将其复活：
修改前 (`functions/_shared/db.js`):

```sql
INSERT INTO image_objects (...) VALUES (...)
ON CONFLICT (content_hash) DO UPDATE SET ref_count = ref_count + 1
```

修改后 (`createOrReuseImageObject` 函数):

```sql
INSERT INTO image_objects (content_hash, size_bytes, object_key, mime_type, r2_etag, ref_count, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
ON CONFLICT(content_hash) DO UPDATE SET
  ref_count = ref_count + 1,
  object_key = CASE WHEN image_objects.ref_count <= 0 THEN excluded.object_key ELSE image_objects.object_key END,
  size_bytes = CASE WHEN image_objects.ref_count <= 0 THEN excluded.size_bytes ELSE image_objects.size_bytes END,
  mime_type = CASE WHEN image_objects.ref_count <= 0 THEN excluded.mime_type ELSE image_objects.mime_type END,
  r2_etag = CASE WHEN image_objects.ref_count <= 0 THEN excluded.r2_etag ELSE image_objects.r2_etag END,
  created_at = CASE WHEN image_objects.ref_count <= 0 THEN excluded.created_at ELSE image_objects.created_at END
RETURNING *
```

通过引入 `CASE WHEN`，使得当 `ON CONFLICT` 触发冲突时：
如果原记录已经是死的 (`ref_count <= 0`)，我们就用刚刚长传产生的新物理路径 `excluded.object_key` 等字段覆盖原有的死数据。
如果记录还活着，那么单纯进行 `ref_count = ref_count + 1`，复用老图片。

### 1.4 经验总结 (Lesson Learned)

1. **状态一致性**：不要仅以主键、唯一约束或 Hash 的“存在性”来代表物理资产的“可用性”。在实现去重打通（Deduplication）时，必须要耦合校验存储的生命周期状态（例如 `ref_count > 0`、`deleted_at IS NULL`）。
2. **软删除陷阱**：在带有软删除思想或使用计数引用的架构中，重新写入相同唯一值数据的情况时常发生（重新注册重名用户、重新上传同名文件）。如果不通过 `ON CONFLICT ... UPDATE` 进行数据“脏覆盖（打脸复活）”，非常容易引发由于 Unique Constraint 导致的写入失败或者由于复用假数据造成业务灾难。

## 2. D1 远程调试经验

遇到怪异问题时，可以立刻通过 `wrangler` 接入远程正式库进行抽样检查：

```bash
npx wrangler d1 execute cyrene_meta --remote --command "SELECT * FROM images WHERE image_id = 'xxx'"
npx wrangler d1 execute cyrene_meta --remote --command "SELECT * FROM image_objects WHERE object_key = 'xxx'"
```

能够极快地厘清前台页面报错的症结（例如，判断是网络阻断还是数据链路关联错误）。
