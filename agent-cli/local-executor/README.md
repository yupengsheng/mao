# LOCAL 模式本机工具执行

`mao-agent --local` 把 CLI 当成 Electron 主进程：接收 `tool_execute` / `skill_sync_required` / `mcp_sync_required`，在本机执行后回 `tool_result` / `tool_error` / `skill_sync_done` / `mcp_tools_report`。

实现位于 `agent-cli/src/local/`。`shell` 优先 `require` 包内 `vendor/localShell.cjs`（与 `desktop/electron/localShell.cjs` 保持一致），独立安装时不必带上整个仓库。

后端前置：`LOCAL_CAPABLE_CLIENTS = { electron, cli }`（`streaming-ws-registry.ts`）。新后端在该场景回中文「本地执行端未连接，请确保桌面客户端正在运行」；更早的后端回英文 `Local client is not connected`。

## 常驻形态与附着形态

`mao-agent --local` 是附着形态：一个进程服务一个会话，事件先过 `acceptEvent`，再交给随会话创建的 `LocalExecutor`。`mao-agent local --serve` 是常驻形态：不创建 `SessionRunner`、不 subscribe、不过 `acceptEvent`，唯一的 `LocalExecutor` 接收本设备全部 LOCAL 会话的 `tool_execute` / `skill_sync_required` / `mcp_sync_required` / `tool_approval_resolved`。

审批上，附着形态仍是 TTY 询问或立即拒绝；常驻形态默认 `--on-approval=remote`（等其他端投票，默认 300 秒超时），TTY 位钉死，不会读 stdin。远端「总是允许」只放行这一次，不写入进程级免审表。

执行连接仍是同设备最后连上的那条。桌面端后启动会从 daemon 手里夺回，桌面端关闭后 `releaseDevice` 回坐到仍在线的 daemon。一个设备只跑一个常驻执行端。用户说明见 [mao-agent.md](../../skills/mao-cli/reference/mao-agent.md)。

## 连接故障与超时

- 设备没有可写连接时，后端投递阶段即返回「本地执行端未连接」，不会进入等待。
- 无审批请求有 60 秒 ack 兜底：下发后既没收到 `tool_approval`（无需审批时的空表态）也没收到结果，即判定执行通道半死，收敛服务端 pending 并提示「本地执行端未响应」；长时间运行的命令在 ack 到达后仍按总超时（默认 900 秒）执行。
- 需审批请求不走 ack 兜底，由审批卡片超时 / 升级通知控制；审批通过后按总超时等待结果。
- 同一设备存在多条 WS 连接时，主执行连接不可写会回退到同 `userId + deviceId` 的另一条存活连接，避免整台设备被误判离线。
