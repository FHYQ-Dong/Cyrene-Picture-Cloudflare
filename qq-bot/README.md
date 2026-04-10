# qq-bot（mirai Docker 版）

本目录是 v17 的 QQ Bot 接入实现：基于 `mirai` 的 Docker 部署方案。

## 目录结构

-   `docker-compose.yml`：mirai 容器编排
-   `.env.example`：环境变量模板
-   `config/plugin-config.example.yml`：插件配置模板
-   `build.gradle.kts` / `settings.gradle.kts`：mirai 插件构建工程（Kotlin）
-   `src/main/kotlin/.../CyreneMiraiIngestPlugin.kt`：真实投稿插件
-   `tools/payload-builder.js`：构建 `POST /api/bot/ingest-images` payload 的工具
-   `tests/payload-builder.test.js`：payload 构建测试
-   `docs/mirai-account-and-plugin-design.md`：账号与插件设计说明

## 快速开始

1. 复制环境变量模板：

```powershell
Copy-Item .env.example .env -Force
```

2. 复制插件配置模板：

```powershell
Copy-Item .\config\plugin-config.example.yml .\config\plugin-config.yml -Force
```

3. 编辑 `.env` 与 `config/plugin-config.yml`：

-   `CYRENE_API_BASE_URL`
-   `CYRENE_BOT_INGEST_TOKEN`
-   `CYRENE_ALLOWED_GROUPS`
-   `CYRENE_REVIEW_MODE`

4. 编译 mirai 投稿插件（需本机安装 JDK 17+ 与 Gradle）：

```powershell
gradle buildPlugin
```

5. 将生成的插件 JAR 复制到插件目录（`./mirai/plugins`）：

```powershell
Copy-Item .\build\mirai\*.jar .\mirai\plugins\ -Force
```

6. 启动 mirai 容器：

```powershell
docker compose --env-file .env up -d
```

## 构建与测试

生成示例 payload：

```powershell
npm run build:payload
```

运行测试：

```powershell
npm test
```

## 说明

-   当前仓库已包含真实 mirai 投稿插件源码（Kotlin）。
-   插件以 JAR 形式加载到 `mirai/plugins/`。
-   插件应直接调用主站 `POST /api/bot/ingest-images`，不经过外部 HTTP bridge。
