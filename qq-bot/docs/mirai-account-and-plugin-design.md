# Mirai 账号与插件设计

## 目标

-   在 `qq-bot/` 下提供基于 `mirai` 的 Docker 版本接入。
-   不依赖外部 HTTP bridge，由容器内插件直接请求 Cyrene ingest API。

## 运行形态

-   容器：`mirai-console`
-   插件：`cyrene-mirai-ingest`（自行编译为 JAR 后放到 `mirai/plugins/`）
-   配置：`/app/config/cyrene-plugin-config.yml`

## 插件处理流程

1. 监听群消息事件。
2. 按 `allowedGroups` 与 `triggerWords` 过滤。
3. 解析图片消息段并构建上传项。
4. 请求 `POST /api/bot/ingest-images`。
5. 记录结果，失败按指数退避重试。

## ingest payload 规范

`tools/payload-builder.js` 会构建如下结构：

-   `source`: `mirai-docker`
-   `groupId`, `messageId`, `senderId`, `senderName`
-   `reviewMode`: `pending` / `auto`
-   `tags`: 默认标签
-   `images[]`: `clientFileId`, `imageUrl`, `fileName`, `mime`, `tags`

## 安全建议

-   `CYRENE_BOT_INGEST_TOKEN` 仅通过 `.env` 注入。
-   不将 token 写入镜像层或日志。
-   仅开放必要端口；生产环境可不映射对外端口。
