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
# 优化参数：x11vnc -quality 6 -speed 5, noVNC --compress 0 --quality 6
#
# 部署到 clawcloud 后，可通过 Supabase Cron 定时调用 HTTP 触发服务器来执行爬虫任务。
# 设置环境变量 API_KEY 可启用授权保护，确保只有携带正确 Bearer Token 的请求才能触发爬虫。
# 详细配置示例参见 /app/scripts/trigger-server.js 文件顶部的注释。

echo "=== 启动 Xvfb ==="
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

echo "=== 启动 D-Bus ==="
dbus-launch --exit-with-session &

echo "=== 启动桌面环境 (xfce4) ==="
startxfce4 &

echo "=== 设置 VNC 密码并启动 VNC ==="
mkdir -p ~/.vnc
# 默认密码 vncpassword，可通过环境变量修改
PASSWORD=${VNC_PASSWORD:-zf123456}
x11vnc -storepasswd $PASSWORD ~/.vnc/passwd
x11vnc -display :99 -forever -quality 6 -speed 5 -usepw -rfbauth ~/.vnc/passwd &

echo "=== 启动 noVNC (Web 访问) ==="
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 --compress 0 --quality 6 &

echo "=== 启动 HTTP 触发服务器（Supabase Cron 调用） ==="
node /app/scripts/trigger-server.js &

# 如果设置了 RUN_CRAWLER=true，则运行爬虫
if [ "$RUN_CRAWLER" = "true" ]; then
    echo "=========================================="
    echo "CronJob 开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
    START_TIME=$(date +%s)

    # 运行爬虫脚本
    node /app/scripts/update-pdd-new.js
    EXIT_CODE=$?

    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    echo "CronJob 结束时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "总运行时长: ${DURATION} 秒"
    echo "退出码: ${EXIT_CODE}"
    echo "=========================================="
    # 保留原行为，不退出容器
    echo "爬虫运行完毕，容器将继续运行"
fi

echo "所有服务已启动，容器持续运行中"
tail -f /dev/null