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
import { JobManager } from './job-manager.js';
import { createAuthMiddleware } from '../utils/auth.js';
import { BrowserPool } from '../utils/browser-pool.js';
import type { ServerConfig, ScrapeRequest, FeedEntry, ScrapeOptions } from '../interfaces/index.js';
import { FeedMonitor } from './feed-monitor.js';

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
    validateConfig(userConfig);
    return { ...defaultConfig, ...userConfig };
  } catch {
    console.log('[Server] No config.json found, using defaults');
    return defaultConfig;
  }
}

function validateConfig(config: Record<string, unknown>): void {
  if (config.port !== undefined && (typeof config.port !== 'number' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) {
    throw new Error('Invalid config: port must be an integer between 1 and 65535');
  }
  if (config.pluginsDir !== undefined && typeof config.pluginsDir !== 'string') {
    throw new Error('Invalid config: pluginsDir must be a string');
  }
  if (config.hotReload !== undefined && typeof config.hotReload !== 'boolean') {
    throw new Error('Invalid config: hotReload must be a boolean');
  }
  if (config.corsOrigin !== undefined && typeof config.corsOrigin !== 'boolean' && typeof config.corsOrigin !== 'string') {
    throw new Error('Invalid config: corsOrigin must be a boolean or string');
  }
  if (config.auth !== undefined && typeof config.auth !== 'object') {
    throw new Error('Invalid config: auth must be an object');
  }
  if (config.defaultOptions !== undefined && typeof config.defaultOptions !== 'object') {
    throw new Error('Invalid config: defaultOptions must be an object');
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

  // 初始化浏览器池
  const browserPool = new BrowserPool();

  // 初始化任务管理器
  const jobManager = new JobManager(
    { pluginManager, cookieManager },
    10
  );

  // 初始化 Feed Monitor
  const feedMonitor = new FeedMonitor(
    { pluginManager, cookieManager, browserPool },
    './cache/feeds.json'
  );
  await feedMonitor.initialize();

  // 创建 Fastify 实例
  const app = Fastify({
    logger: false
  });

  // 注册 CORS — 默认不允许跨域，可通过 config.corsOrigin 配置
  const corsOrigin = config.corsOrigin ?? false;
  await app.register(cors, {
    origin: corsOrigin
  });

  // 注册认证中间件
  const authMiddleware = createAuthMiddleware(config.auth);
  app.addHook('onRequest', authMiddleware);

  // 依赖可用性检查
  async function checkDependency(cmd: string, args: string[]): Promise<boolean> {
    try {
      const { spawn } = await import('child_process');
      return new Promise((resolve) => {
        const proc = spawn(cmd, args, { stdio: 'ignore' });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
      });
    } catch {
      return false;
    }
  }

  // 健康检查端点
  app.get('/health', async () => {
    const [ytDlp, ffmpeg, whisper, playwright] = await Promise.all([
      checkDependency('yt-dlp', ['--version']),
      checkDependency('ffmpeg', ['-version']),
      checkDependency('whisper-cli', ['-h']),
      checkDependency('npx', ['playwright', '--version']).catch(() => false),
    ]);

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      dependencies: {
        ytDlp,
        ffmpeg,
        whisperCli: whisper,
        playwright,
      },
    };
  });

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

  // 创建异步刮削任务
  app.post('/api/scrape', async (request, reply) => {
    const body = request.body as ScrapeRequest;

    // 验证 urls 字段
    if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
      reply.code(400);
      return { success: false, error: 'Missing or invalid "urls" field' };
    }

    if (body.urls.length > 50) {
      reply.code(400);
      return { success: false, error: 'Too many URLs (max 50)' };
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
      } catch (err) { console.warn('[Server] Warning:', err);
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

    // 合并选项，传入 debug 模式和浏览器池
    const options = { ...config.defaultOptions, ...body.options, debug: isDebugMode, browserPool };

    // 创建异步任务
    const job = jobManager.createJob(body.urls, options);
    jobManager.startJob(job.id);

    reply.code(202); // Accepted
    return {
      jobId: job.id,
      status: job.status,
      message: 'Job accepted, use GET /api/jobs/:jobId to poll status',
    };
  });

  // 列出所有任务（可选按状态过滤）
  app.get('/api/jobs', async (request) => {
    const query = request.query as { status?: string };
    const jobs = jobManager.listJobs(
      query.status ? { status: query.status as any } : undefined
    );
    return {
      total: jobs.length,
      jobs: jobs.map((j) => ({
        jobId: j.id,
        status: j.status,
        progress: j.progress,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        completedAt: j.completedAt,
      })),
    };
  });

  // 查询单个任务状态
  app.get('/api/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = jobManager.getJob(jobId);

    if (!job) {
      reply.code(404);
      return { success: false, error: 'Job not found' };
    }

    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      results: job.results,
      errors: job.errors.length > 0 ? job.errors : undefined,
    };
  });

  // 取消任务
  app.delete('/api/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const result = jobManager.cancelJob(jobId);

    if (!result.success) {
      reply.code(400);
    }

    return result;
  });

  // 重试任务
  app.post('/api/jobs/:jobId/retry', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const newJob = jobManager.retryJob(jobId);

    if (!newJob) {
      reply.code(404);
      return { success: false, error: 'Job not found' };
    }

    return {
      success: true,
      jobId: newJob.id,
      message: 'Job retry started',
    };
  });

  // ---- Feed Monitor 路由 ----

  // 添加订阅
  app.post('/api/feeds', async (request, reply) => {
    const body = request.body as { url?: string };

    if (!body.url || typeof body.url !== 'string') {
      reply.code(400);
      return { success: false, error: 'Missing or invalid "url" field' };
    }

    try {
      new URL(body.url);
    } catch {
      reply.code(400);
      return { success: false, error: `Invalid URL: ${body.url}` };
    }

    try {
      const feed = feedMonitor.addFeed(body.url);
      return { success: true, feed };
    } catch (err) {
      reply.code(400);
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  // 列出所有订阅
  app.get('/api/feeds', async () => ({
    feeds: feedMonitor.listFeeds(),
  }));

  // 删除订阅
  app.delete('/api/feeds', async (request, reply) => {
    const body = request.body as { url?: string };

    if (!body.url || typeof body.url !== 'string') {
      reply.code(400);
      return { success: false, error: 'Missing or invalid "url" field' };
    }

    const removed = feedMonitor.removeFeed(body.url);
    if (!removed) {
      reply.code(404);
      return { success: false, error: 'Feed not found' };
    }

    return { success: true };
  });

  // 检查订阅（不传 url 则检查全部）
  app.post('/api/feeds/check', async (request, reply) => {
    const body = request.body as { url?: string; options?: ScrapeOptions };

    const options = { ...config.defaultOptions, ...body.options, debug: isDebugMode, browserPool };

    try {
      if (body.url) {
        const result = await feedMonitor.checkFeed(body.url, options);
        return { success: true, results: [result] };
      } else {
        const results = await feedMonitor.checkAll(options);
        return { success: true, results };
      }
    } catch (err) {
      reply.code(400);
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
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

  // 优雅关闭
  const gracefulShutdown = async (signal: string) => {
    console.log(`[Server] Received ${signal}, shutting down gracefully...`);
    jobManager.destroy();
    pluginManager.unwatch();
    await browserPool.destroy();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(console.error);
