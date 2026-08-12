#!/bin/bash
# ============================================================
# OCRProxy VM 版本一键安装脚本
# 适用于 Ubuntu / Debian 系统
# 使用方法: sudo bash install.sh
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 默认配置
INSTALL_DIR="/opt/ocrproxy"
SERVICE_NAME="ocrproxy"
APP_PORT=8787
PYTHON_MIN_VERSION="3.9"

# 支持通过命令行参数指定 proxy_config 文件路径
# 用法: sudo bash install.sh [proxy_config_path]
EXTERNAL_CONFIG="$1"

# 打印函数
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 检查 root 权限
if [[ $EUID -ne 0 ]]; then
    error "此脚本需要 root 权限运行，请使用: sudo bash install.sh"
fi

echo ""
echo "============================================================"
echo "  OCRProxy VM 版本安装程序"
echo "  统一大模型中转与故障自动切换服务"
echo "============================================================"
echo ""

# ============================================================
# Step 1: 检查系统环境
# ============================================================
info "Step 1/8: 检查系统环境..."

# 检查 Python 版本
if ! command -v python3 &> /dev/null; then
    error "未找到 python3，请先安装: apt install python3 python3-pip python3-venv"
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
info "Python 版本: ${PY_VERSION}"

# 比较版本号
PY_OK=$(python3 -c "
import sys
v = sys.version_info
min_v = tuple(map(int, '${PYTHON_MIN_VERSION}'.split('.')))
print('1' if (v.major, v.minor) >= min_v else '0')
")

if [[ "$PY_OK" != "1" ]]; then
    error "Python 版本过低，需要 ${PYTHON_MIN_VERSION} 或更高版本"
fi

# 检查 pip 和 venv（Ubuntu 24.04 需要 python3.X-venv 才有 ensurepip）
if ! python3 -c "import ensurepip" &> /dev/null; then
    info "安装 python3-venv..."
    PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    apt-get update -qq && apt-get install -y -qq "python${PY_VER}-venv" python3-pip
fi

ok "系统环境检查通过"

# ============================================================
# Step 2: 创建专用用户
# ============================================================
info "Step 2/8: 创建服务用户..."

if id "$SERVICE_NAME" &>/dev/null; then
    info "用户 $SERVICE_NAME 已存在，跳过创建"
else
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_NAME"
    ok "系统用户 $SERVICE_NAME 创建成功"
fi

# ============================================================
# Step 3: 创建目录结构
# ============================================================
info "Step 3/8: 创建目录结构..."

mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/config"
mkdir -p "$INSTALL_DIR/static"
mkdir -p "$INSTALL_DIR/scripts"

# 复制应用文件
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 复制 app 目录
cp -r "$SCRIPT_DIR/app" "$INSTALL_DIR/"
# 复制 static 目录
cp -r "$SCRIPT_DIR/static/"* "$INSTALL_DIR/static/" 2>/dev/null || true
# 复制 requirements.txt
cp "$SCRIPT_DIR/requirements.txt" "$INSTALL_DIR/"
# 复制 scripts 目录
cp -r "$SCRIPT_DIR/scripts/"* "$INSTALL_DIR/scripts/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true

ok "应用文件已复制到 $INSTALL_DIR"

# ============================================================
# Step 4: 创建虚拟环境并安装依赖
# ============================================================
info "Step 4/8: 创建 Python 虚拟环境并安装依赖..."

python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q

ok "Python 依赖安装完成"

# ============================================================
# Step 5: 生成密钥和初始化配置
# ============================================================
info "Step 5/8: 生成密钥和初始化配置..."

# 检查是否已有 .env 文件（避免覆盖已有配置）
if [[ -f "$INSTALL_DIR/.env" ]]; then
    warn "检测到已存在 .env 文件"
    read -p "是否保留现有配置？(Y/n): " KEEP_ENV
    if [[ "${KEEP_ENV:-Y}" =~ ^[Yy]$ ]]; then
        info "保留现有 .env 和配置文件"
        # 仍然检查配置文件是否存在
        if [[ ! -f "$INSTALL_DIR/config/proxy_config.enc" ]]; then
            info "配置文件不存在，创建空白模板..."
            "$INSTALL_DIR/venv/bin/python" "$INSTALL_DIR/scripts/init_config.py" "" "$INSTALL_DIR/config" "$INSTALL_DIR/.env" "$APP_PORT"
        fi
    else
        info "重新生成配置..."
        
        # 检查是否有现有 proxy_config 文件可导入
        IMPORT_PATH=""
        for candidate in "$EXTERNAL_CONFIG" "$SCRIPT_DIR/proxy_config" "/root/proxy_config" "/tmp/proxy_config" "./proxy_config"; do
            if [[ -n "$candidate" && -f "$candidate" ]]; then
                read -p "检测到配置文件 $candidate，是否导入现有配置（含 API Key）？(Y/n): " IMPORT_CONFIG
                if [[ "${IMPORT_CONFIG:-Y}" =~ ^[Yy]$ ]]; then
                    IMPORT_PATH="$candidate"
                    break
                fi
            fi
        done
        
        "$INSTALL_DIR/venv/bin/python" "$INSTALL_DIR/scripts/init_config.py" "$IMPORT_PATH" "$INSTALL_DIR/config" "$INSTALL_DIR/.env" "$APP_PORT"
    fi
else
    # 首次安装
    IMPORT_PATH=""
    for candidate in "$EXTERNAL_CONFIG" "$SCRIPT_DIR/proxy_config" "/root/proxy_config" "/tmp/proxy_config" "./proxy_config"; do
        if [[ -n "$candidate" && -f "$candidate" ]]; then
            read -p "检测到配置文件 $candidate，是否导入现有配置（含 API Key）？(Y/n): " IMPORT_CONFIG
            if [[ "${IMPORT_CONFIG:-Y}" =~ ^[Yy]$ ]]; then
                IMPORT_PATH="$candidate"
                break
            fi
        fi
    done
    
    "$INSTALL_DIR/venv/bin/python" "$INSTALL_DIR/scripts/init_config.py" "$IMPORT_PATH" "$INSTALL_DIR/config" "$INSTALL_DIR/.env" "$APP_PORT"
fi

# 清理临时密钥文件
rm -f "$INSTALL_DIR/config/.install_secrets.json"

ok "密钥和配置文件已生成"

# ============================================================
# Step 6: 设置文件权限
# ============================================================
info "Step 6/8: 设置文件权限..."

# 设置目录和文件所有权
chown -R "$SERVICE_NAME:$SERVICE_NAME" "$INSTALL_DIR"

# .env 文件仅所有者可读写
chmod 600 "$INSTALL_DIR/.env"

# 配置目录仅所有者可访问
chmod 700 "$INSTALL_DIR/config"
chmod 600 "$INSTALL_DIR/config/proxy_config.enc" 2>/dev/null || true

# 应用文件只读
chmod -R o-rwx "$INSTALL_DIR/app"
chmod -R o-rwx "$INSTALL_DIR/static"

ok "文件权限设置完成"

# ============================================================
# Step 7: 安装 systemd 服务
# ============================================================
info "Step 7/8: 配置 systemd 服务..."

# 读取端口配置
APP_PORT=$(grep -oP 'APP_PORT=\K\d+' "$INSTALL_DIR/.env" || echo "8787")

# 生成 service 文件
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=OCRProxy - Unified LLM Proxy Service
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_NAME}
Group=${SERVICE_NAME}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
# Cap glibc malloc arenas to 2 — eliminates heap fragmentation from
# large OCR base64 payloads on low-memory VMs.
Environment=MALLOC_ARENA_MAX=2
ExecStart=${INSTALL_DIR}/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${APP_PORT} --workers 1 --timeout-keep-alive 30 --timeout-graceful-shutdown 10
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Memory limits (tune for your VM size)
MemoryHigh=768M
MemoryMax=1024M
MemorySwapMax=0

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}/config
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
RestrictRealtime=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

# 健康检查定时器（每 60s 检测假死并自动重启）
cat > /etc/systemd/system/${SERVICE_NAME}-health.service << EOF
[Unit]
Description=OCRProxy health-check watchdog

[Service]
Type=oneshot
ExecStart=${INSTALL_DIR}/scripts/health-check.sh
EOF

cat > /etc/systemd/system/${SERVICE_NAME}-health.timer << EOF
[Unit]
Description=OCRProxy health-check watchdog
After=${SERVICE_NAME}.service

[Timer]
OnBootSec=30
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
EOF

# 每日凌晨 04:00 重启定时器
cat > /etc/systemd/system/${SERVICE_NAME}-restart.service << EOF
[Unit]
Description=Restart OCRProxy service
After=${SERVICE_NAME}.service

[Service]
Type=oneshot
ExecStart=/bin/systemctl restart ${SERVICE_NAME}.service
EOF

cat > /etc/systemd/system/${SERVICE_NAME}-restart.timer << EOF
[Unit]
Description=Daily restart of OCRProxy to release accumulated heap

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 重新加载 systemd 并启动服务和定时器
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl enable --now ${SERVICE_NAME}-health.timer
systemctl enable --now ${SERVICE_NAME}-restart.timer

ok "systemd 服务、健康检查、定时重启已配置并设为开机自启"

# ============================================================
# Step 8: 启动服务并验证
# ============================================================
info "Step 8/8: 启动服务并验证..."

# 如果服务已在运行，先停止
systemctl stop ${SERVICE_NAME} 2>/dev/null || true
sleep 1

systemctl start ${SERVICE_NAME}
sleep 3

# 检查服务状态
if systemctl is-active --quiet ${SERVICE_NAME}; then
    ok "服务已成功启动！"
else
    warn "服务启动可能需要更多时间，检查日志:"
    journalctl -u ${SERVICE_NAME} --no-pager -n 20
fi

# 健康检查
HEALTH_OK=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${APP_PORT}/health" 2>/dev/null || echo "000")
if [[ "$HEALTH_OK" == "200" ]]; then
    ok "健康检查通过 (HTTP 200)"
else
    warn "健康检查返回: $HEALTH_OK (可能需要等待几秒后重试)"
fi

# ============================================================
# 打印部署摘要
# ============================================================
echo ""
echo "============================================================"
echo -e "${GREEN}  安装完成！${NC}"
echo "============================================================"
echo ""
echo "服务状态:       systemctl status ${SERVICE_NAME}"
echo "服务日志:       journalctl -u ${SERVICE_NAME} -f"
echo "重启服务:       systemctl restart ${SERVICE_NAME}"
echo "健康检查定时器: systemctl list-timers ${SERVICE_NAME}-*"
echo ""
echo "------------------------------------------------------------"
echo "  本地地址:   http://127.0.0.1:${APP_PORT}"
echo "  管理面板:   http://127.0.0.1:${APP_PORT}/"
echo "  健康检查:   http://127.0.0.1:${APP_PORT}/health"
echo "------------------------------------------------------------"
echo ""

# 读取并显示密钥
PROXY_KEY=$(grep -oP 'PROXY_API_KEY=\K.+' "$INSTALL_DIR/.env" || echo "查看 .env 文件")
ADMIN_PASS=$(grep -oP 'ADMIN_PASSWORD=\K.+' "$INSTALL_DIR/.env" || echo "查看 .env 文件")

echo -e "${YELLOW}请妥善保存以下密钥（也可在 .env 文件中查看）：${NC}"
echo ""
echo "  PROXY_API_KEY  = $PROXY_KEY"
echo "  ADMIN_PASSWORD = $ADMIN_PASS"
echo ""
echo "  .env 文件路径: $INSTALL_DIR/.env"
echo "  配置文件路径:  $INSTALL_DIR/config/proxy_config.enc"
echo ""

# Caddy 配置提示
echo "============================================================"
echo -e "${BLUE}  Caddy 反向代理配置${NC}"
echo "============================================================"
echo ""
echo "在 Caddyfile 中添加以下配置（替换 your-domain.com）："
echo ""
echo "  your-domain.com {"
echo "      reverse_proxy 127.0.0.1:${APP_PORT} {"
echo "          flush_interval -1"
echo "      }"
echo "  }"
echo ""
echo "然后重新加载 Caddy: sudo systemctl reload caddy"
echo ""
echo "配置完成后通过 https://your-domain.com/ 访问管理面板。"
echo "============================================================"
echo ""

# 安全提示：删除明文配置文件
echo -e "${RED}[安全提示]${NC}"
echo "  如果导入了明文 proxy_config 文件，请立即删除原始文件："
echo "  rm -f /tmp/proxy_config /root/proxy_config ./proxy_config"
echo "  配置已加密存储在 $INSTALL_DIR/config/proxy_config.enc"
echo ""
echo "============================================================"
