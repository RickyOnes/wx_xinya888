#!/bin/bash
set -e

echo "=== 获取公网IP ==="
PUBLIC_IP=$(curl -s ifconfig.me)
echo "公网IP: $PUBLIC_IP"

echo "=== 启动 Xvfb ==="
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

echo "=== 启动 D-Bus ==="
dbus-launch --exit-with-session &

echo "=== 启动桌面环境 (xfce4) ==="
startxfce4 &

# 配置 RustDesk 客户端（如果提供了服务器信息）
if [ -n "$RUSTDESK_SERVER" ] && [ -n "$RUSTDESK_KEY" ]; then
    echo "=== 配置 RustDesk 客户端 ==="
    PASSWORD="${RUSTDESK_PASSWORD:-rustdesk123}"
    /usr/bin/rustdesk --password "$PASSWORD"
    sleep 2
    /usr/bin/rustdesk --server "$RUSTDESK_SERVER" --key "$RUSTDESK_KEY"
    sleep 2
    /usr/bin/rustdesk --service &
    sleep 3
    ID=$(/usr/bin/rustdesk --get-id)
    echo "======================================"
    echo "✅ RustDesk ID: $ID"
    echo "✅ RustDesk Password: $PASSWORD"
    echo "✅ RustDesk Server: $RUSTDESK_SERVER"
    echo "✅ RustDesk Key: $RUSTDESK_KEY"
    echo "======================================"
else
    echo "⚠️ 未设置 RUSTDESK_SERVER 和 RUSTDESK_KEY，RustDesk 客户端未启动"
fi

echo "=== 启动 noVNC (备用) ==="
mkdir -p ~/.vnc
x11vnc -storepasswd vncpassword ~/.vnc/passwd
x11vnc -display :99 -forever -usepw -rfbauth ~/.vnc/passwd &
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &

# 如果设置了 RUN_CRAWLER=true，则运行爬虫
if [ "$RUN_CRAWLER" = "true" ]; then
    echo "=== 运行爬虫脚本 ==="
    cd /app
    node scripts/update-pdd-new.js
    echo "爬虫运行完毕，容器将继续运行"
fi

echo "所有服务已启动，容器持续运行中"
tail -f /dev/null