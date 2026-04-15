# qq-bot（LLBot 模块）

这是 Cyrene 的 QQ Bot 接入模块，负责消费 LLBot 的 OneBot11 事件，并把群图片投稿到 Cyrene 主站接口 `POST /api/bot/ingest-images`。

## 你需要先准备

-   LLBot 可启动，且 OneBot11 WebSocket 可连接。
-   Cyrene 主站已部署并可访问。
-   已配置主站变量：`BOT_INGEST_TOKEN`、`BOT_INGEST_ALLOWED_GROUPS`（可选）等。
-   本机有 Node.js 20+（本地运行）或 Docker（容器运行）。

## 第一步：配置环境变量

在 `qq-bot/` 目录创建 `.env`（不要直接用 `.env.example` 跑生产）：

```powershell
Copy-Item .\qq-bot\.env.example .\qq-bot\.env -Force
```

至少修改以下项：

-   `LLBOT_WS_URL`：例如 `ws://127.0.0.1:3001`
-   `LLBOT_ACCESS_TOKEN`：LLBot 鉴权 token（如果启用）
-   `CYRENE_API_BASE_URL`：例如 `http://127.0.0.1:8788` 或线上域名
-   `CYRENE_BOT_INGEST_TOKEN`：必须与主站 `BOT_INGEST_TOKEN` 一致
-   `CYRENE_REVIEW_MODE`：推荐 `pending`
-   `QQ_ALLOWED_GROUPS`：建议设置群白名单（逗号分隔）

## 第二步：启动 bot

### 先启动 LLBot（必做）

你可以用以下两种方式之一：

#### 方式 1：官方脚本安装并启动 LLBot（推荐）

```powershell
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/LLOneBot/LuckyLilliaBot/refs/heads/main/script/install-llbot-docker.sh -o llbot-docker.sh
chmod u+x ./llbot-docker.sh
./llbot-docker.sh
```

完成后确认 OneBot11 的 WS 端口（示例用 `3001`），并把 `.env` 中 `LLBOT_WS_URL` 改成对应地址。

#### 方式 2：使用本项目 `docker-compose.yml` 内置的 `llbot` 服务

```powershell
Set-Location .\qq-bot
docker compose up -d llbot
docker compose logs -f llbot
```

> 当前 compose 中 `qq-bot` 会自动依赖 `llbot`，并在容器内使用 `ws://llbot:3001` 连接。

### 方式 A：本地启动（开发推荐）

```powershell
npm --prefix qq-bot install
npm --prefix qq-bot run start
```

### 方式 B：Docker 启动（部署推荐）

```powershell
Set-Location .\qq-bot
docker compose up -d --build
```

停止：

```powershell
Set-Location .\qq-bot
docker compose down
```

## 第三步：验证是否启动成功

启动后应看到类似日志：

-   `llbot` 容器健康（或 WebUI 可访问）
-   `llbot status=connected`
-   `ingest ok group=... message=... images=...`

Docker 日志查看：

```powershell
Set-Location .\qq-bot
docker compose logs -f llbot
docker compose logs -f qq-bot
```

或只看 bot：

```powershell
Set-Location .\qq-bot
docker compose logs -f qq-bot
```

## 运行测试

```powershell
npm --prefix qq-bot test
```

## 常见问题

-   `CYRENE_BOT_INGEST_TOKEN is required`：未配置或为空。
-   `llbot status=error/reconnecting`：`LLBOT_WS_URL` 不可达或 token 错误。
-   `llbot` 起不来：先单独看 `docker compose logs -f llbot`，检查 LLBot 自身配置是否完成。
-   主站返回 `BOT_UNAUTHORIZED`：模块 token 与主站 token 不一致。
-   没有入站：检查 `QQ_ALLOWED_GROUPS`、`QQ_TRIGGER_WORDS`、消息是否含图片段。

## 兼容说明

-   当前处理 OneBot11 的群消息事件：`post_type=message` 且 `message_type=group`。
-   支持 `message` 为 CQ 字符串或对象段数组（`type=image`）。
