# 可行性调研：NAS Docker 部署 + Cloudflare Tunnel 公网访问

-   调研日期：2026-03-26
-   目标：评估是否可在家用 NAS 上通过 Docker 部署图片站，并用 Cloudflare Tunnel 提供公网访问。

## 1. 结论（TL;DR）

**可行，且适合快速上线与低运维；但图片大流量场景会受 NAS 上行带宽限制。**

对于你当前的“初期大量群友上传”目标，方案可行度高。建议分两种路线：

1. **纯 NAS 路线**：前端 + API + 图片存储都在 NAS，本地盘保存。
2. **混合路线（更推荐）**：前端/API 在 NAS，图片仍放 R2（或至少热图放 R2），降低家宽压力并保留 Cloudflare 缓存优势。

---

## 2. 官方机制依据（关键事实）

### 2.1 Tunnel 基本可行性

-   Cloudflare Tunnel 由 `cloudflared` 在源站发起**仅出站**连接到 Cloudflare 网络。
-   可在不暴露公网 IP/不做端口映射的情况下让外网访问源站服务。
-   一个 tunnel 可对应多个 hostname 与服务（通过 ingress 规则）。

### 2.2 Tunnel 路由与域名

-   Tunnel 通过 DNS CNAME 指向 `<UUID>.cfargotunnel.com` 进行路由。
-   Tunnel 与 DNS 记录是独立对象；Tunnel 掉线时，DNS 记录仍在，访问可能返回 1016。
-   该 hostname 仍继承 Cloudflare 规则能力（WAF/Cache/Rules）。

### 2.3 配置与协议能力

-   `cloudflared` 支持配置文件模式，按顺序匹配 ingress 规则，且必须有 catch-all 规则。
-   可代理 HTTP/HTTPS/SSH/TCP 等协议；WebSocket 支持。
-   gRPC 公网 hostname 有限制（FAQ 指向 private subnet routing 支持）。

---

## 3. 架构方案对比

### 方案 A：全量在 NAS

-   Docker 容器：`web`（前端+API） + `db`（可选） + `cloudflared`
-   图片落盘 NAS（如 `/volume1/pic-data`）
-   Tunnel 将 `img.example.com` / `www.example.com` 路由到本地服务

优点：

-   架构简单，数据完全在本地可控
-   成本低

风险：

-   外网访问高峰时，受 NAS 上行带宽限制明显
-   NAS 宕机/断电/网络波动会直接影响线上可用性
-   大量图片传输会长期占用家宽

### 方案 B：NAS + R2（推荐）

-   NAS 承载业务层（上传签名、列表、管理）
-   图片对象存储在 R2（仍可保留你现有风控策略）
-   Tunnel 仅承载 API/管理路径，静态图走 R2 域名

优点：

-   家宽压力显著降低
-   图片读流量不打 NAS
-   与你已有文档（风控/缓存/告警）可复用

风险：

-   组件更多，部署复杂度略增

---

## 4. 免费层与成本可行性

### 4.1 Cloudflare 侧

-   Tunnel 本身可用在 Cloudflare One 体系内（需按当前账号功能开通情况配置）。
-   公网 hostname 继承 Cloudflare WAF/Rules/Cache 能力，可延续你之前的反滥用策略。

### 4.2 NAS/家宽侧（真实瓶颈）

-   真正的上限通常在 NAS CPU、磁盘 I/O、尤其是家庭上行带宽。
-   如果图片全走 NAS 源站，峰值访问会较快碰到网络天花板。

建议先测三项：

1. NAS 到公网持续上行能力（Mbps）
2. 单容器并发连接稳定性
3. 断网/重启后 tunnel 自愈时间

---

## 5. 安全与稳定建议（针对 NAS）

1. **禁入站端口暴露**：路由器不做 80/443 映射，仅允许 NAS 出站。
2. **cloudflared 独立容器**：与业务容器分离，便于升级与故障定位。
3. **最小权限挂载**：业务容器只挂必要目录，避免误删 NAS 数据。
4. **至少双副本 tunnel connector（可选）**：降低单进程故障影响。
5. **备份策略**：图片与数据库分开备份；至少每日增量。
6. **日志可观测**：保留 `cloudflared` 日志与应用结构化日志。

### 5.1 图片访问路径白名单策略（你提出的方案）

可行，建议按以下三条直接执行：

1. **边缘规则拦截**：在 Cloudflare WAF/Rules 配置
   `host == img.example.com AND NOT path starts_with "/validate/" -> Block`
2. **源站重写（推荐）**：用 Worker 或应用层把
   `/validate/<image_key>` 重写到真实对象路径，再返回图片。
3. **其余路径**：直接 `403` 或 `404`，不回源。

---

## 6. 推荐落地路径（两阶段）

### 阶段 1：快速验证（1~2 天）

-   NAS Docker 起 `web` + `cloudflared`
-   开通 1 个 hostname（如 `staging.example.com`）
-   验证上传、浏览、分享链路
-   验证 Challenge/Rate Limiting 基本生效

### 阶段 2：正式上线（3~7 天）

-   增加第二 hostname 与规则分层（API/图片）
-   完成告警矩阵自动动作（Warning/Critical）
-   压测并记录可承载上限
-   若峰值压力大，切到混合路线（图片迁移 R2）

---

## 7. 适配你当前项目的建议结论

-   你这个项目可以**先在 NAS + Tunnel 上线**，满足“快上线、低成本、可控”。
-   若预期“群友集中访问 + 大图高并发”，建议从第一周就准备 **NAS+R2 混合方案**，避免后续大迁移。
-   你已经做好的 `5.x` 风控与 `6` 仪表盘操作清单，在 NAS 路线仍然成立，可直接复用。

---

## 8. 参考资料（官方）

-   Cloudflare Tunnel Overview: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
-   Create Tunnel (Dashboard): https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/
-   Tunnel Configuration file: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/
-   DNS records for Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/
-   Protocols for published applications: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
-   Tunnels FAQ: https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/
