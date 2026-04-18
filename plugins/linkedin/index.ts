/**
 * LinkedIn 插件 - 使用 Playwright 刮削帖子内容
 */

import { chromium } from 'playwright';
import type {
  IPlatformPlugin,
  ScrapeResult,
  ScrapeOptions,
} from '../../src/interfaces/index.js';

export default class LinkedInPlugin implements IPlatformPlugin {
  readonly name = 'linkedin';
  readonly hostnames = ['linkedin.com', 'www.linkedin.com', 'mobile.linkedin.com'];
  readonly capabilities = {
    scrapeMetadata: true,
    scrapeContent: true,
    downloadAudio: false,
    extractTranscript: false,
  };

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.hostnames.includes(hostname);
    } catch {
      return false;
    }
  }

  async scrape(url: string, options: ScrapeOptions): Promise<ScrapeResult> {
    console.log(`[LinkedIn] Scraping with Playwright: ${url}`);

    const timeout = options.timeout || 60000;
    let browser;

    try {
      // 启动浏览器 - debug 模式下显示窗口
      browser = await chromium.launch({
        headless: !options.debug,
        slowMo: options.debug ? 100 : 0, // debug 模式下放慢操作以便观察
      });

      if (options.debug) {
        console.log('[LinkedIn] Debug mode: browser window is visible');
      }

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      const page = await context.newPage();

      // 设置超时
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      // 访问页面
      await page.goto(url, { waitUntil: 'networkidle' });

      // 等待内容加载
      await page.waitForSelector('.feed-shared-update-v2, .scaffold-layout__main', { timeout: 10000 }).catch(() => {
        console.log('[LinkedIn] Main content selector not found, continuing...');
      });

      // 提取帖子数据
      const postData = await page.evaluate(() => {
        const result: any = {};

        // 尝试提取作者
        const authorElement = document.querySelector('.feed-shared-actor__name, .update-components-actor__name');
        if (authorElement) {
          result.author = authorElement.textContent?.trim();
        }

        // 尝试提取标题
        const titleElement = document.querySelector('h1, .feed-shared-update-v2__description-wrapper');
        if (titleElement) {
          result.title = titleElement.textContent?.trim().slice(0, 100);
        }

        // 尝试提取内容
        const contentElement = document.querySelector('.feed-shared-update-v2__description, .update-components-text');
        if (contentElement) {
          result.content = contentElement.textContent?.trim();
        }

        // 尝试提取时间
        const timeElement = document.querySelector('time');
        if (timeElement) {
          result.publishedAt = timeElement.getAttribute('datetime');
        }

        // 尝试提取互动数据
        const reactionsElement = document.querySelector('.social-details-social-counts__reactions-count');
        if (reactionsElement) {
          const text = reactionsElement.textContent;
          if (text) {
            result.likes = text.trim();
          }
        }

        // 尝试从 meta 标签提取（作为后备）
        if (!result.title) {
          const ogTitle = document.querySelector('meta[property="og:title"]');
          result.title = ogTitle?.getAttribute('content');
        }

        if (!result.content) {
          const ogDesc = document.querySelector('meta[property="og:description"]');
          result.content = ogDesc?.getAttribute('content');
        }

        return result;
      });

      return {
        url,
        platform: this.name,
        author: postData.author,
        title: postData.title,
        content: postData.content,
        publishedAt: postData.publishedAt,
        metadata: {
          likes: postData.likes,
        },
        scrapedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`[LinkedIn] Failed to scrape:`, err);
      return {
        url,
        platform: this.name,
        content: 'Failed to scrape LinkedIn post. Authentication may be required.',
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}
