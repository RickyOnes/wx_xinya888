#!/bin/bash
# 启动虚拟显示
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

# 启动桌面环境
startxfce4 &

# 启动 VNC 服务器
x11vnc -display :99 -forever -usepw -rfbauth ~/.vnc/passwd &

# 启动 noVNC (将 VNC 转为 Web 访问)
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &

# 保持容器运行
tail -f /dev/null