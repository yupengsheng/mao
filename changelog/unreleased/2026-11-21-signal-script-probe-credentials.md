## 后端
- **为脚本哨兵注入 Shell 同款凭据**：host 与 Docker 模式每次探针现取 MAO_TOKEN、ECP_TOKEN、Git 凭据、Lark UAT、站点地址和三级环境变量；Docker 通过脚本探针帧下发并在容器侧再次执行白名单过滤，旧运行时仍按无凭据兼容运行。
