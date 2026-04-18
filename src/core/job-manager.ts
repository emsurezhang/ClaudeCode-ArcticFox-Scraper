/**
 * 异步刮削任务管理器
 * 基于内存的轻量任务队列，支持状态追踪和进度上报
 */

import type { ScrapeJob, ScrapeResult, ScrapeOptions, IPlatformPlugin } from '../interfaces/index.js';

interface JobManagerDeps {
  pluginManager: { findPluginForUrl(url: string): IPlatformPlugin | undefined };
  cookieManager: { getOrExtract(platform: string, browser: string): Promise<string> };
}

export class JobManager {
  private jobs = new Map<string, ScrapeJob>();
  private readonly deps: JobManagerDeps;
  private readonly maxActiveJobs: number;
  private activeCount = 0;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(deps: JobManagerDeps, maxActiveJobs = 10) {
    this.deps = deps;
    this.maxActiveJobs = maxActiveJobs;
    // 每 10 分钟清理一次过期任务
    this.cleanupTimer = setInterval(() => this.cleanupOldJobs(60 * 60 * 1000), 10 * 60 * 1000);
  }

  /**
   * 创建任务
   */
  createJob(urls: string[], options: ScrapeOptions): ScrapeJob {
    const job: ScrapeJob = {
      id: this.generateId(),
      status: 'pending',
      urls,
      options,
      results: [],
      errors: [],
      progress: { total: urls.length, done: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  /**
   * 获取任务
   */
  getJob(id: string): ScrapeJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * 启动任务（异步执行）
   */
  startJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'pending') return;

    if (this.activeCount >= this.maxActiveJobs) {
      job.status = 'failed';
      job.errors.push({ url: '', error: 'Too many active jobs, please try again later' });
      job.updatedAt = new Date().toISOString();
      return;
    }

    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    this.activeCount++;

    // 在下一个事件循环启动，避免阻塞当前请求
    setImmediate(() => this.runJob(job));
  }

  /**
   * 执行任务核心逻辑
   */
  private async runJob(job: ScrapeJob): Promise<void> {
    const { options } = job;
    const isListMode = options.mode === 'list';

    try {
      if (isListMode) {
        // list 模式：并行处理
        await this.runParallel(job);
      } else {
        // detail 模式：串行处理（避免 Whisper 资源冲突）
        await this.runSequential(job);
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
    } catch (err) {
      console.error(`[JobManager] Job ${job.id} failed:`, err);
      job.status = 'failed';
      job.errors.push({
        url: '',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      this.activeCount--;
      job.updatedAt = new Date().toISOString();
    }
  }

  /**
   * 并行处理（list 模式）
   */
  private async runParallel(job: ScrapeJob): Promise<void> {
    const { urls, options } = job;

    const promises = urls.map(async (url) => {
      try {
        const result = await this.scrapeUrl(url, options);
        job.results.push(result);
      } catch (err) {
        job.errors.push({
          url,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
      job.progress.done++;
      job.updatedAt = new Date().toISOString();
    });

    await Promise.all(promises);
  }

  /**
   * 串行处理（detail 模式）
   */
  private async runSequential(job: ScrapeJob): Promise<void> {
    const { urls, options } = job;

    for (const url of urls) {
      try {
        const result = await this.scrapeUrl(url, options);
        job.results.push(result);
      } catch (err) {
        job.errors.push({
          url,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
      job.progress.done++;
      job.updatedAt = new Date().toISOString();
    }
  }

  /**
   * 刮削单个 URL
   */
  private async scrapeUrl(url: string, options: ScrapeOptions): Promise<ScrapeResult> {
    const plugin = this.deps.pluginManager.findPluginForUrl(url);
    if (!plugin) {
      throw new Error('Unsupported platform');
    }

    if (plugin.capabilities.scrapeMetadata || plugin.capabilities.scrapeContent) {
      await this.deps.cookieManager.getOrExtract(plugin.name, options.browser || 'chrome');
    }

    return plugin.scrape(url, options);
  }

  /**
   * 清理过期任务
   */
  cleanupOldJobs(maxAgeMs: number): void {
    const now = Date.now();
    let count = 0;

    for (const [id, job] of this.jobs) {
      const updated = new Date(job.updatedAt).getTime();
      if (now - updated > maxAgeMs) {
        this.jobs.delete(id);
        count++;
      }
    }

    if (count > 0) {
      console.log(`[JobManager] Cleaned up ${count} expired jobs`);
    }
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
