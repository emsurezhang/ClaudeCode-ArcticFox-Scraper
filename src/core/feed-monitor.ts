/**
 * Feed Monitor - 维护 URL 订阅列表，自动发现新内容并抓取详情
 *
 * 工作流程:
 * 1. list 模式拉取内容列表
 * 2. 与 knownIds 对比，筛选出新内容
 * 3. detail 模式串行抓取（避免 Whisper 资源冲突）并下载音频
 * 4. 更新 knownIds 并持久化
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import type {
  IPlatformPlugin,
  ScrapeOptions,
  ScrapeResult,
  FeedEntry,
  FeedCheckResult,
  FeedCheckItem,
  IBrowserPool,
} from '../interfaces/index.js';

interface FeedMonitorDeps {
  pluginManager: {
    findPluginForUrl(url: string): IPlatformPlugin | undefined;
  };
  cookieManager?: {
    getOrExtract(platform: string, browser: string): Promise<string>;
  };
  browserPool?: IBrowserPool;
}

interface FeedsData {
  feeds: FeedEntry[];
}

interface ListItem {
  id: string;
  url: string;
  title?: string;
  author?: string;
  publishedAt?: string;
}

export class FeedMonitor {
  private readonly deps: FeedMonitorDeps;
  private readonly dataPath: string;
  private feeds: FeedEntry[] = [];

  constructor(deps: FeedMonitorDeps, dataPath = './cache/feeds.json') {
    this.deps = deps;
    this.dataPath = resolve(dataPath);
  }

  async initialize(): Promise<void> {
    await this.loadFeeds();
  }

  private async loadFeeds(): Promise<void> {
    try {
      const content = await readFile(this.dataPath, 'utf-8');
      const data = JSON.parse(content) as FeedsData;
      this.feeds = data.feeds || [];
    } catch {
      this.feeds = [];
    }
  }

  private async saveFeeds(): Promise<void> {
    await mkdir(resolve(this.dataPath, '..'), { recursive: true });
    await writeFile(this.dataPath, JSON.stringify({ feeds: this.feeds }, null, 2));
  }

  addFeed(url: string): FeedEntry {
    const plugin = this.deps.pluginManager.findPluginForUrl(url);
    if (!plugin) {
      throw new Error(`Unsupported platform for URL: ${url}`);
    }

    if (this.feeds.some((f) => f.url === url)) {
      throw new Error('Feed already exists');
    }

    const feed: FeedEntry = {
      url,
      platform: plugin.name,
      addedAt: new Date().toISOString(),
      knownIds: [],
    };

    this.feeds.push(feed);
    this.saveFeeds().catch((err) => console.error('[FeedMonitor] Failed to save feeds:', err));
    return feed;
  }

  removeFeed(url: string): boolean {
    const idx = this.feeds.findIndex((f) => f.url === url);
    if (idx === -1) return false;
    this.feeds.splice(idx, 1);
    this.saveFeeds().catch((err) => console.error('[FeedMonitor] Failed to save feeds:', err));
    return true;
  }

  listFeeds(): FeedEntry[] {
    return this.feeds.map((f) => ({ ...f }));
  }

  async checkFeed(url: string, options?: ScrapeOptions): Promise<FeedCheckResult> {
    const feed = this.feeds.find((f) => f.url === url);
    if (!feed) {
      throw new Error('Feed not found');
    }

    const plugin = this.deps.pluginManager.findPluginForUrl(url);
    if (!plugin) {
      throw new Error(`Plugin not found for platform: ${feed.platform}`);
    }

    const checkedAt = new Date().toISOString();
    const listOptions: ScrapeOptions = {
      ...options,
      mode: 'list',
      browserPool: this.deps.browserPool,
    };

    let listResult: ScrapeResult;
    try {
      if (this.deps.cookieManager) {
        await this.deps.cookieManager.getOrExtract(plugin.name, options?.browser || 'chrome');
      }
      listResult = await plugin.scrape(url, listOptions);
    } catch (err) {
      return {
        url,
        platform: feed.platform,
        newCount: 0,
        newItems: [],
        errors: [{ url, error: err instanceof Error ? err.message : String(err) }],
        checkedAt,
      };
    }

    const items = this.extractItems(listResult);
    const newItems = items.filter((item) => !feed.knownIds.includes(item.id));

    console.log(`[FeedMonitor] ${url}: ${items.length} items, ${newItems.length} new`);

    const errors: { url: string; error: string }[] = [];
    const detailResults: FeedCheckItem[] = [];

    // 串行执行 detail 模式（避免 Whisper 资源冲突）
    for (const item of newItems) {
      try {
        const detailResult = await plugin.scrape(item.url, {
          ...options,
          mode: 'detail',
          downloadAudio: true,
          browserPool: this.deps.browserPool,
        });
        detailResults.push(this.toCheckItem(detailResult));
        console.log(`[FeedMonitor] Detail OK: ${item.url}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        errors.push({ url: item.url, error });
        console.error(`[FeedMonitor] Detail failed: ${item.url} - ${error}`);
      }
    }

    // 更新 knownIds（即使是失败的也记录，避免重复尝试）
    feed.knownIds.push(...newItems.map((i) => i.id));
    feed.lastCheckedAt = checkedAt;
    await this.saveFeeds();

    return {
      url,
      platform: feed.platform,
      newCount: detailResults.length,
      newItems: detailResults,
      errors: errors.length > 0 ? errors : undefined,
      checkedAt,
    };
  }

  async checkAll(options?: ScrapeOptions): Promise<FeedCheckResult[]> {
    const results: FeedCheckResult[] = [];
    for (const feed of this.feeds) {
      results.push(await this.checkFeed(feed.url, options));
    }
    return results;
  }

  private extractItems(result: ScrapeResult): ListItem[] {
    const videos = result.metadata?.videos as Array<{
      url?: string;
      videoId?: string;
      title?: string;
      author?: string;
      publishedAt?: string;
    }> | undefined;

    const tweets = result.metadata?.tweets as Array<{
      url?: string;
      content?: string;
      author?: string;
      publishedAt?: string;
    }> | undefined;

    if (videos) {
      return videos
        .filter((v) => v.url || v.videoId)
        .map((v) => ({
          id: v.url || `https://www.douyin.com/video/${v.videoId}`,
          url: v.url || `https://www.douyin.com/video/${v.videoId}`,
          title: v.title,
          author: v.author,
          publishedAt: v.publishedAt,
        }));
    }

    if (tweets) {
      return tweets.map((t) => ({
        id: t.url || `${result.url}#${t.author}_${t.content?.slice(0, 50)}`,
        url: t.url || result.url,
        title: t.content?.slice(0, 100),
        author: t.author,
        publishedAt: t.publishedAt,
      }));
    }

    return [];
  }

  private toCheckItem(result: ScrapeResult): FeedCheckItem {
    return {
      url: result.url,
      title: result.title,
      author: result.author,
      publishedAt: result.publishedAt,
      audioPath: result.audioPath,
      transcript: result.transcript,
    };
  }
}
