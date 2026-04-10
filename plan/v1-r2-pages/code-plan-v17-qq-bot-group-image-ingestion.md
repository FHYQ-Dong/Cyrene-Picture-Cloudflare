# v17 代码实现计划：Docker 部署 mirai（无 HTTP 桥接）

> 目标：v17 改为 `mirai` 容器化部署，使用 `mirai-console` 插件在容器内直接调用 Cyrene 的 `POST /api/bot/ingest-images`，不再引入额外 HTTP 桥接服务。

---

## 1. 方案调整结论（更新）

### 1.1 v17 最终主路径

-   使用 `mirai` 作为消息接入核心。
-   使用 Docker 运行 `mirai-console`（容器内统一部署与升级）。
-   在容器内插件直接调用 Cyrene ingest API。
-   不再使用 `mirai-api-http + 外部 bridge` 架构。

### 1.2 已放弃项

-   放弃“本地 QQ 群目录轮询上传”作为 v17 主路径。
-   放弃“`mirai-api-http` 对外开放 HTTP/WS + 独立桥接服务”方案。
-   放弃 `services/mirai-ingest-bridge/` 独立进程设计。

---

## 2. 新总体架构（v17）

### 2.1 架构组件

-   **Mirai Container（新增，主接入层）**

    -   部署方式：`docker compose` 启动 `mirai-console-loader`。
    -   职责：接收 QQ 群消息事件、提取图片消息段、调用容器内插件逻辑。

-   **Mirai Ingest Plugin（新增，容器内插件）**

    -   职责：过滤群白名单、触发词匹配、下载图片、调用 `POST /api/bot/ingest-images`。
    -   运行位置：与 `mirai-console` 同容器/同进程。
    -   关键点：**无外部 HTTP 桥接服务**。

-   **Cyrene 现有后端（复用）**

    -   继续复用 `POST /api/bot/ingest-images`。
    -   继续复用 D1 + R2 的去重、元数据和审核队列能力。

### 2.2 数据流

1. `mirai` 接收群消息事件；
2. 插件筛选白名单群与触发词；
3. 插件提取图片 URL / 文件信息；
4. 插件直接调用 Cyrene `POST /api/bot/ingest-images`；
5. Cyrene 进入 `auto/pending` 审核链路并落库。

---

## 3. Docker 部署设计（mirai）

### 3.1 部署拓扑

-   `mirai` 以容器方式独立运行；
-   使用 volume 挂载 `plugins/`、`config/`、`data/`；
-   通过环境变量注入 Cyrene 地址与 Token；
-   容器重启策略 `unless-stopped`。

### 3.2 `docker-compose.yml` 示例

```yaml
services:
	mirai:
		image: ghcr.io/xxx/mirai-console:latest
		container_name: cyrene-mirai
		restart: unless-stopped
		environment:
			CYRENE_API_BASE_URL: "https://your-domain.example.com"
			CYRENE_BOT_INGEST_TOKEN: "replace-with-strong-token"
			CYRENE_ALLOWED_GROUPS: "123456,654321"
			CYRENE_TRIGGER_WORDS: "投稿,cyrene,#昔涟美图"
			CYRENE_REVIEW_MODE: "pending"
		volumes:
			- ./mirai/config:/app/config
			- ./mirai/plugins:/app/plugins
			- ./mirai/data:/app/data
		ports:
			- "8080:8080"
```

说明：`ports` 仅用于你需要暴露额外控制端口时启用；默认可不对外暴露。

### 3.3 插件配置建议

-   `allowedGroups`: 群白名单；
-   `triggerWords`: 投稿触发词；
-   `reviewMode`: `auto | pending`；
-   `defaultTags`: 如 `昔涟美图,qq投稿`；
-   `requestTimeoutMs` / `retryCount` / `retryBackoffMs`。

### 3.4 幂等与失败策略

-   幂等键：`source + groupId + messageId + imageIndex`；
-   业务去重：仍由 Cyrene 哈希去重兜底；
-   网络错误/429/5xx：指数退避重试；
-   非法 MIME/超限：直接拒绝并记录插件日志。

---

## 4. 上传与元数据映射

### 4.1 上传接口

继续复用：`POST /api/bot/ingest-images`

-   `Authorization: Bearer <BOT_INGEST_TOKEN>`
-   `source`: `mirai-docker`
-   `sourceBatchId`: `mirai:{groupId}:{messageId}`

### 4.2 字段映射建议

-   `uploaderNickname`：默认消息发送者昵称；
-   `originalFilename`：消息附件文件名；
-   `tags`：`defaultTags + 消息标签`；
-   `group_id`：消息群 ID。

### 4.3 失败策略

-   网络错误、429、5xx：指数退避重试 3 次；
-   文件不合法（格式/体积）：标记 `rejected` 不重试；
-   长期失败（如 24h）：进入 `dead-letter` 列表，供人工处理。

---

## 5. 运维与安全

-   Token 仅通过环境变量注入，不写入镜像层；
-   限制容器网络出口，仅允许访问 Cyrene API 域名；
-   只启用必要插件，禁用对外 HTTP 管理接口；
-   记录结构化日志（事件 ID、群 ID、消息 ID、结果码）。

---

## 6. 与现有系统兼容性

-   现有 `functions/api/bot/ingest-images.js`、D1、R2、审核 API 全量复用；
-   `qq-bot/` 子项目降级为历史方案（非 v17 主路径）；
-   `mirai-api-http` 与外部 bridge 不再是 v17 组成部分。

---

## 7. 分阶段落地

## Phase 1（MVP）

-   完成 mirai 容器化启动（compose + volume）；
-   完成容器内插件直连 `POST /api/bot/ingest-images`；
-   接通 `reviewMode=pending` 审核队列；
-   补齐插件日志与重试。

## Phase 2（运维增强）

-   增加容器健康检查与自动拉起；
-   增加失败重放与 dead-letter；
-   增加群维度限流与监控指标。

## Phase 3（质量优化）

-   增加图片质量评分（分辨率、清晰度、重复度）；
-   支持自动归档（成功后移动到 `archive/`）；
-   支持按群维度策略（不同群不同标签/阈值）。

---

## 8. 验收标准（更新）

-   群消息图片事件 P95 30 秒内完成上传入站；
-   100 张连续导入成功率 > 99%；
-   同图重复落盘不重复入库（hash 去重生效）；
-   失败可追踪到 `groupId + messageId + imageIndex`；
-   进程重启后不丢任务、不重复大规模补传。

---

## 9. 目录与实现建议（v17）

建议新增目录：`services/mirai-docker/`

-   `docker-compose.yml`：容器编排
-   `README.md`：部署与回滚步骤
-   `config/plugin-config.yml`：插件参数（群白名单、触发词、reviewMode）
-   `ops/healthcheck.sh`：健康检查脚本（可选）

---

## 10. `mamoe/mirai` Docker 落地方案（v17 主路径）

### 10.1 目标与边界

-   目标：通过 `mirai + mirai-console` 容器接收群消息图片，并由容器内插件直接调用 `POST /api/bot/ingest-images`。
-   边界：不依赖 `mirai-api-http`，不新增独立桥接服务。

### 10.2 部署拓扑

1. 一台 Windows/Linux 主机安装 Docker；
2. 通过 compose 启动 mirai 容器；
3. 挂载投稿插件到 `plugins/`；
4. 插件直接调用 Cyrene `POST /api/bot/ingest-images`；
5. 结果回写 `bot_ingest_logs` 与 `bot_ingest_candidates`。

### 10.3 组件清单

-   Docker / Docker Compose
-   `mirai-console-loader` 镜像
-   Mirai 投稿插件（容器内）
-   现有 Cyrene API（已具备）

### 10.4 最小安装步骤

1. 准备 `docker-compose.yml`；
2. 挂载 Mirai 账号配置与投稿插件；
3. 注入 `CYRENE_API_BASE_URL`、`CYRENE_BOT_INGEST_TOKEN`；
4. 执行 `docker compose up -d`；
5. 用测试群发送图片验证上传闭环。

### 10.5 环境变量建议

-   `CYRENE_API_BASE_URL=https://your-domain.example.com`
-   `CYRENE_BOT_INGEST_TOKEN=<cyrene token>`
-   `CYRENE_ALLOWED_GROUPS=123456,654321`
-   `CYRENE_TRIGGER_WORDS=投稿,cyrene,#昔涟美图`
-   `CYRENE_REVIEW_MODE=pending`

### 10.6 容器内插件处理流程

1. 监听群消息事件（仅白名单群）；
2. 提取图片消息段（支持多图）；
3. 下载图片并做 MIME/大小校验；
4. 构造 `source=mirai-docker`；
5. 调用 `POST /api/bot/ingest-images`；
6. 记录成功/失败并可选群内回执。

### 10.7 与现有后端配合策略

-   建议统一使用 `reviewMode=pending` 进入管理员审核；
-   需要自动放行时可切换 `reviewMode=auto`；
-   幂等键建议：`source + groupId + messageId + imageIndex`。

### 10.8 监控与运维建议

-   依赖 Docker 重启策略和健康检查守护；
-   关键指标：每分钟入站数、失败率、平均处理时延、重复命中率；
-   出现异常时优先查看容器日志与 Cyrene `bot_ingest_logs`。

---

## 11. 参考链接与决策记录

-   Mirai 项目：`https://github.com/mamoe/mirai`
-   Mirai 文档：`https://docs.mirai.mamoe.net/`
-   Mirai Forum：`https://mirai.mamoe.net/`

决策：**v17 主路径调整为“Docker 部署 mirai + 容器内插件直连 ingest API（无 HTTP 桥接）”。**
