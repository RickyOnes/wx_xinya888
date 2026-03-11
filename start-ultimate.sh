#!/bin/bash
set -e

echo "=== 启动 Xvfb ==="
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

echo "=== 启动 D-Bus ==="
dbus-launch --exit-with-session &

echo "=== 启动桌面环境 (xfce4) ==="
startxfce4 &

echo "=== 设置 VNC 密码并启动 VNC ==="
mkdir -p ~/.vnc
# 默认密码 vncpassword，可通过环境变量修改
PASSWORD=${VNC_PASSWORD:-vncpassword}
x11vnc -storepasswd $PASSWORD ~/.vnc/passwd
x11vnc -display :99 -forever -usepw -rfbauth ~/.vnc/passwd &

echo "=== 启动 noVNC (Web 访问) ==="
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