# v16 代码实现计划：上传链路性能优化（prepare + 元数据写入）

> 目标：解决“申请上传慢”和“写入元数据慢”两类核心性能问题，在不改变现有业务语义（配额、风控、鉴权、标签、缩略图）的前提下，显著降低上传阶段总耗时。

---

## 1. 背景与问题定义

当前大批量上传（如 500 张）时，用户体感慢主要来自两段：

1. `POST /api/upload-batch/prepare`（申请上传）
2. `POST /api/upload-batch/complete`（写入元数据）

### 1.1 prepare 慢的根因

-   现状为“按文件逐条查写”限流与配额：每个 item 都会触发多次 D1 读写。
-   每批最多 50 条，仍会产生大量 DB RTT。
-   当前未统一返回服务端阶段耗时，前端难以区分“慢在哈希”还是“慢在申请”。

### 1.2 complete 慢的根因

-   `upload-batch/complete` 对每个文件串行 `await completeSingleUpload(...)`，无并发。
-   单文件 `upload-complete` 链路内部步骤较多（token、查重、对象复用、事件写入、images 写入、tags 写入）。
-   单图典型 DB 往返约 $8\sim12$ 次（标签越多越高），500 张总往返巨大。

---

## 2. v16 总体目标（KPI）

### 2.1 用户体感目标

-   批量上传 500 张时：
    -   `prepare` 阶段总耗时下降 **40%+**。
    -   `complete` 阶段总耗时下降 **50%+**（取决于并发度与 DB 负载）。

### 2.2 服务端目标

-   `prepare` 单批 D1 请求数显著下降（目标下降 60% 以上）。
-   `complete` 不改变结果正确性的前提下，将批处理串行改为受控并发。

### 2.3 可观测性目标

-   前端可显示并区分阶段耗时：`hash-checking` / `prepare` / `complete`。
-   后端返回统一 perf 字段并带 requestId 便于排障。

---

## 3. 方案 A：prepare 根治优化（代码层）

## 3.1 改造原则

-   保持现有业务语义不变：
    -   配额仍按“每文件”消耗；
    -   限流阈值与 scope（visitor/ip/global）不变；
    -   拒绝原因、错误码、rejectedItems 结构保持兼容。
-   重点优化 DB 访问模式：从“逐文件散查散写”改为“批次聚合 + 批量写入”。

## 3.2 数据访问优化设计

### 3.2.1 限流（分钟级）

当前：每文件 `incrementMinuteCounter` 两次（visitor/ip），并且 each run 后再 select。

优化：

1. 先读取当前分钟 visitor/ip 计数（各 1 次）。
2. 在内存里按本批次逐项模拟增量，判定哪些 item 超限（保持逐项语义一致）。
3. 将本批实际通过数量一次性回写（visitor/ip 各 1 次），使用 `env.DB.batch()` 合并。

### 3.2.2 配额（日级）

当前：每文件都 `checkAndConsumeQuotas`，导致多次 select+upsert。

优化：

1. 预读当天 `visitor/ip/global` 三条 quota 行（最多 3 次读）。
2. 在内存中按 item 顺序模拟 count/bytes 递增，得出 accept/reject。
3. 仅对最终增量做一次聚合写回（visitor/ip/global 各 1 次 upsert），并通过 `env.DB.batch()` 提交。

> 保序说明：以原 items 顺序做模拟，可保持“前面通过、后面被拒”的语义一致。

### 3.2.3 Token 记录写入（prepare 阶段）

-   对 `UPLOAD_COMPLETE_REQUIRE_TOKEN=true` 场景：
    -   继续按每个 accepted item 生成 token；
    -   但 DB 插入 `upload_tokens` 采用 `env.DB.batch()` 合并写入，减少 RTT。

## 3.3 API 响应增强（可观测性）

在 `POST /api/upload-batch/prepare` 的 `jsonOk` 增加：

```json
{
	"perf": {
		"serverMs": 123,
		"dbMs": 78,
		"steps": {
			"validateMs": 5,
			"quotaSimulateMs": 20,
			"quotaPersistMs": 15,
			"presignMs": 30,
			"tokenPersistMs": 8
		}
	}
}
```

兼容策略：

-   新字段仅追加，不破坏既有前端。
-   老前端忽略；新前端可用于阶段拆分展示。

## 3.4 前端联动（最小变更）

-   在 `public/upload.js` 中记录：
    -   hash 阶段本地耗时；
    -   prepare 接口返回 `perf.serverMs`；
    -   complete 接口耗时。
-   在 summary 文案中区分：
    -   `哈希 xxs / 申请 xxs / 写入 xxs`。

---

## 4. 方案 B：complete 提速优化（元数据写入）

## 4.1 改造原则

-   不重写 `upload-complete` 业务逻辑（避免大面积回归风险）。
-   优先改 `upload-batch/complete` 调度层：从串行改为受控并发（4~8 可配置）。

## 4.2 执行模型

当前：

```text
for item in items:
  await completeSingleUpload(item)
```

v16：

-   引入 worker pool（例如并发度默认 8，环境变量可调）。
-   每个 worker 仍调用同一个 `completeSingleUpload`，保证单文件语义不变。
-   汇总结果时保持输出顺序与 `clientFileId` 对应稳定。

建议新增配置（可选）：

-   `UPLOAD_BATCH_COMPLETE_CONCURRENCY`（默认 8，范围 `1~12`）。

## 4.3 风险控制

-   并发过高会增加 D1 竞争与尾延迟，故采用受控并发而非全并发。
-   出现错误时按单项失败返回，不影响整批其它项（保持当前行为）。

## 4.4 可选后续优化（v16.1+）

-   将 `addTagsToImage` 从逐条 `INSERT` 升级为批量执行（`batch`）。
-   合并 `upload-complete` 内可并行的独立读操作（谨慎评估一致性）。

---

## 5. 实施范围与文件变更清单（建议）

### 5.1 prepare 最小侵入补丁（你前面提到的范围）

-   `functions/api/upload-batch/prepare.js`
-   `functions/_shared/quota.js`（新增批次模拟/聚合方法）
-   `functions/_shared/rate-limit.js`（新增批次读取+增量写方法）
-   （可选）`functions/_shared/db.js`（增加 token 批量写 helper）

### 5.2 complete 提速补丁

-   `functions/api/upload-batch/complete.js`（串行 -> 受控并发）
-   （可选）`functions/_shared/env.js`（并发度配置读取）

### 5.3 前端观测补丁

-   `public/upload.js`（展示 prepare/complete 阶段耗时）

---

## 6. 分阶段落地计划

## Phase 1：prepare 聚合优化 + perf 字段

-   完成配额/限流模拟与批量回写。
-   接入 `env.DB.batch()` 写入聚合 SQL。
-   返回 `perf.serverMs` 与 `perf.steps`。

**验收**：

-   接口语义不变（accepted/rejected 与旧逻辑一致）。
-   单批（50）prepare 平均耗时显著下降。

## Phase 2：complete 受控并发

-   `upload-batch/complete` 引入 worker pool。
-   保持 response 结构兼容。

**验收**：

-   同样输入下成功数/失败数不退化。
-   完整“写入元数据”阶段耗时明显下降。

## Phase 3：前端可观测性

-   上传页展示阶段耗时拆分，帮助定位瓶颈。

**验收**：

-   UI 能清晰显示“慢在哈希/申请/写入”。

---

## 7. 回归与测试策略

-   单元/集成：
    -   prepare：配额边界、限流边界、混合通过/拒绝。
    -   complete：并发下结果聚合正确性、错误项隔离。
-   压测（建议）：
    -   50/200/500 文件场景，记录 P50/P95。
-   线上灰度：
    -   先将 complete 并发设为 8

---

## 8. 风险与回滚

### 风险

-   批量聚合逻辑若实现错误，可能导致配额计算偏差。
-   complete 并发提高后，可能触发 D1 热点竞争。

### 回滚策略

-   prepare：保留旧逻辑分支（feature flag），出现异常时切回逐文件路径。
-   complete：将 `UPLOAD_BATCH_COMPLETE_CONCURRENCY` 降为 `1` 即回到串行语义。

---

## 9. 预期收益总结

-   `prepare`：从多次“每文件查写”变为“批次聚合查写”，DB RTT 明显减少。
-   `complete`：从串行改为受控并发，线性耗时显著缩短。
-   可观测性增强后，后续可持续优化更精准。

> 若按“最小侵入优先”执行，建议先做 Phase 1 + Phase 2，即可解决当前最痛的两段卡顿。
