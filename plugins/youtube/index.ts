/**
 * YouTube 插件 - 分步流程编排器
 */

import { readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import type { Browser, BrowserContext, Page } from 'playwright';
import type {
  IPlatformPlugin,
  ScrapeResult,
} from '../../src/interfaces/index.js';
import { createLogger } from '../../src/core/logger.js';
import { detailExtractor } from './methods/detail-extractor.js';
import { isLoggedIn, requiresCookieRecovery } from './methods/is-logged-in.js';
import { listExtractor } from './methods/list-extractor.js';
import { refreshCookiesAndRetry } from './methods/refresh-cookies-and-retry.js';
import { scrollAndWaitLoaded } from './methods/scroll-and-wait-loaded.js';
import {
  BROWSER_UA,
  YOUTUBE_DOMAIN_FILTER,
  type VideoItem,
  type YouTubePluginConfig,
  type YouTubeScrapeOptions,
} from './methods/types.js';
import { visitAndWaitLoaded } from './methods/visit-and-wait-loaded.js';

let playwright: typeof import('playwright') | null = null;
const logger = createLogger('YouTube');

async function getPlaywright(): Promise<typeof import('playwright')> {
  if (!playwright) {
    logger.debug('Loading Playwright module lazily');
    playwright = await import('playwright');
    logger.debug('Playwright module loaded');
  }
  return playwright;
}

interface AllocationResult {
  context: BrowserContext;
  release: () => Promise<void>;
}

export default class YouTubePlugin implements IPlatformPlugin {
  readonly name = 'youtube';
  readonly hostnames = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'];
  readonly capabilities = {
    scrapeMetadata: true,
    scrapeContent: true,
    downloadAudio: true,
    extractTranscript: true,
  };

  private readonly tempDir = './cache/temp';
  private readonly config: YouTubePluginConfig;

  constructor() {
    mkdir(this.tempDir, { recursive: true }).catch((err) => logger.warn('Failed to create temp directory', err));
    this.config = this.loadConfig();
    logger.debug('YouTube plugin initialized', { tempDir: this.tempDir, config: this.config });
  }

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.hostnames.includes(hostname);
    } catch {
      return false;
    }
  }

  async scrape(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    const mode = options.mode || 'detail';
    logger.info(`Scraping: ${url} (mode: ${mode})`);
    logger.debug('Scrape options', {
      mode,
      maxItems: options.maxItems,
      downloadAudio: options.downloadAudio,
      extractTranscript: options.extractTranscript,
      browser: options.browser,
      debug: options.debug,
    });

    if (mode === 'list') {
      const result = await this.scrapeList(url, options);
      logger.info(`List scrape completed: ${url}`);
      logger.debug('Scrape result', {
        ...result,
        metadata: {
          ...result.metadata,
          videos: Array.isArray(result.metadata?.videos)
            ? JSON.stringify(result.metadata.videos, null, 2)
            : result.metadata?.videos,
        },
      });
      return result;
    }

    const result = await this.scrapeDetail(url, options);
    logger.info(`Detail scrape completed: ${url}`);
    logger.debug('Scrape result', result);
    return result;
  }

  private loadConfig(): YouTubePluginConfig {
    const defaults: YouTubePluginConfig = {
      pageLoadWaitMs: 6000,
      loginCheckRetryWaitMs: 5000,
      scrollHeightChangeTimeoutMs: 6000,
      scrollSettleWaitMs: 1500,
      scrollStepIntervalMs: 150,
      maxNoNewContentStreak: 3,
    };

    try {
      const configPath = new URL('./config.json', import.meta.url);
      const content = readFileSync(configPath, 'utf-8');
      const config = { ...defaults, ...JSON.parse(content) } as YouTubePluginConfig;
      logger.debug('Loaded plugin config from config.json', config);
      return config;
    } catch (err) {
      logger.info('Using default config');
      logger.debug('Failed to load plugin config file', err);
      return defaults;
    }
  }

  private async scrapeList(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    const maxItems = options.maxItems || 50;
    logger.info(`Starting list scrape for ${url} with maxItems=${maxItems}`);
    const videos = await this.collectVideos(url, maxItems, options);
    logger.info(`List scrape collected ${videos.length} videos from ${url}`);

    if (videos.length === 0) {
      return {
        url,
        platform: this.name,
        content: 'No videos found in playlist/channel',
        scrapedAt: new Date().toISOString(),
      };
    }

    const channelName = videos[0]?.channel || 'Unknown';

    return {
      url,
      platform: this.name,
      author: channelName,
      title: `${channelName}'s Videos`,
      content: `Collected ${videos.length} videos`,
      metadata: {
        mode: 'list',
        totalVideos: videos.length,
        videos: videos.map((video) => ({
          title: video.title,
          url: video.url,
          duration: video.duration,
          viewCount: video.viewCount,
          publishedAt: video.publishedAt,
          thumbnail: video.thumbnail,
        })),
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  private async scrapeDetail(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    logger.info(`Starting detail scrape for ${url}`);
    const detail = await detailExtractor(url, options, this.tempDir);
    logger.debug('Detail extraction output summary', {
      hasTranscript: !!detail.transcript,
      transcriptLanguage: detail.transcriptLanguage,
      audioPath: detail.audioPath,
      metadata: detail.metadata,
    });

    return {
      url,
      platform: this.name,
      title: detail.title,
      author: detail.author,
      description: detail.description,
      publishedAt: detail.publishedAt,
      transcript: detail.transcript,
      transcriptLanguage: detail.transcriptLanguage,
      audioPath: detail.audioPath,
      metadata: detail.metadata,
      scrapedAt: new Date().toISOString(),
    };
  }

  private async collectVideos(
    url: string,
    maxItems: number,
    options: YouTubeScrapeOptions,
  ): Promise<VideoItem[]> {
    let allocation: AllocationResult | undefined;
    let page: Page | undefined;

    try {
      logger.debug('Allocating browser context for list scraping', {
        browser: options.browser || 'chrome',
        debug: options.debug,
        useBrowserPool: !!options.browserPool,
      });
      allocation = await this.allocateContext(options);

      if (options.cookieManager) {
        logger.debug('Injecting cookies into YouTube browser context');
        await options.cookieManager.injectIntoContext(
          allocation.context,
          this.name,
          options.browser || 'chrome',
          { domainFilter: YOUTUBE_DOMAIN_FILTER },
        );
      }

      page = await allocation.context.newPage();
      const isPlaylist = url.includes('/playlist?list=');
      logger.debug('Opening target page', { url, isPlaylist });
      await visitAndWaitLoaded(page, url, this.config.pageLoadWaitMs, isPlaylist);
      logger.debug('Page initial load completed', { url, isPlaylist });

      const loginStatus = await isLoggedIn(page);
      logger.debug('Initial login status detected', loginStatus);
      if (requiresCookieRecovery(loginStatus)) {
        logger.warn('Login required, trying to refresh cookies and retry...');
        const ok = await refreshCookiesAndRetry(
          page,
          allocation.context,
          options,
          options.browser || 'chrome',
          url,
          this.config,
        );
        logger.debug('Cookie refresh attempt result', { success: ok });
        if (!ok) {
          throw new Error('Cookie refresh failed, YouTube login is still unavailable');
        }
      }

      const videos: VideoItem[] = [];
      let noNewContentStreak = 0;
      let scrollAttempts = 0;
      const maxScrollAttempts = Math.ceil(maxItems / 20) + 5;

      while (
        videos.length < maxItems &&
        scrollAttempts < maxScrollAttempts &&
        noNewContentStreak < this.config.maxNoNewContentStreak
      ) {
        logger.debug('List extraction loop started', {
          collected: videos.length,
          target: maxItems,
          scrollAttempts,
          maxScrollAttempts,
          noNewContentStreak,
        });
        const batch = await listExtractor(page, {
          maxItems: maxItems - videos.length,
          isPlaylist,
          existingUrls: videos.map((v) => v.url),
        });

        const before = videos.length;
        for (const item of batch) {
          if (!videos.find((existing) => existing.url === item.url)) {
            videos.push(item);
          }
        }

        const gained = videos.length - before;
        logger.debug('List extraction loop result', {
          batchSize: batch.length,
          gained,
          totalCollected: videos.length,
        });
        if (gained === 0) {
          noNewContentStreak++;
        } else {
          noNewContentStreak = 0;
        }

        if (videos.length >= maxItems) {
          break;
        }
        if (noNewContentStreak >= this.config.maxNoNewContentStreak) {
          logger.debug('Stopping list extraction due to no new content streak', {
            noNewContentStreak,
            maxNoNewContentStreak: this.config.maxNoNewContentStreak,
          });
          break;
        }

        await scrollAndWaitLoaded(page, this.config);
        scrollAttempts++;
      }

      logger.info(`Collected ${videos.length} videos from ${url}`);
      return videos.slice(0, maxItems);
    } catch (err) {
      logger.error('List scraping error', err);
      return [];
    } finally {
      if (page) {
        logger.debug('Closing list scraping page');
        await page.close().catch((err) => logger.warn('Failed to close page', err));
      }
      if (allocation) {
        logger.debug('Releasing browser allocation for list scraping');
        await allocation.release().catch((err) => logger.warn('Failed to release allocation', err));
      }
    }
  }

  private async allocateContext(options: YouTubeScrapeOptions): Promise<AllocationResult> {
    const browserName = options.browser || 'chrome';
    const usePool = !options.debug && !!options.browserPool;
    logger.debug('Allocating context', { browserName, usePool, debug: options.debug });

    if (options.browserPool?.allocate) {
      logger.debug('Using browserPool.allocate for context allocation');
      return options.browserPool.allocate(this.name, browserName, {
        usePool,
        headless: !options.debug,
        userAgent: BROWSER_UA,
        viewport: { width: 1366, height: 900 },
      });
    }

    if (usePool && options.browserPool) {
      logger.debug('Using browserPool.acquire for context allocation');
      const context = await options.browserPool.acquire(this.name, browserName);
      return {
        context,
        release: async () => {
          await options.browserPool!.release(this.name, browserName, context);
        },
      };
    }

    logger.debug('Falling back to standalone Playwright browser allocation');
    const pw = await getPlaywright();
    const browser = await pw.chromium.launch({
      headless: !options.debug,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: BROWSER_UA,
    });

    return this.createStandaloneAllocation(browser, context);
  }

  private createStandaloneAllocation(browser: Browser, context: BrowserContext): AllocationResult {
    return {
      context,
      release: async () => {
        logger.debug('Releasing standalone browser allocation');
        await context.close().catch((err) => logger.warn('Failed to close standalone context', err));
        await browser.close().catch((err) => logger.warn('Failed to close standalone browser', err));
      },
    };
  }
}
