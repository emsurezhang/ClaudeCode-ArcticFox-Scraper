/**
 * 认证中间件 - 可配置 token 验证
 */

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import type { ServerConfig } from '../interfaces/index.js';

type AuthMiddleware = (
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
) => void | Promise<void>;

/**
 * 创建认证中间件
 * @param config 认证配置
 * @returns Fastify 中间件函数
 */
export function createAuthMiddleware(
  config: ServerConfig['auth']
): AuthMiddleware {
  // 如果 token 未配置或为空，返回空中间件（允许所有请求）
  if (!config?.token) {
    console.log('[Auth] Authentication disabled (no token configured)');
    return async (_request, _reply) => {
      // 不执行验证
    };
  }

  const headerName = config.headerName || 'x-api-token';
  const expectedToken = config.token;

  console.log(`[Auth] Authentication enabled (header: ${headerName})`);

  return async (request, reply) => {
    const token = request.headers[headerName] || request.headers[headerName.toLowerCase()];

    if (!token) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: `Missing ${headerName} header`
      });
      return;
    }

    if (token !== expectedToken) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid token'
      });
      return;
    }
  };
}

/**
 * 检查是否需要认证
 * @param config 认证配置
 * @returns 是否需要认证
 */
export function isAuthEnabled(config: ServerConfig['auth']): boolean {
  return !!config?.token;
}
