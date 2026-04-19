#!/bin/bash
set -e

# 容器启动脚本 - 支持三种访问/触发方式：
# 1. 直接 VNC 连接（端口 5900，密码通过 VNC_PASSWORD 环境变量设置，默认 zf123456）
#   使用 VNC 客户端连接主机IP:5900，延迟最低、操作最流畅
# 2. Web 访问 noVNC（端口 6080，无需额外客户端）
#   浏览器访问 http://主机IP:6080/vnc.html
# 3. HTTP 触发服务器（端口 3000，用于 Supabase Cron 定时调用）
#   - 健康检查: GET /health
#   - 触发爬虫: POST /trigger (需 API_KEY 验证，如果设置了 API_KEY 环境变量)
#   - 状态查询: GET /status
# 基本参数：x11vnc -noxdamage -shared, noVNC --heartbeat 30
#
# 部署到 clawcloud 后，可通过 Supabase Cron 定时调用 HTTP 触发服务器来执行爬虫任务。
# 设置环境变量 API_KEY 可启用授权保护，确保只有携带正确 Bearer Token 的请求才能触发爬虫。
# 详细配置示例参见 /app/scripts/trigger-server.js 文件顶部的注释。
#
# 环境变量说明：
# - VNC_PASSWORD: VNC连接密码（默认：zf123456）
# - API_KEY: HTTP触发服务器授权密钥（可选，如设置则需Bearer Token验证）
# - TRIGGER_PORT: HTTP触发服务器端口（默认：3000）


# 加载全局环境变量（确保 fcitx 生效）
source /etc/profile.d/fcitx.sh

echo "=== 启动 Xvfb ==="
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99

# 等待 Xvfb 完全启动
echo "等待 Xvfb 启动..."
sleep 2
if [ ! -e /tmp/.X11-unix/X99 ]; then
    echo "Xvfb 启动失败，重试..."
    Xvfb :99 -screen 0 1280x720x16 -ac +extension GLX +render -noreset &
    sleep 3
fi

echo "=== 启动 D-Bus（系统总线） ==="
mkdir -p /run/dbus
chown messagebus:messagebus /run/dbus 2>/dev/null || true
rm -rf /run/dbus/* || true
dbus-daemon --system --fork

echo "=== 启动会话 D-Bus ==="
dbus-launch --exit-with-session &

echo "=== 启动 Fcitx 输入法 ==="
sleep 2

# 确保用户目录有正确的配置（从 /etc/skel 复制）
if [ ! -d /app/puppeteer_user_data/.config/fcitx ]; then
    mkdir -p /app/puppeteer_user_data/.config
    cp -r /etc/skel/.config/fcitx /app/puppeteer_user_data/.config/
fi

# 避免 XFCE autostart 再次拉起 fcitx，导致重复启动告警
rm -f /app/puppeteer_user_data/.config/autostart/fcitx.desktop 2>/dev/null || true

# 启动 Fcitx（如果已运行则先杀掉）
pkill fcitx 2>/dev/null || true
fcitx -d 2>/dev/null || true

sleep 3

# 强制设置当前会话的输入法为五笔拼音
fcitx-remote -s wbpy 2>/dev/null || true

echo "=== 启动桌面环境 (xfce4) ==="
startxfce4 &
sleep 3

echo "=== 设置 VNC 密码并启动 VNC ==="
mkdir -p ~/.vnc
PASSWORD=${VNC_PASSWORD:-zf123456}
x11vnc -storepasswd $PASSWORD ~/.vnc/passwd
echo "启动 x11vnc..."
x11vnc -display :99 -forever -usepw -rfbauth ~/.vnc/passwd -rfbport 5900 -shared -noxdamage &

# 等待 VNC 服务就绪
echo "等待 VNC 服务启动（最大 10 秒）..."
for i in {1..10}; do
    if timeout 1 bash -c "cat < /dev/null > /dev/tcp/localhost/5900" 2>/dev/null; then
        echo "VNC 服务已在端口 5900 上就绪"
        break
    fi
    echo "等待 VNC 服务... ($i/10)"
    sleep 1
done

echo "=== 启动 noVNC (Web 访问) ==="
echo "启动 noVNC 代理，监听 0.0.0.0:6080，连接到 localhost:5900..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 0.0.0.0:6080 --web /opt/novnc --heartbeat 30 &
sleep 2

if timeout 1 bash -c "cat < /dev/null > /dev/tcp/localhost/6080" 2>/dev/null; then
    echo "noVNC 服务已在端口 6080 上就绪"
else
    echo "警告：noVNC 服务可能未启动，端口 6080 未监听"
fi

echo "=== 检查服务状态 ==="
echo "1. 检查进程："
if pgrep -x Xvfb >/dev/null; then echo "   ✓ Xvfb 正在运行"; else echo "   ✗ Xvfb 未运行"; fi
if pgrep -x x11vnc >/dev/null; then echo "   ✓ x11vnc 正在运行"; else echo "   ✗ x11vnc 未运行"; fi
if pgrep -f "novnc_proxy" >/dev/null; then echo "   ✓ noVNC 代理正在运行"; else echo "   ✗ noVNC 代理未运行"; fi
if pgrep -f "fcitx" >/dev/null; then echo "   ✓ Fcitx 输入法正在运行"; else echo "   ✗ Fcitx 未运行（五笔可能不可用）"; fi

echo "2. 检查端口监听："
if netstat -tuln | grep -q ":5900 "; then echo "   ✓ 端口 5900 (VNC) 已监听"; else echo "   ✗ 端口 5900 未监听"; fi
if netstat -tuln | grep -q ":6080 "; then echo "   ✓ 端口 6080 (noVNC) 已监听"; else echo "   ✗ 端口 6080 未监听"; fi

echo "=== 启动 HTTP 触发服务器（内部端口 3001） ==="
export TRIGGER_PORT=3001
node /app/scripts/trigger-server.js &
sleep 3

echo "=== 启动反向代理（公网端口 3000） ==="
node /app/scripts/proxy.js &

echo "所有服务已启动，容器持续运行中"

tail -f /dev/null