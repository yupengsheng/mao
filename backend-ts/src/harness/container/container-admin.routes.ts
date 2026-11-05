import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../../common/http-error.js';
import type { ContainerOps } from './container-registry.js';
import type { CloudRuntimeMode } from './runtime-mode.js';

export interface AdminContainerRouteDeps {
  containerOps: ContainerOps;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  /** 当前生效的全局运行时模式（host / docker），由 RuntimeModeResolver 提供。 */
  runtimeModeOf: () => Promise<CloudRuntimeMode>;
}

/**
 * 管理后台容器运维（Docker 模式）：
 * - `GET /v1/admin/containers`：在册容器列表（后台「容器管理」区块的数据源，
 *   也是「重建全部」的前端遍历来源）。
 * - `GET /v1/admin/runtime-environment`：运行环境只读状态（镜像 / 依赖指纹 /
 *   最近预检 / 在线容器连接），供「系统设置 → 运行环境」健康状态行展示。
 *
 * 单用户重建在 user.routes（`POST /v1/users/:id/container/recycle`）。
 * 三个路径分别命中审计拦截器既有前缀 `/v1/admin`、`/v1/users`，变更操作自动留痕。
 * 容器列表 / 重建用 `container:manage`（V177，默认授予管理员角色）；运行环境只读状态
 * 与「系统设置」同权限，使用 `settings:read`。
 */
export function registerAdminContainerRoutes(app: FastifyInstance, deps: AdminContainerRouteDeps): void {
  app.get('/v1/admin/containers', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(deps.permissionService, userId, 'container:manage');
    return sendOk(reply, deps.containerOps.listEntries());
  });

  // 只读状态页与「系统设置」同权限；不触发预检，避免刷新页面放大 Docker 开销。
  app.get('/v1/admin/runtime-environment', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(deps.permissionService, userId, 'settings:read');
    const [mode, environment] = await Promise.all([
      deps.runtimeModeOf(),
      deps.containerOps.getRuntimeEnvironment(),
    ]);
    return sendOk(reply, { mode, ...environment });
  });
}
