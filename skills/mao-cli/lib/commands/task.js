'use strict';

const { createCliError, requireNumber, optionalString, optionalNumber, hasHelp } = require('../args');
const { request } = require('../http');
const { outputResult } = require('../output');

const HELP = `用法:
  mao task list [--stage] [--source] [--agent-id] [--session-id] [--page] [--size]
  mao task get --id <id>

查询当前用户的执行任务记录。需使用用户 JWT；执行开始后才建立记录。
`;

async function handle(ctx) {
  const { subcommand, flags, globals } = ctx;
  if (!subcommand || hasHelp(flags)) {
    process.stdout.write(HELP);
    return;
  }
  const common = { baseUrl: globals.baseUrl, token: globals.token, timeoutMs: globals.timeoutMs };
  switch (subcommand) {
    case 'list': {
      const result = await request({
        ...common,
        method: 'GET',
        path: '/tasks',
        query: {
          stage: optionalString(flags, 'stage'),
          source: optionalString(flags, 'source'),
          agentId: optionalNumber(flags, 'agent-id'),
          sessionId: optionalNumber(flags, 'session-id'),
          page: optionalNumber(flags, 'page'),
          size: optionalNumber(flags, 'size'),
        },
      });
      outputResult(result, globals);
      return;
    }
    case 'get': {
      const id = requireNumber(flags, 'id', '任务 ID');
      const result = await request({ ...common, method: 'GET', path: `/tasks/${id}` });
      outputResult(result, globals);
      return;
    }
    default:
      throw createCliError(`未知 task 子命令: ${subcommand}\n${HELP}`);
  }
}

module.exports = { handle, help: () => HELP };
