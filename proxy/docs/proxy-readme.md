Squid 正向代理部署说明（用于 ClawCloud 的 TCP 公网映射）

概述
如果你在 ClawCloud 控制台看到应用的 Public Address 以 tcp:// 开头（例如 tcp://tcp.us-east-1.clawcloudrun.com:31309），说明平台为该应用提供了原始 TCP 公网入口。你可以在该应用上运行 Squid，作为一个带认证的 HTTP(S) 代理，满足在本地访问 Google 并在 Chrome 中登录的需求。

仓库内相关文件
- `docker/squid/Dockerfile`：构建镜像用的 Dockerfile。
- `docker/squid/entrypoint.sh`：容器启动脚本（使用环境变量创建认证用户）。
- `examples/squid.conf`：推荐的 Squid 配置，仅允许 Google 相关域名并要求认证。

部署步骤（摘要）
1. 在 ClawCloud App Launchpad 新建或编辑应用，把容器端口设置为 `3128`。
2. 使用本仓库的 `docker/squid` 构建镜像并在平台上部署，或本地构建并推到 Docker Hub，然后在平台填入镜像地址。
3. 在应用环境变量中设置：
   - PROXY_USER
   - PROXY_PASS
4. 启动应用并记录平台给出的 Public Address（形如 tcp://tcp.<region>.clawcloudrun.com:<port>）。

DNS（可选）
你可以创建 CNAME，例如把 `proxy.xinya888.abrdns.com` 指向 `tcp.us-east-1.clawcloudrun.com`，但注意 DNS 不包含端口，客户端仍需在代理设置中指定平台分配的公网端口（例如 :31309）。

测试与验证
在本地确认 TCP 连通性（PowerShell）：
    Test-NetConnection tcp.us-east-1.clawcloudrun.com -Port 31309

使用 curl 测试代理（示例）：
    curl -x http://PROXY_USER:PROXY_PASS@tcp.us-east-1.clawcloudrun.com:31309 -I https://accounts.google.com -v

Chrome 使用
- 在系统代理中设置 HTTP 代理为 `proxy.xinya888.abrdns.com`（或直接使用平台 host）和端口（平台分配的公网端口）。
- 如果出现 QUIC/UDP 相关问题，请在 Chrome 中禁用 QUIC：chrome://flags/#enable-quic -> Disabled，然后重启浏览器。

安全建议
- 使用强密码并仅在可信网络下共享凭据。
- 在 Squid 配置中只允许必要的目标域名以减少滥用。
- 若对凭据安全有更高要求，请使用 TLS 隧道或 SSH 隧道将代理流量封装。

说明与注意事项
- 如果你当前部署的 image 是 `nginx`（hello-world），请把镜像替换为上面构建的 Squid 镜像；`nginx` 本身不能作为 CONNECT 代理。
- ClawCloud 平台通常会分配一个公网端口（非 3128），客户端必须使用该端口。

需要我帮忙部署或测试吗？如果你把平台分配的 Public Address（例如 tcp://tcp.us-east-1.clawcloudrun.com:31309）发给我，并确认能 SSH/控制台访问该应用配置界面，我可以帮你：
- 在仓库中构建镜像并给出可直接粘贴到 ClawCloud 的镜像地址和环境变量。
- 或直接生成一键部署脚本并帮你验证 curl/Chrome 登录流程。
