import { readFileSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { IPlatformPlugin, ScrapeResult } from '../../src/interfaces/index.js';
import { createLogger } from '../../src/core/logger.js';
import { detailExtractor } from './methods/detail-extractor.js';
import { listExtractor } from './methods/list-extractor.js';
import { ensurePageAccessible } from './methods/refresh-cookies-and-retry.js';
import {
  BROWSER_UA,
  DOUYIN_DOMAIN_FILTER,
  type DouYinPluginConfig,
  type DouYinScrapeOptions,
} from './methods/types.js';

let playwright: typeof import('playwright') | null = null;
const logger = createLogger('DouYin');

interface AllocationResult {
  context: BrowserContext;
  release: () => Promise<void>;
}

export default class DouYinPlugin implements IPlatformPlugin {
  readonly name = 'douyin';
  readonly hostnames = ['douyin.com', 'www.douyin.com', 'v.douyin.com', 'm.douyin.com'];
  readonly capabilities = {
    scrapeMetadata: true,
    scrapeContent: true,
    downloadAudio: true,
    extractTranscript: true,
  };

  private readonly tempDir = './cache/temp';
  private readonly config: DouYinPluginConfig;

  constructor() {
    mkdir(this.tempDir, { recursive: true }).catch((err) => logger.warn('Failed to create temp directory', err));
    this.config = this.loadConfig();
    logger.debug('DouYin plugin initialized', { tempDir: this.tempDir, config: this.config });
  }

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.hostnames.some((supported) => hostname.includes(supported));
    } catch {
      return false;
    }
  }

  async scrape(url: string, options: DouYinScrapeOptions): Promise<ScrapeResult> {
    const mode = options.mode || 'detail';
    logger.info(`Scraping: ${url} (mode: ${mode})`);

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

  private loadConfig(): DouYinPluginConfig {
    const defaults: DouYinPluginConfig = {
      listPageLoadWaitMs: 8000,
      listVideoSelectorTimeoutMs: 20000,
      listScrollWaitMs: 4000,
      scrollStepIntervalMs: 300,
      scrollHeightChangeTimeoutMs: 5000,
      scrollSettleWaitMs: 2000,
      loginCheckRetryWaitMs: 8000,
      detailDomReadyWaitMs: 5000,
      detailCaptureTimeoutMs: 20000,
    };

    try {
      const configPath = new URL('./config.json', import.meta.url);
      const content = readFileSync(configPath, 'utf-8');
      const config = { ...defaults, ...JSON.parse(content) } as DouYinPluginConfig;
      logger.debug('Loaded DouYin plugin config from config.json', config);
      return config;
    } catch (err) {
      logger.info('Using default DouYin plugin config');
      logger.debug('Failed to load config file', err);
      return defaults;
    }
  }

  private async scrapeList(url: string, options: DouYinScrapeOptions): Promise<ScrapeResult> {
    let allocation: AllocationResult | undefined;
    let page: Page | undefined;

    try {
      const maxItems = options.maxItems || 30;
      allocation = await this.allocateContext(options);
      if (options.cookieManager) {
        await options.cookieManager.injectIntoContext(
          allocation.context,
          this.name,
          options.browser || 'chrome',
          { domainFilter: DOUYIN_DOMAIN_FILTER },
        );
      }

      page = await allocation.context.newPage();
      await ensurePageAccessible(page, allocation.context, options, url, this.config);

      const extracted = await listExtractor(page, this.config, maxItems);
      logger.info(`List scrape completed for ${url}, collected ${extracted.videos.length} videos`);

      return {
        url,
        platform: this.name,
        author: extracted.nickname,
        title: `${extracted.nickname || 'Unknown'}'s Videos`,
        content: `Collected ${extracted.videos.length} videos`,
        metadata: {
          mode: 'list',
          totalVideos: extracted.videos.length,
          videos: extracted.videos.map((video) => ({
            title: video.title,
            url: video.url,
            coverUrl: video.coverUrl,
          })),
        },
        scrapedAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.error('List scraping failed', err);
      return {
        url,
        platform: this.name,
        content: `Error scraping user page: ${err instanceof Error ? err.message : String(err)}`,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      await page?.close().catch((err) => logger.warn('Failed to close list page', err));
      await allocation?.release().catch((err) => logger.warn('Failed to release list allocation', err));
    }
  }

  private async scrapeDetail(url: string, options: DouYinScrapeOptions): Promise<ScrapeResult> {
    const videoId = this.extractVideoId(url);
    const outputDir = `${this.tempDir}/${videoId}`;

    let allocation: AllocationResult | undefined;
    let detail:
      | Awaited<ReturnType<typeof detailExtractor>>
      | undefined;

    try {
      await mkdir(outputDir, { recursive: true });
      allocation = await this.allocateContext(options);
      if (options.cookieManager) {
        await options.cookieManager.injectIntoContext(
          allocation.context,
          this.name,
          options.browser || 'chrome',
          { domainFilter: DOUYIN_DOMAIN_FILTER },
        );
      }

      detail = await detailExtractor(url, options, outputDir, allocation.context, this.config);

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
    } catch (err) {
      logger.error('Detail scraping failed', err);
      return {
        url,
        platform: this.name,
        content: `Error scraping detail page: ${err instanceof Error ? err.message : String(err)}`,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      await allocation?.release().catch((err) => logger.warn('Failed to release detail allocation', err));
      await rm(outputDir, { recursive: true, force: true }).catch((err) => logger.warn('Failed to cleanup temp directory', err));
    }
  }

  private async allocateContext(options: DouYinScrapeOptions): Promise<AllocationResult> {
    const browserName = options.browser || 'chrome';
    const usePool = !options.debug && !!options.browserPool;

    if (options.browserPool?.allocate) {
      return options.browserPool.allocate(this.name, browserName, {
        usePool,
        headless: !options.debug,
        userAgent: BROWSER_UA,
        viewport: { width: 1366, height: 900 },
      });
    }

    if (usePool && options.browserPool) {
      const context = await options.browserPool.acquire(this.name, browserName);
      return {
        context,
        release: async () => {
          await options.browserPool!.release(this.name, browserName, context);
        },
      };
    }

    const pw = await getPlaywright();
    const browser = await pw.chromium.launch({
      headless: !options.debug,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-background-media-suspend',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
        ],
    });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: BROWSER_UA,
    });

    return this.createStandaloneAllocation(browser, context);
  }

  private extractVideoId(url: string): string {
    const patterns = [/video\/([a-zA-Z0-9_-]+)/, /\/([a-zA-Z0-9_-]{19,})/, /modal_id=([0-9]+)/];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.length > 10) {
        return lastPart;
      }
    } catch {
      // Ignore parse errors and fallback to timestamp.
    }

    return `douyin_${Date.now()}`;
  }

  private createStandaloneAllocation(browser: Browser, context: BrowserContext): AllocationResult {
    return {
      context,
      release: async () => {
        await context.close().catch((err) => logger.warn('Failed to close standalone context', err));
        await browser.close().catch((err) => logger.warn('Failed to close standalone browser', err));
      },
    };
  }
}

async function getPlaywright(): Promise<typeof import('playwright')> {
  if (!playwright) {
    playwright = await import('playwright');
  }
  return playwright;
}
