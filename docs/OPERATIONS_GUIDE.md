# OCRProxy 常用运维指令与管理手册 (Operations & Troubleshooting Guide)

> 本文档整理了 OCRProxy 在 Linux / VM 环境下的所有日常运维、模式切换、反向代理配置、版本升级与故障排查指令，方便快速查阅。

---

## 目录
1. [系统级管理命令 (CLI 速查)](#1-系统级管理命令-cli-速查)
2. [网络监听与反代模式一秒切换](#2-网络监听与反代模式一秒切换)
3. [密钥、密码与端口修改](#3-密钥密码与端口修改)
4. [Caddy 与 Nginx 反向代理最佳实践 (HTTPS)](#4-caddy-与-nginx-反向代理最佳实践-https)
5. [平滑升级与版本更新](#5-平滑升级与版本更新)
6. [配置备份与数据迁移](#6-配置备份与数据迁移)
7. [常见问题与故障排查 (FAQ)](#7-常见问题与故障排查-faq)

---

## 1. 系统级管理命令 (CLI 速查)

OCRProxy 安装后会自动注册 `/usr/local/bin/ocrproxy` 全局命令，普通用户即可直接执行（已配置安全 sudoers 免密白名单）：

| 操作需求 | 执行命令 | 权限说明 | 行为描述 |
| :--- | :--- | :--- | :--- |
| **查看运行状态** | `ocrproxy status` | 普通用户直接运行 | 查看 systemd 服务状态、PID、内存占用及监听端口 |
| **查看实时日志** | `ocrproxy log` | 普通用户直接运行 | 实时滚动跟踪服务运行日志（`Ctrl+C` 退出） |
| **优雅重启服务** | `ocrproxy restart` | 普通用户直接运行（免密） | 平滑重载应用进程，新配置即刻生效 |
| **一键平滑升级** | `ocrproxy upgrade` | 普通用户直接运行（免密） | 从 GitHub 拉取最新发布，1秒就地无感升级 |
| **安全卸载服务** | `ocrproxy uninstall` | 需要 root / sudo | 停止服务并自动安全归档备份配置至 `/tmp/` |
| **保留配置卸载** | `ocrproxy uninstall --keep-config` | 需要 root / sudo | 仅移除代码与进程，保留 `/opt/ocrproxy/config` |

---

## 2. 网络监听与反代模式一秒切换

OCRProxy 支持两种网络架构：
- **反代模式 (`127.0.0.1`)**：服务仅监听本地回环地址，外网无法通过 IP 直接访问，必须通过本机的 Caddy/Nginx 域名 HTTPS 访问（安全推荐）。
- **直通模式 (`::`)**：服务监听 IPv4/IPv6 全网，支持直接通过 `http://IP:端口` 访问。

### 2.1 一行命令切换模式 (就地即时生效)

#### 切换为【反向代理模式】 (仅本地监听 127.0.0.1)
```bash
sudo sed -i 's/^APP_HOST=.*/APP_HOST=127.0.0.1/' /opt/ocrproxy/.env && ocrproxy restart
```

#### 切换为【全网直通模式】 (公网 IPv4/IPv6 全监听)
```bash
sudo sed -i 's/^APP_HOST=.*/APP_HOST=::/' /opt/ocrproxy/.env && ocrproxy restart
```

#### 检查当前生效的监听模式
```bash
ocrproxy status
# 或查看环境配置文件
grep "^APP_HOST=" /opt/ocrproxy/.env
```

### 2.2 通过一键网络脚本切换
如果您想在拉取最新代码的同时切换模式：
```bash
# 升级并切换为反代模式
curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- --proxy

# 升级并切换为直通模式
curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- --direct
```

---

## 3. 密钥、密码与端口修改

### 3.1 查看当前密码与 API Key
```bash
# 查看所有运行环境变量
cat /opt/ocrproxy/.env

# 仅查看 Web 管理后台密码
grep "^ADMIN_PASSWORD=" /opt/ocrproxy/.env

# 仅查看客户端大模型调用 API Key
grep "^PROXY_API_KEY=" /opt/ocrproxy/.env
```

### 3.2 重置 Web 管理员密码
```bash
# 将 YourNewPassword123 替换为您想要的密码
sudo sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=YourNewPassword123/' /opt/ocrproxy/.env
ocrproxy restart
```

### 3.3 修改服务监听端口 (如从 8787 改为 9090)
```bash
sudo sed -i 's/^APP_PORT=.*/APP_PORT=9090/' /opt/ocrproxy/.env
ocrproxy restart
```

---

## 4. Caddy 与 Nginx 反向代理最佳实践 (HTTPS)

反向代理用于为 OCRProxy 提供**安全加密 (HTTPS)** 与 **自定义域名** 访问。

> [!IMPORTANT]
> 大模型对话严重依赖 **SSE (Server-Sent Events) 流式打字机** 输出。反代配置中必须**关闭缓冲 (Buffer)**，否则会导致流式回答卡顿为一次性输出。

### 4.1 Caddy 配置样例 (极简推荐 ⭐⭐⭐)
安装 Caddy：`sudo apt install -y caddy`  
编辑 `/etc/caddy/Caddyfile`：

```caddy
your-domain.com {
    # 反向代理到本地 OCRProxy 服务端口 (默认 8787)
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1   # 关键：禁用响应缓冲，保障 SSE 流式极速打字响应
    }
}
```
保存后重载 Caddy：
```bash
sudo systemctl reload caddy
```
Caddy 会自动申请 Let's Encrypt SSL 证书，您即可通过 `https://your-domain.com` 访问控制台与 API。

---

### 4.2 Nginx 配置样例 (经典稳定 ⭐⭐)
在 `/etc/nginx/sites-available/ocrproxy` 中配置：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 核心：SSE 流式直通配置，防打字机卡顿
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```
保存后测试并重载：
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 5. 平滑升级与版本更新

OCRProxy 设计为**平滑就地升级**，升级前自动备份配置，保留所有已添加的模型、Key 和密码。

### 方式 1：本机全局 CLI 命令 (最推荐 · 1秒完成)
```bash
ocrproxy upgrade
```
*已包含依赖智能检测跳过机制，自动秒级跳过重复 pip/apt 安装。*

### 方式 2：网络一键脚本直接重跑
```bash
curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash
```
*自动识别已有安装，直接进入平滑就地升级分支。*

### 方式 3：Web 管理后台一键 OTA
1. 浏览器打开管理后台；
2. 进入「⚙️ 系统设置」 -> 滚动到「程序版本在线检测与 OTA 升级」；
3. 点击「🔄 检查更新」 -> 「🚀 一键在线平滑升级」。

---

## 6. 配置备份与数据迁移

OCRProxy 的核心状态全部保存在 `/opt/ocrproxy/` 目录下，结构极其纯净：
- 环境变量：`/opt/ocrproxy/.env`（端口、监听地址、管理密码、客户端 Key）
- 模型与密钥配置：`/opt/ocrproxy/config/proxy_config.enc`（Fernet 加密文件）

### 6.1 手动一键备份
```bash
tar -czvf /root/ocrproxy_backup_$(date +%Y%m%d).tar.gz /opt/ocrproxy/config /opt/ocrproxy/.env
```

### 6.2 迁移到全新主机恢复
在全新主机上安装完 OCRProxy 后，覆盖备份文件并重启服务：
```bash
sudo cp -r config/* /opt/ocrproxy/config/
sudo cp .env /opt/ocrproxy/.env
sudo chown -R ocrproxy:ocrproxy /opt/ocrproxy/config /opt/ocrproxy/.env
ocrproxy restart
```

---

## 7. 常见问题与故障排查 (FAQ)

### Q1: 启动失败或报端口被占用？
查看是哪个进程占用了 8787 端口：
```bash
sudo lsof -i :8787
# 或
sudo ss -tulpn | grep 8787
```
若需更换端口，修改 `/opt/ocrproxy/.env` 中的 `APP_PORT` 并运行 `ocrproxy restart`。

### Q2: 客户端调用报错 `401 Unauthorized`？
- 确认调用请求头是否为：`Authorization: Bearer <您的PROXY_API_KEY>`；
- 查看您的有效 API Key：`grep PROXY_API_KEY /opt/ocrproxy/.env`。

### Q3: systemd 日志过大如何清理？
OCRProxy 安装时已配置日志限额，如需手动清理旧日志：
```bash
# 保留最近 50MB 日志
sudo journalctl --vacuum-size=50M

# 保留最近 3 天日志
sudo journalctl --vacuum-time=3d
```

### Q4: 如何手动检查服务健康状态？
```bash
curl -i http://127.0.0.1:8787/health
```
正常响应：`HTTP/1.1 200 OK` 且内容为 `{"status":"ok", ...}`。
