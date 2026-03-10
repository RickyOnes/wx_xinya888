#!/bin/bash
set -e  # 出错立即退出，便于排查

echo "=== 启动 Xvfb ==="
Xvfb :99 -screen 0 1280x800x24 &
sleep 2

echo "=== 启动 D-Bus ==="
dbus-launch --exit-with-session &

echo "=== 启动 LXDE 桌面 ==="
startlxde &

echo "=== 启动 VNC 服务器 ==="
x11vnc -display :99 -forever -usepw -rfbauth ~/.vnc/passwd &

echo "=== 启动 noVNC ==="
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &

echo "=== 所有服务已启动，保持容器运行 ==="
wait