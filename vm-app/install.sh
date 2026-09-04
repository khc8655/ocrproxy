#!/bin/bash
# ==============================================================================
# OCRProxy 一键安装与平滑升级脚本 (Linux / Ubuntu / Debian)
# 
# 托管仓库: https://github.com/khc8655/ocrproxy
#
# 使用方法:
#   1. 一键网络安装/升级:
#      curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash
#
#   2. 自定义参数安装/静默安装:
#      curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash -s -- -p 8787 -w MyAdminPass123
#      或通过环境变量:
#      APP_PORT=8787 ADMIN_PASSWORD=xxx curl -fsSL https://raw.githubusercontent.com/khc8655/ocrproxy/main/install.sh | bash
# ==============================================================================

set -e

# 颜色与样式
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# 基础全局定义
INSTALL_DIR="/opt/ocrproxy"
SERVICE_NAME="ocrproxy"
GITHUB_REPO="khc8655/ocrproxy"
GITHUB_BRANCH="main"
TARBALL_URL="https://github.com/${GITHUB_REPO}/archive/refs/heads/${GITHUB_BRANCH}.tar.gz"
PYTHON_MIN_VERSION="3.9"

# 打印工具函数
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()      { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }
highlight(){ echo -e "${CYAN}${BOLD}$1${NC}"; }

# 随机字符串生成器 (密码与 API Key)
gen_random_str() {
    local len=${1:-16}
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$len"
}

# 检查 root 权限
if [[ $EUID -ne 0 ]]; then
    error "此脚本必须以 root 权限运行。请使用: sudo bash install.sh"
fi

# ==============================================================================
# 解析命令行参数
# ==============================================================================
CLI_PORT=""
CLI_PASSWORD=""
CLI_MODE=""
CLI_TOKEN=""
NON_INTERACTIVE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--token)
            CLI_TOKEN="$2"
            shift 2
            ;;
        -p|--port)
            CLI_PORT="$2"
            shift 2
            ;;
        -w|--password|--pass)
            CLI_PASSWORD="$2"
            shift 2
            ;;
        -m|--mode)
            CLI_MODE="$2"
            shift 2
            ;;
        -y|--yes|--non-interactive)
            NON_INTERACTIVE=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# 导出并统一 Token（支持私有仓库）
GITHUB_TOKEN="${CLI_TOKEN:-${GITHUB_TOKEN:-$GH_TOKEN}}"
export GITHUB_TOKEN

# ==============================================================================
# 获取公网 IP (优先 IPv4，备用 IPv6)
# ==============================================================================
detect_public_ip() {
    local ip=""
    ip=$(curl -4 -s --connect-timeout 3 https://api.ipify.org 2>/dev/null || true)
    if [[ -z "$ip" ]]; then
        ip=$(curl -6 -s --connect-timeout 3 https://api64.ipify.org 2>/dev/null || true)
    fi
    if [[ -z "$ip" ]]; then
        ip="127.0.0.1"
    fi
    echo "$ip"
}

# ==============================================================================
# 获取代码源 (本地目录或下载 GitHub 源码包)
# ==============================================================================
prepare_source_code() {
    local target_extract_dir="$1"
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"

    # 情况 1: 本地运行 (脚本所在目录有 vm-app 和 shared)
    if [[ -n "$script_dir" && -d "$script_dir/vm-app" && -d "$script_dir/shared" ]]; then
        info "检测到本地源码仓库，直接使用本地源码..."
        mkdir -p "$target_extract_dir/source"
        cp -r "$script_dir/vm-app" "$target_extract_dir/source/"
        cp -r "$script_dir/shared" "$target_extract_dir/source/"
        return 0
    fi

    # 情况 2: 远程 curl 管道运行，下载 GitHub 源码压缩包
    info "正在从 GitHub (${GITHUB_REPO}) 下载最新发行源码..."
    mkdir -p "$target_extract_dir/dl"
    local tar_file="$target_extract_dir/ocrproxy.tar.gz"
    local auth_header=()
    local dl_url="${TARBALL_URL}"

    if [[ -n "$GITHUB_TOKEN" ]]; then
        auth_header=(-H "Authorization: token ${GITHUB_TOKEN}")
        dl_url="https://api.github.com/repos/${GITHUB_REPO}/tarball/${GITHUB_BRANCH}"
    elif [[ -n "$GH_TOKEN" ]]; then
        auth_header=(-H "Authorization: token ${GH_TOKEN}")
        dl_url="https://api.github.com/repos/${GITHUB_REPO}/tarball/${GITHUB_BRANCH}"
    fi

    if ! curl -fSL "${auth_header[@]}" --connect-timeout 15 --retry 3 "${dl_url}" -o "$tar_file"; then
        if [[ ${#auth_header[@]} -gt 0 ]] || ! curl -fSL --connect-timeout 15 --retry 3 "${TARBALL_URL}" -o "$tar_file"; then
            error "从 GitHub 下载源码失败，请检查网络连接或 GitHub 访问状态 (若仓库为私有，请提供 GITHUB_TOKEN=...): ${dl_url}"
        fi
    fi

    mkdir -p "$target_extract_dir/extracted"
    tar -xzf "$tar_file" -C "$target_extract_dir/extracted" --strip-components=1

    mkdir -p "$target_extract_dir/source"
    cp -r "$target_extract_dir/extracted/vm-app" "$target_extract_dir/source/"
    cp -r "$target_extract_dir/extracted/shared" "$target_extract_dir/source/"
    ok "源码下载与校验解压完成"
}

# ==============================================================================
# 系统级出站网络优化 (优先 IPv4 出站，规避部分源站跨国 IPv6 丢包黑洞)
# ==============================================================================
optimize_network_routing() {
    if [[ -f /etc/gai.conf ]]; then
        if grep -q "^#precedence ::ffff:0:0/96  100" /etc/gai.conf; then
            info "优化系统级 DNS 解析优先级 (启用 IPv4 优先，防止大模型国内源站 IPv6 丢包)..."
            sed -i "s/#precedence ::ffff:0:0\/96  100/precedence ::ffff:0:0\/96  100/" /etc/gai.conf
            ok "网络出站优先级已调优"
        fi
    fi
}

# ==============================================================================
# 模式判断: 升级 (Upgrade) 还是 全新安装 (Install)
# ==============================================================================
is_installed() {
    if [[ -f "${INSTALL_DIR}/.env" && -d "${INSTALL_DIR}/app" && -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
        return 0
    fi
    return 1
}

echo ""
echo "=============================================================================="
highlight "  OCRProxy 一键部署与管理中心 (Unified LLM Gateway)"
echo "=============================================================================="
echo ""

# ------------------------------------------------------------------------------
# 分支 A: 平滑升级模式 (UPGRADE MODE)
# ------------------------------------------------------------------------------
if is_installed; then
    echo -e "${GREEN}${BOLD}▶ 检测到已安装 OCRProxy 服务，进入【平滑就地升级】流程${NC}"
    echo ""

    # 读取旧配置中的端口
    CURRENT_PORT=$(grep -oP '^APP_PORT=\K\d+' "${INSTALL_DIR}/.env" || echo "8787")
    info "当前服务监听端口: ${CURRENT_PORT}"

    # 创建独立备份
    BACKUP_DIR="${INSTALL_DIR}/backup/backup_$(date +%Y%m%d_%H%M%S)"
    info "正在备份当前配置与密钥至 ${BACKUP_DIR}..."
    mkdir -p "${BACKUP_DIR}"
    cp "${INSTALL_DIR}/.env" "${BACKUP_DIR}/" 2>/dev/null || true
    if [[ -d "${INSTALL_DIR}/config" ]]; then
        cp -r "${INSTALL_DIR}/config" "${BACKUP_DIR}/" 2>/dev/null || true
    fi
    ok "历史配置已完成安全备份"

    # 准备新源码
    TMP_DIR=$(mktemp -d /tmp/ocrproxy_upgrade_XXXXXX)
    trap 'rm -rf "$TMP_DIR"' EXIT
    prepare_source_code "$TMP_DIR"

    # 停止服务准备更新
    info "正在平滑同步应用文件..."
    cp -r "$TMP_DIR/source/vm-app/app" "${INSTALL_DIR}/"
    cp -r "$TMP_DIR/source/vm-app/static" "${INSTALL_DIR}/"
    cp -r "$TMP_DIR/source/vm-app/scripts" "${INSTALL_DIR}/"
    cp "$TMP_DIR/source/vm-app/requirements.txt" "${INSTALL_DIR}/"
    cp "$TMP_DIR/source/vm-app/run_server.py" "${INSTALL_DIR}/"
    cp -r "$TMP_DIR/source/shared" "${INSTALL_DIR}/"
    ln -sfn "${INSTALL_DIR}/shared" "/opt/shared" 2>/dev/null || true
    chmod +x "${INSTALL_DIR}/scripts/"*.sh 2>/dev/null || true

    # 更新 Python 依赖
    info "正在增量检查并更新 Python 虚拟环境依赖..."
    "${INSTALL_DIR}/venv/bin/pip" install --no-cache-dir -r "${INSTALL_DIR}/requirements.txt" -q
    ok "Python 依赖更新完成"

    # 检查并确保 systemd service 使用 run_server.py
    optimize_network_routing
    if ! grep -q "run_server.py" "/etc/systemd/system/${SERVICE_NAME}.service" 2>/dev/null; then
        info "升级 systemd 服务以支持真双栈套接字监听..."
        sed -i 's|ExecStart=.*uvicorn app.main:app.*|ExecStart=/opt/ocrproxy/venv/bin/python /opt/ocrproxy/run_server.py|' "/etc/systemd/system/${SERVICE_NAME}.service"
    fi

    systemctl daemon-reload
    info "正在重启 ${SERVICE_NAME} 服务..."
    systemctl restart "${SERVICE_NAME}"

    # 健康自检
    info "正在执行服务健康自检..."
    CHECK_SUCCESS=false
    for i in {1..15}; do
        if curl -s -g "http://127.0.0.1:${CURRENT_PORT}/health" | grep -q '"status":"ok"'; then
            CHECK_SUCCESS=true
            break
        fi
        sleep 1
    done

    if [[ "$CHECK_SUCCESS" == "true" ]]; then
        ok "健康检查通过！服务运行正常。"
    else
        warn "健康检查未能在 15 秒内响应，请通过 'systemctl status ${SERVICE_NAME}' 查看服务状态。"
    fi

    echo ""
    echo "=============================================================================="
    echo -e "${GREEN}${BOLD}  🎉 OCRProxy 平滑升级成功！${NC}"
    echo "=============================================================================="
    echo -e "  服务端口: ${BOLD}${CURRENT_PORT}${NC}"
    echo -e "  备份目录: ${BACKUP_DIR}"
    echo -e "  服务状态: systemctl status ${SERVICE_NAME}"
    echo "=============================================================================="
    echo ""
    exit 0
fi

# ------------------------------------------------------------------------------
# 分支 B: 全新安装模式 (FRESH INSTALL MODE)
# ------------------------------------------------------------------------------
echo -e "${CYAN}${BOLD}▶ 未检测到旧版本，进入【全新一键安装】流程${NC}"
echo ""

# 1. 检查并安装操作系统依赖
info "Step 1/7: 检查系统环境与必要依赖..."
if ! command -v curl &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq curl
fi

if ! command -v python3 &>/dev/null; then
    error "未找到 python3，请在系统中安装 Python 3.10+。"
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
info "检测到 Python 版本: ${PY_VERSION}"

# 检查 venv 和 pip (Debian/Ubuntu 常常拆分 python3-venv 和 python3-pip)
if ! python3 -c "import ensurepip" &>/dev/null || ! command -v pip3 &>/dev/null; then
    info "安装 python3-venv 与 python3-pip..."
    apt-get update -qq && apt-get install -y -qq "python${PY_VERSION}-venv" python3-pip python3-venv
fi
ok "系统基础依赖检查就绪"

# 应用出站网络优化
optimize_network_routing

# 2. 交互或非交互参数配置
info "Step 2/7: 配置运行参数..."

# 端口选择
DEFAULT_PORT=8787
if [[ -n "$CLI_PORT" ]]; then
    FINAL_PORT="$CLI_PORT"
elif [[ -n "$APP_PORT" ]]; then
    FINAL_PORT="$APP_PORT"
elif [[ "$NON_INTERACTIVE" == "true" ]]; then
    FINAL_PORT="$DEFAULT_PORT"
else
    read -p "请输入服务监听端口 (默认: ${DEFAULT_PORT}): " INPUT_PORT
    FINAL_PORT="${INPUT_PORT:-$DEFAULT_PORT}"
fi

# 密码选择
if [[ -n "$CLI_PASSWORD" ]]; then
    FINAL_PASSWORD="$CLI_PASSWORD"
elif [[ -n "$ADMIN_PASSWORD" ]]; then
    FINAL_PASSWORD="$ADMIN_PASSWORD"
elif [[ "$NON_INTERACTIVE" == "true" ]]; then
    FINAL_PASSWORD="$(gen_random_str 16)"
else
    echo -e "请设置 Web 管理后台密码 (建议 8 位以上):"
    read -p "直接按回车将自动生成 16 位强随机密码: " INPUT_PASS
    if [[ -z "$INPUT_PASS" ]]; then
        FINAL_PASSWORD="$(gen_random_str 16)"
        info "已为您自动生成随机密码: ${BOLD}${FINAL_PASSWORD}${NC}"
    else
        FINAL_PASSWORD="$INPUT_PASS"
    fi
fi

# 运行模式选择
FINAL_MODE="${CLI_MODE:-${RUN_MODE:-agent}}"

# 3. 创建服务专用系统用户
info "Step 3/7: 配置系统专用用户..."
if id "${SERVICE_NAME}" &>/dev/null; then
    info "用户 ${SERVICE_NAME} 已存在，跳过创建"
else
    useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_NAME}"
    ok "系统用户 ${SERVICE_NAME} 创建成功"
fi

# 4. 创建目录结构并部署源码
info "Step 4/7: 部署应用目录与最新源码..."
mkdir -p "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}/config"
mkdir -p "${INSTALL_DIR}/static"
mkdir -p "${INSTALL_DIR}/scripts"
mkdir -p "${INSTALL_DIR}/backup"

TMP_DIR=$(mktemp -d /tmp/ocrproxy_install_XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT
prepare_source_code "$TMP_DIR"

cp -r "$TMP_DIR/source/vm-app/app" "${INSTALL_DIR}/"
cp -r "$TMP_DIR/source/vm-app/static" "${INSTALL_DIR}/"
cp -r "$TMP_DIR/source/vm-app/scripts" "${INSTALL_DIR}/"
cp "$TMP_DIR/source/vm-app/requirements.txt" "${INSTALL_DIR}/"
cp "$TMP_DIR/source/vm-app/run_server.py" "${INSTALL_DIR}/"
cp -r "$TMP_DIR/source/shared" "${INSTALL_DIR}/"
ln -sfn "${INSTALL_DIR}/shared" "/opt/shared" 2>/dev/null || true
chmod +x "${INSTALL_DIR}/scripts/"*.sh 2>/dev/null || true
ok "应用核心文件已部署到 ${INSTALL_DIR}"

# 5. 创建虚拟环境并安装依赖
info "Step 5/7: 创建 Python 虚拟环境并安装依赖包..."
python3 -m venv "${INSTALL_DIR}/venv"
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip -q
"${INSTALL_DIR}/venv/bin/pip" install --no-cache-dir -r "${INSTALL_DIR}/requirements.txt" -q
ok "Python 虚拟环境依赖安装完成"

# 6. 初始化密钥、.env 与加密配置
info "Step 6/7: 初始化 Fernet 密钥与服务配置..."
EXTERNAL_CONFIG=""
for candidate in "/root/proxy_config" "/tmp/proxy_config" "./proxy_config"; do
    if [[ -f "$candidate" ]]; then
        EXTERNAL_CONFIG="$candidate"
        break
    fi
done

"${INSTALL_DIR}/venv/bin/python" "${INSTALL_DIR}/scripts/init_config.py" \
    "$EXTERNAL_CONFIG" \
    "${INSTALL_DIR}/config" \
    "${INSTALL_DIR}/.env" \
    "$FINAL_PORT" \
    "$FINAL_MODE" \
    "$FINAL_PASSWORD"

# 从 .install_secrets.json 或 .env 读取生成的密钥
PROXY_KEY=$(grep -oP '^PROXY_API_KEY=\K.+' "${INSTALL_DIR}/.env" || echo "sk-ocrproxy-generated")

# 7. 配置并启动 systemd 服务 (支持双栈与内存安全限制)
info "Step 7/7: 配置并启动 systemd 服务..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=OCRProxy - Unified LLM Proxy Gateway
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_NAME}
Group=${SERVICE_NAME}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
Environment=MALLOC_ARENA_MAX=2
ExecStart=${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/run_server.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

MemoryHigh=768M
MemoryMax=1024M
MemorySwapMax=0

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

# 权限加固
chown -R "${SERVICE_NAME}:${SERVICE_NAME}" "${INSTALL_DIR}"
chmod 600 "${INSTALL_DIR}/.env"
chmod 700 "${INSTALL_DIR}/config"
chmod 600 "${INSTALL_DIR}/config/proxy_config.enc" 2>/dev/null || true

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

# 健康自检验证
info "正在检验服务运行健康状态..."
CHECK_SUCCESS=false
for i in {1..15}; do
    if curl -s -g "http://127.0.0.1:${FINAL_PORT}/health" | grep -q '"status":"ok"'; then
        CHECK_SUCCESS=true
        break
    fi
    sleep 1
done

PUBLIC_IP=$(detect_public_ip)

echo ""
echo "=============================================================================="
if [[ "$CHECK_SUCCESS" == "true" ]]; then
    echo -e "${GREEN}${BOLD}  🎉 OCRProxy 安装成功并已正常启动！${NC}"
else
    echo -e "${YELLOW}${BOLD}  ⚠️ OCRProxy 已安装，服务启动中 (自检暂未就绪)${NC}"
fi
echo "=============================================================================="
echo ""
echo -e "  🌐 ${BOLD}Web 管理控制台${NC}:"
echo -e "     地址: ${CYAN}http://${PUBLIC_IP}:${FINAL_PORT}/${NC}"
echo -e "     密码: ${YELLOW}${BOLD}${FINAL_PASSWORD}${NC}"
echo ""
echo -e "  🔑 ${BOLD}大模型代理接入 (OpenAI 格式)${NC}:"
echo -e "     端点: ${CYAN}http://${PUBLIC_IP}:${FINAL_PORT}/v1${NC}"
echo -e "     密钥: ${YELLOW}${PROXY_KEY}${NC}"
echo ""
echo -e "  🛠️  ${BOLD}常用运维命令${NC}:"
echo -e "     查看状态: ${BOLD}systemctl status ${SERVICE_NAME}${NC}"
echo -e "     查看日志: ${BOLD}journalctl -u ${SERVICE_NAME} -f${NC}"
echo -e "     重启服务: ${BOLD}systemctl restart ${SERVICE_NAME}${NC}"
echo -e "     一键升级: ${BOLD}curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/install.sh | bash${NC}"
echo ""
echo "=============================================================================="
echo ""
