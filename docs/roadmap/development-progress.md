# Mao 开发进度（历史归档）

> 2026-11-05 复核：本文保留的是 2026-05-20 的 Java / Spring Boot 阶段记录，已不再维护，也不代表当前实现，请勿据此排期。

## 归档说明

本文件最初记录的是旧后端阶段：Java 17、Spring Boot、Maven、MyBatis-Plus、SSE 流式输出，以及当时创建的 24 张表。该实现后来已由 `backend-ts` 重写，相关路径、技术栈、端口和数据库迁移均已失效。

当前信息以以下文件为准：

- 产品定位、启动方式与能力总览：`README.md`
- 仓库约束、架构与开发命令：`AGENTS.md`
- 用户可见变更与发版记录：`CHANGELOG.md`
- 部署与上线：`DEPLOY.md`
- 专项设计与实施边界：`docs/plan/`
- 日常使用问答：`skills/mao-cli/SKILL.md`

## 当前架构

- 五端：`backend-ts`、`admin`、`desktop`（Electron / Web）、`android`、`agent-cli`（`mao-agent`）。
- 后端：NestJS + Fastify，默认 `:9080`，API 前缀 `/api/v1/`，统一返回 `Result<T>`（`code=0`）。
- 实时链路：WebSocket `/api/ws/stream`，不再使用旧文档中的 SSE。
- 执行模式：CLOUD 由服务端执行；LOCAL 通过 WebSocket 委托 Electron 执行。
- 引擎：`backend-ts/src/harness/`，包含 AgentLoop、PromptEngine、ContextManager / CompactionService、ToolDispatcher / ToolRegistry、LlmAdapter、delegate 与 skill。
- 数据库：MySQL 8 + Flyway，迁移位于 `backend-ts/db/migration/`，由 TS 服务启动时执行；截至 2026-11-05 最新迁移为 `V199`。
- 生产路由：桌面 `/`、管理后台 `/admin/`、API `/api/`、上传 `/uploads/`。

## 历史阶段结果

旧文档记录的四阶段均已于 2026-05-20 完成验收，仅作为演进历史保留：

| 阶段 | 主题 | 历史结论 |
|---|---|---|
| Phase 1 | MVP：模型配置、Agent、会话、流式输出、消息持久化 | 已完成 |
| Phase 2 | Skills、MCP、Agent Hub、RBAC | 已完成 |
| Phase 3 | 审计、文件、飞书 / LDAP、统计、系统配置 | 已完成 |
| Phase 4 | Hub 评分评论、分析报表、开放 API、上下文压缩、通知 | 已完成 |

历史验收不等于当前能力边界。新增能力、行为变化与已知限制请查阅根 `CHANGELOG.md` 及对应设计文档。
