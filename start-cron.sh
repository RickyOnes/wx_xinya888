#!/bin/bash
set -e

# 容器启动脚本 - 支持三种访问/触发方式：
# 1. 直接 VNC 连接（端口 5900，密码通过 VNC_PASSWORD 环境变量设置，默认 zf123456）
# 2. Web 访问 noVNC（端口 6080）
# 3. HTTP 触发服务器（端口 3000）

# 加载全局环境变量（确保 fcitx 生效）
source /etc/profile.d/fcitx.sh

echo "=== 清理旧的 X 环境 ==="
# 杀死可能残留的 Xvfb 和 x11vnc 进程
pkill -9 Xvfb 2>/dev/null || true
pkill -9 x11vnc 2>/dev/null || true
# 删除锁文件和 Unix socket
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
sleep 1

echo "=== 启动 Xvfb ==="
Xvfb :99 -screen 0 1280x720x16 -ac +extension GLX +render -noreset &
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
PASSWORD=${VNC_PASSWORD:-zf123456}
VNC_PASSWD_DIR="/app/puppeteer_user_data/.vnc"
VNC_PASSWD_FILE="${VNC_PASSWD_DIR}/passwd"
mkdir -p "$VNC_PASSWD_DIR"
x11vnc -storepasswd "$PASSWORD" "$VNC_PASSWD_FILE"
echo "启动 x11vnc..."
x11vnc -display :99 -forever -rfbauth "$VNC_PASSWD_FILE" -rfbport 5900 -shared -noxdamage &

# 等待 VNC 服务就绪
echo "等待 VNC 服务启动（最大 10 秒）..."
for i in $(seq 1 10); do
    if netstat -tuln | grep -q ":5900 "; then
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

if netstat -tuln | grep -q ":6080 "; then
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