/**
 * Fastify API 服务器入口
 * 用法: npm start [-- --debug]
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { PluginManager } from './plugin-manager.js';
import { CookieManager } from './cookie-manager.js';
import { createAuthMiddleware } from '../utils/auth.js';
import type { ServerConfig, ScrapeRequest, ScrapeResponse, ScrapeResult } from '../interfaces/index.js';

// 解析命令行参数
const args = process.argv.slice(2);
const isDebugMode = args.includes('--debug');

if (isDebugMode) {
  console.log('[Server] Debug mode enabled - Playwright browsers will be visible');
}

// 默认配置
const defaultConfig: ServerConfig = {
  port: 3000,
  pluginsDir: './plugins',
  hotReload: true,
  defaultOptions: {
    downloadAudio: false,
    extractTranscript: false,
    browser: 'chrome',
    timeout: 60000
  },
  cookieCache: {
    cacheDir: './cache/cookies',
    ttlHours: 24,
    autoRefresh: true
  },
  network: {
    timeout: 60000,
    retryCount: 3
  }
};

// 加载配置文件
async function loadConfig(): Promise<ServerConfig> {
  try {
    const configPath = resolve(process.cwd(), 'config.json');
    const configContent = await readFile(configPath, 'utf-8');
    const userConfig = JSON.parse(configContent);
    return { ...defaultConfig, ...userConfig };
  } catch {
    console.log('[Server] No config.json found, using defaults');
    return defaultConfig;
  }
}

async function main() {
  // 加载配置
  const config = await loadConfig();

  // 初始化 Cookie 管理器
  const cookieManager = new CookieManager(config.cookieCache);
  await cookieManager.initialize();

  // 初始化插件管理器
  const pluginManager = new PluginManager();
  const pluginsDir = resolve(config.pluginsDir || './plugins');

  try {
    const plugins = await pluginManager.loadPluginsFromDirectory(pluginsDir);
    console.log(`[Server] Loaded ${plugins.length} plugins`);

    if (config.hotReload) {
      pluginManager.watch(pluginsDir);
    }
  } catch (err) {
    console.warn('[Server] Failed to load plugins:', err);
  }

  // 创建 Fastify 实例
  const app = Fastify({
    logger: false
  });

  // 注册 CORS — 默认不允许跨域，可通过 config.corsOrigin 配置
  const corsOrigin = (config as any).corsOrigin ?? false;
  await app.register(cors, {
    origin: corsOrigin
  });

  // 注册认证中间件
  const authMiddleware = createAuthMiddleware(config.auth);
  app.addHook('onRequest', authMiddleware);

  // 健康检查端点
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString()
  }));

  // 获取已加载插件列表
  app.get('/api/plugins', async () => ({
    plugins: pluginManager.getPluginInfos()
  }));

  // 热重载指定插件
  app.post('/api/plugins/:name/reload', async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      await pluginManager.reloadPlugin(name);
      return { success: true, message: `Plugin ${name} reloaded` };
    } catch (err) {
      reply.code(400);
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      };
    }
  });

  // 核心刮削端点
  app.post('/api/scrape', async (request, reply) => {
    const body = request.body as ScrapeRequest;

    // 验证 urls 字段
    if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
      reply.code(400);
      return {
        success: false,
        error: 'Missing or invalid "urls" field'
      };
    }

    if (body.urls.length > 50) {
      reply.code(400);
      return {
        success: false,
        error: 'Too many URLs (max 50)'
      };
    }

    // 验证每个 URL 格式
    for (const url of body.urls) {
      if (typeof url !== 'string') {
        reply.code(400);
        return { success: false, error: `Invalid URL type: ${typeof url}` };
      }
      try {
        const parsed = new URL(url);
        if (!parsed.protocol.startsWith('http')) {
          reply.code(400);
          return { success: false, error: `URL must use http/https: ${url}` };
        }
      } catch {
        reply.code(400);
        return { success: false, error: `Invalid URL format: ${url}` };
      }
    }

    // 验证 options 字段
    if (body.options) {
      if (body.options.maxItems !== undefined) {
        const n = body.options.maxItems;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000) {
          reply.code(400);
          return { success: false, error: 'Invalid maxItems (must be integer 1-1000)' };
        }
      }
      if (body.options.timeout !== undefined) {
        const t = body.options.timeout;
        if (typeof t !== 'number' || !Number.isInteger(t) || t < 1000 || t > 300000) {
          reply.code(400);
          return { success: false, error: 'Invalid timeout (must be integer 1000-300000ms)' };
        }
      }
      if (body.options.scrollStrategy !== undefined) {
        const s = body.options.scrollStrategy;
        if (!['min', 'max', 'all'].includes(s)) {
          reply.code(400);
          return { success: false, error: 'Invalid scrollStrategy (must be min/max/all)' };
        }
      }
    }

    // 合并选项，传入 debug 模式
    const options = { ...config.defaultOptions, ...body.options, debug: isDebugMode };

    const results: ScrapeResult[] = [];
    const errors: { url: string; error: string }[] = [];

    // 处理每个 URL
    for (const url of body.urls) {
      try {
        // 查找匹配的插件
        const plugin = pluginManager.findPluginForUrl(url);

        if (!plugin) {
          errors.push({ url, error: 'Unsupported platform' });
          continue;
        }

        console.log(`[Server] Scraping ${url} with ${plugin.name} plugin`);

        // 如果插件需要 cookies，提前准备好
        if (plugin.capabilities.scrapeMetadata || plugin.capabilities.scrapeContent) {
          // 提前获取 cookies（如果需要）
          await cookieManager.getOrExtract(plugin.name, options.browser || 'chrome');
        }

        // 执行刮削
        const result = await plugin.scrape(url, options);
        results.push(result);
      } catch (err) {
        console.error(`[Server] Failed to scrape ${url}:`, err);
        errors.push({
          url,
          error: err instanceof Error ? err.message : 'Unknown error'
        });
      }
    }

    const response: ScrapeResponse = {
      success: errors.length === 0,
      results,
      errors: errors.length > 0 ? errors : undefined
    };

    return response;
  });

  // 启动服务器
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
      if (!config.auth?.token) {
      console.warn('[Server] WARNING: API authentication is disabled. Set auth.token in config.json to secure the server.');
    }
    console.log(`[Server] Running on http://localhost:${config.port}`);
    console.log(`[Server] Plugins directory: ${pluginsDir}`);
    console.log(`[Server] Hot reload: ${config.hotReload ? 'enabled' : 'disabled'}`);
    console.log(`[Server] Debug mode: ${isDebugMode ? 'enabled' : 'disabled'}`);
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

main().catch(console.error);
