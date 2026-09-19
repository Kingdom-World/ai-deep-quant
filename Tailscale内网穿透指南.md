# Tailscale 内网穿透部署指南（评审 P2-6）

> 目标：让朋友在你家 Windows 主机上试用本平台，**零公网暴露**。
> 结论先行：用 Tailscale 的私有网络（tailnet），不要用公网 frp/花生壳——平台是单进程
> Express + JSON 文件账本 + 免费模型配额，任何公网暴露都是不必要的攻击面。

## 一、为什么选 Tailscale（30 秒版）

| 方案 | 公网暴露 | 需要端口转发 | 加密 | 成本 |
|---|---|---|---|---|
| 公网 frp / 花生壳 | 是（全互联网可扫到） | 是 | 自理 | 免费档有限速 |
| **Tailscale（私有）** | **否——只有你邀请的设备能访问** | 否 | WireGuard 自动 | 免费（3 用户 / 100 设备） |
| Tailscale Funnel | 是 | 否 | 自动 | 免费档（不推荐用于本平台） |

## 二、部署步骤（约 10 分钟）

1. **你的 Windows 主机安装 Tailscale**
   ```powershell
   winget install tailscale.tailscale
   ```
   安装后登录（Google/微软/Apple 账号均可），你的机器获得一个 `100.x.x.x` 内网 IP 与
   `机器名.tailnet-name.ts.net` 域名。

2. **启动平台服务**（照常）
   ```bat
   start.bat
   ```

3. **开启 HTTPS 反代（可选但推荐）**
   ```powershell
   tailscale serve --bg 3001
   ```
   之后朋友可通过 `https://你的机器名.tailnet-name.ts.net` 访问（Tailscale 自动签发证书）。
   不做这一步也可以直接 `http://100.x.x.x:3001` 访问。

4. **邀请朋友**：Tailscale 管理后台（login.tailscale.com）→ Users → Invite external users，
   或直接分享私有 invite link。朋友在自己设备装 Tailscale 并登录即可访问你的机器——
   全程没有任何端口暴露到公网。

## 三、上线前硬化检查清单（逐项打勾）

- [x] `INVITE_CODE` 已配置（`.env`：dsh-1da31dd1）——**朋友到货前建议换掉**：改 `.env` 后重启即生效
- [ ] 确认 `SITE_PASSWORD`/`SITE_USERNAME` 仍是强口令（朋友注册的是独立账号，按 uid 分账互不可见）
- [ ] 告警外发：`.env` 配置 `ALERT_WEBHOOK`（企微/钉钉/Server酱），熔断与衰减信号会推到你手机
- [ ] 知会朋友：站点 AI 走免费模型（每账号 6 次/分钟问答、2 次/分钟 Agent），你的 30 元/月 API
      key **没有**配置在网站环境——保持现状，不要把 `AI_CLOUD_API_KEY` 配给网站
- [ ] 计划任务在位：`AIQuant-BaostockSync`（06:00 数据同步）、`AIQuant-DataBackup`（03:30 备份）——
      `schtasks /Query` 确认状态
- [ ] 免费档边界：Tailscale 免费版最多 3 个用户；朋友超过 2 人需删旧邀请或升级

## 四、已知边界（诚实声明）

1. HTTP 访问（不做第 3 步）时 Cookie 无 Secure 标记、Basic 凭据明文传输——tailnet 内加密隧道
   里传输，风险可接受；做了 `tailscale serve` 则自动升级为 HTTPS。
2. 管理员判定 = 用户名等于 `.env` 的 `SITE_USERNAME`。给朋友的账号不要用这个名字。
3. 平台定位是学习研究：模拟盘账本（`data/paper/state.json`）每 5 秒落盘 + 每日备份，
   朋友误操作可用 `POST /api/paper/reset` 自助重置自己的账本，不影响他人。
4. Tailscale 出现故障时的降级路径：局域网直接 `http://<内网IP>:3001` 访问（同一 WiFi 下始终可用）。
