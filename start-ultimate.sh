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

echo "=== 启动 RustDesk 服务端 ==="
/rustdesk-server/hbbs -r $PUBLIC_IP:21117 &
/rustdesk-server/hbbr &
sleep 5

# 显示 Key
KEY=$(cat /root/id_ed25519.pub 2>/dev/null)
if [ -z "$KEY" ]; then
    echo "等待密钥生成..."
    sleep 5
    KEY=$(cat /root/id_ed25519.pub 2>/dev/null)
fi
echo "RustDesk Key: $KEY"

echo "=== 启动 RustDesk 客户端 ==="
# 设置密码（从环境变量获取，默认 rustdesk123）
/usr/bin/rustdesk --password ${RUSTDESK_PASSWORD:-rustdesk123} &
/usr/bin/rustdesk --service &
sleep 3

ID=$(/usr/bin/rustdesk --get-id)
echo "======================================"
echo "✅ RustDesk ID: $ID"
echo "✅ RustDesk Password: ${RUSTDESK_PASSWORD:-rustdesk123}"
echo "✅ RustDesk Server: $PUBLIC_IP"
echo "✅ RustDesk Key: $KEY"
echo "======================================"

echo "=== 启动 noVNC (备用) ==="
mkdir -p ~/.vnc
x11vnc -storepasswd zf123456 ~/.vnc/passwd
x11vnc -display :99 -forever -usepw -rfbauth ~/.vnc/passwd &
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &

# 如果设置了 RUN_CRAWLER=true，则运行爬虫
if [ "$RUN_CRAWLER" = "true" ]; then
    echo "=== 运行爬虫脚本 ==="
    cd /app
    # 传入必要的环境变量（SUPABASE_URL 等已在容器环境中）
    node scripts/update-pdd-new.js
    echo "爬虫运行完毕，容器将继续运行"
fi

echo "所有服务已启动，容器持续运行中"
tail -f /dev/null