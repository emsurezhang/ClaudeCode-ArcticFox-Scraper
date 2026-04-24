/**
 * X (Twitter) 插件 - 使用 Playwright 刮削推文内容
 *
 * 特性：
 * - 支持 cookies 登录
 * - 滚动加载策略: min/max/all
 * - 处理 X 的虚拟滚动（释放不可见内容）
 */

import { chromium } from 'playwright';
import type { Page, Browser, BrowserContext, Cookie } from 'playwright';
import { readFile } from 'fs/promises';
import type {
  IPlatformPlugin,
  ScrapeResult,
  ScrapeOptions,
  MediaItem,
} from '../../src/interfaces/index.js';

type ScrollStrategy = 'min' | 'max' | 'all';

interface XScrapeOptions extends ScrapeOptions {
  /** 滚动策略: min=最少, max=达到数量退出, all=全部 */
  scrollStrategy?: ScrollStrategy;
  /** max 策略下的推文数量上限 */
  maxTweets?: number;
  /** 每次滚动后等待时间（毫秒） */
  scrollWaitTime?: number;
}

export default class XPlugin implements IPlatformPlugin {
  readonly name = 'x';
  readonly hostnames = ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com'];
  readonly capabilities = {
    scrapeMetadata: true,
    scrapeContent: true,
    downloadAudio: false,
    extractTranscript: false,
  };

  private cookieCacheDir = './cache/cookies';

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.hostnames.includes(hostname);
    } catch {
      return false;
    }
  }

  async scrape(url: string, options: XScrapeOptions): Promise<ScrapeResult> {
    const mode = options.mode || 'detail';
    console.log(`[X] Scraping: ${url} (mode: ${mode})`);

    const timeout = options.timeout || 60000;
    const strategy = options.scrollStrategy || 'min';
    const maxItems = options.maxItems || options.maxTweets || 50;
    const scrollWaitTime = options.scrollWaitTime || 2000;

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    const usePool = !options.debug && options.browserPool;

    try {
      if (usePool) {
        context = await options.browserPool!.acquire(this.name, options.browser || 'chrome');
      } else {
        // 启动浏览器
        browser = await chromium.launch({
          headless: !options.debug,
          slowMo: options.debug ? 100 : 0,
        });
        context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          viewport: { width: 1280, height: 800 },
        });
      }

      // 加载 cookies（如果存在）
      await this.loadCookies(context, options.browser || 'chrome');

      page = await context.newPage();
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      if (options.debug) {
        console.log('[X] Debug mode: browser window is visible');
      }

      // 访问页面 - 使用 domcontentloaded 更快，不等待 networkidle
      console.log('[X] Navigating to URL...');
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      // 直接检测目标内容是否渲染
      await this.waitForContentRender(page, { timeout: 15000, debug: options.debug });

      // 检查登录状态
      await this.checkLoginStatus(page);

      if (mode === 'list') {
        // 列表模式：获取博主/频道的时间线
        return await this.scrapeList(page, url, {
          maxItems,
          scrollWaitTime,
          strategy,
          debug: options.debug,
        });
      } else {
        // 详情模式：获取单条推文及其线程
        return await this.scrapeDetail(page, url, {
          strategy,
          maxItems,
          scrollWaitTime,
          debug: options.debug,
        });
      }
    } catch (err) {
      console.error(`[X] Failed to scrape:`, err);
      return {
        url,
        platform: this.name,
        content: `Failed to scrape: ${err instanceof Error ? err.message : 'Unknown error'}`,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      if (page) {
        await page.close().catch((err) => console.warn('[X] Warning:', err));
      }
      if (usePool && options.browserPool && context) {
        await options.browserPool.release(this.name, options.browser || 'chrome', context);
      } else if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * 列表模式：刮削博主/频道的时间线
   */
  private async scrapeList(
    page: Page,
    url: string,
    options: {
      maxItems: number;
      scrollWaitTime: number;
      strategy: ScrollStrategy;
      debug?: boolean;
    }
  ): Promise<ScrapeResult> {
    console.log(`[X] List mode: collecting timeline (max ${options.maxItems})`);

    // 确保是用户主页 URL
    if (!url.includes('/status/')) {
      // 已经是用户主页，直接滚动收集
      const tweets = await this.scrollAndCollect(
        page,
        'max',
        options.maxItems,
        options.scrollWaitTime,
        options.debug
      );

      const author = this.extractAuthorFromUrl(url) || tweets[0]?.author || 'unknown';

      return {
        url,
        platform: this.name,
        author,
        title: `${author}'s Timeline`,
        content: `Collected ${tweets.length} tweets from @${author}`,
        metadata: {
          mode: 'list',
          totalTweets: tweets.length,
          tweets: tweets.map(t => ({
            author: t.author,
            content: t.content?.slice(0, 200),
            publishedAt: t.publishedAt,
            likes: t.likes,
            reposts: t.reposts,
          })),
        },
        scrapedAt: new Date().toISOString(),
      };
    }

    // 如果是单条推文 URL，提取作者并跳转至主页
    const author = await page.evaluate(() => {
      const link = document.querySelector('a[href^="/"][role="link"]');
      return link?.getAttribute('href')?.split('/')[1];
    });


    if (author) {
      const profileUrl = `https://x.com/${author}`;
      console.log(`[X] Redirecting to profile: ${profileUrl}`);
      await page.goto(profileUrl, { waitUntil: 'networkidle' });
      // 修复：waitForInitialLoad 方法不存在，改为等待内容渲染
      await this.waitForContentRender(page, { timeout: 15000, debug: options.debug });
      // 递归调用（但已经是主页，不会进入这个分支）
      return this.scrapeList(page, profileUrl, options);
    }

    throw new Error('Could not extract author from URL');
  }

  /**
   * 详情模式：刮削单条推文及其回复线程
   */
  private async scrapeDetail(
    page: Page,
    url: string,
    options: {
      strategy: ScrollStrategy;
      maxItems: number;
      scrollWaitTime: number;
      debug?: boolean;
    }
  ): Promise<ScrapeResult> {
    console.log(`[X] Detail mode: scraping tweet and thread`);

    let tweets: TweetData[] = [];

    if (options.strategy === 'min') {
      // 最少信息：只获取当前可见的推文
      tweets = await this.extractVisibleTweets(page);
    } else {
      // max 或 all 策略：滚动加载更多（包括回复）
      tweets = await this.scrollAndCollect(
        page,
        options.strategy,
        options.maxItems,
        options.scrollWaitTime,
        options.debug
      );
    }

    if (tweets.length === 0) {
      throw new Error('No tweets found on page');
    }

    // 整合数据
    const mainTweet = tweets[0];
    const allContent = tweets.map(t => t.content).join('\n---\n');

    return {
      url,
      platform: this.name,
      author: mainTweet.author,
      title: mainTweet.content?.slice(0, 100),
      content: options.strategy === 'min' ? mainTweet.content : allContent,
      publishedAt: mainTweet.publishedAt,
      media: this.aggregateMedia(tweets),
      metadata: {
        mode: 'detail',
        totalTweets: tweets.length,
        scrollStrategy: options.strategy,
        likes: mainTweet.likes,
        reposts: mainTweet.reposts,
        replies: mainTweet.replies,
        thread: tweets.length > 1 ? tweets.slice(1) : undefined,
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * 等待页面初始加载
   */
  private async waitForContentRender(
    page: Page,
    options: { timeout: number; debug?: boolean }
  ): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 500; // 每 500ms 检查一次

    const selectors = [
      'article[data-testid="tweet"]',
      '[data-testid="tweetText"]',
      '[data-testid="cellInnerDiv"]',
      'div[data-testid="primaryColumn"]',
    ];

    console.log('[X] Waiting for content to render...');

    let foundPrimaryColumn = false;
    let primaryColumnTime = 0;

    while (Date.now() - startTime < options.timeout) {
      // 第一阶段：等待 primaryColumn 出现
      if (!foundPrimaryColumn) {
        try {
          const primaryColumn = await page.$('div[data-testid="primaryColumn"]');
          if (primaryColumn) {
            const isVisible = await primaryColumn.evaluate((el: Element) => {
              const rect = el.getBoundingClientRect();
              return rect.height > 0 && rect.width > 0;
            });

            if (isVisible) {
              foundPrimaryColumn = true;
              primaryColumnTime = Date.now();
              console.log(`[X] Primary column found, waiting for content...`);
              // 找到 primaryColumn 后，额外等待 30 秒让内容加载
              await page.waitForTimeout(30000);
            }
          }
        } catch (err) { console.warn('[X] Warning:', err);
          // 忽略检查错误
        }
      }

      // 第二阶段：等待实际推文内容出现
      if (foundPrimaryColumn) {
        const contentSelectors = [
          'article[data-testid="tweet"]',
          '[data-testid="tweetText"]',
        ];

        for (const selector of contentSelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              const isVisible = await element.evaluate((el: Element) => {
                const rect = el.getBoundingClientRect();
                return rect.height > 0 && rect.width > 0;
              });

              if (isVisible) {
                console.log(`[X] Content rendered: ${selector} (${Date.now() - startTime}ms)`);
                return true;
              }
            }
          } catch (err) { console.warn('[X] Warning:', err);
            // 忽略检查错误
          }
        }
      }

      if (options.debug) {
        const elapsed = Date.now() - startTime;
        const phase = foundPrimaryColumn ? 'waiting for tweets' : 'waiting for primary column';
        console.log(`[X] ${phase}... (${elapsed}ms)`);
      }

      await page.waitForTimeout(checkInterval);
    }

    console.log('[X] Warning: Content render timeout, continuing anyway');
    return false;
  }

  /**
   * 检查登录状态
   */
  private async checkLoginStatus(page: Page): Promise<boolean> {
    try {
      // 检查是否有登录用户的特征元素
      const avatar = await page.$('a[href="/settings/profile"]');
      const composeButton = await page.$('a[href="/compose/tweet"]');

      if (avatar || composeButton) {
        console.log('[X] Login status: authenticated');
        return true;
      }

      // 检查是否有登录提示
      const loginPrompt = await page.$('text=/log in|sign in/i');
      if (loginPrompt) {
        console.log('[X] Login status: not authenticated');
        return false;
      }

      console.log('[X] Login status: unknown');
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 加载 cookies
   */
  private async loadCookies(context: BrowserContext, browserName: string): Promise<void> {
    const cookiePath = `${this.cookieCacheDir}/x_${browserName}.txt`;

    try {
      // 1. 尝试读取现有 cookies
      let cookieContent: string | null = null;

      try {
        cookieContent = await readFile(cookiePath, 'utf-8');
        console.log(`[X] Found cached cookies: ${cookiePath}`);

        // 检查是否过期（简单检查：文件修改时间是否在 24 小时内）
        const { stat } = await import('fs/promises');
        const stats = await stat(cookiePath);
        const age = Date.now() - stats.mtime.getTime();
        const maxAge = 24 * 60 * 60 * 1000; // 24 小时

        if (age > maxAge) {
          console.log(`[X] Cookies expired (${Math.floor(age / 3600000)}h old), will re-extract`);
          cookieContent = null;
        }
      } catch (err: unknown) {
        console.log('[X] No cached cookies found');
      }

      // 2. 如果没有有效 cookies，自动从浏览器提取
      if (!cookieContent) {
        console.log(`[X] Extracting cookies from ${browserName} browser...`);
        cookieContent = await this.extractCookiesFromBrowser(browserName, cookiePath);

        if (!cookieContent) {
          console.log('[X] Failed to extract cookies, will access as guest');
          return;
        }
      }

      // 3. 解析并加载 cookies
      const cookies = this.parseNetscapeCookies(cookieContent, 'https://x.com');

      if (cookies.length > 0) {
        // 调试：打印第一个和最后一个 cookie 的 expires
        console.log(`[X] First cookie expires: ${cookies[0]?.expires} (type: ${typeof cookies[0]?.expires})`);
        console.log(`[X] Last cookie expires: ${cookies[cookies.length-1]?.expires} (type: ${typeof cookies[cookies.length-1]?.expires})`);

        // 过滤掉无效的 cookies
        const validCookies = cookies.filter((c) => {
          const valid = typeof c.expires === 'number' && (c.expires === -1 || c.expires > 0);
          if (!valid) {
            console.log(`[X] Invalid cookie filtered: ${c.name}, expires=${c.expires}`);
          }
          return valid;
        });

        console.log(`[X] Loading ${validCookies.length} valid cookies (${cookies.length - validCookies.length} filtered)`);
        await context.addCookies(validCookies);
        console.log(`[X] Loaded ${validCookies.length} cookies`);

        // 验证 cookies 是否包含关键登录凭证
        const hasAuthToken = cookies.some((c) =>
          c.name.includes('auth') || c.name.includes('session') || c.name === 'ct0' || c.name === 'twid'
        );

        if (hasAuthToken) {
          console.log('[X] Cookies contain authentication tokens');
        } else {
          console.log('[X] Warning: Cookies may not contain authentication data');
        }
      } else {
        console.log('[X] No valid cookies found');
      }
    } catch (err) {
      console.log('[X] Failed to load cookies:', err);
    }
  }

  /**
   * 使用 yt-dlp 从浏览器提取 cookies
   */
  private async extractCookiesFromBrowser(browserName: string, outputPath: string): Promise<string | null> {
    const { spawn } = await import('child_process');
    const { mkdir } = await import('fs/promises');
    const { dirname } = await import('path');

    return new Promise((resolve) => {
      // 确保目录存在
      mkdir(dirname(outputPath), { recursive: true }).catch((err: unknown) => console.warn('[X] Warning:', err));

      // 使用 yt-dlp 提取 cookies
      const proc = spawn('yt-dlp', [
        '--cookies-from-browser', browserName,
        '--cookies', outputPath,
        '--print', 'cookies',
        'https://x.com/home'  // 随便一个需要登录的页面
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', async (code: number) => {
        if (code === 0) {
          try {
            // 读取生成的 cookies 文件
            const { readFile } = await import('fs/promises');
            const content = await readFile(outputPath, 'utf-8');
            console.log(`[X] Cookies extracted and saved to: ${outputPath}`);
            resolve(content);
          } catch (err: unknown) {
            console.error('[X] Failed to read extracted cookies:', err);
            resolve(null);
          }
        } else {
          console.error(`[X] yt-dlp exited with code ${code}: ${stderr}`);
          resolve(null);
        }
      });

      proc.on('error', (err: unknown) => {
        console.error('[X] Failed to spawn yt-dlp:', err);
        resolve(null);
      });
    });
  }

  /**
   * 解析 Netscape cookies 格式
   */
  private parseNetscapeCookies(content: string, url: string): Cookie[] {
    const cookies: Cookie[] = [];
    const lines = content.split('\n');
    const targetDomain = new URL(url).hostname;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        const [domain, , path, secure, expires, name, value] = parts;

        // 标准化 domain
        let normalizedDomain = domain.trim();
        if (!normalizedDomain.startsWith('.')) {
          normalizedDomain = '.' + normalizedDomain;
        }

        // 确保证书匹配目标域名
        const isRelevant = targetDomain.includes(normalizedDomain.replace(/^\./, '')) ||
                          normalizedDomain.replace(/^\./, '').includes(targetDomain);

        if (!isRelevant) {
          continue; // 跳过不相关的 cookies
        }

        // 处理 expires：-1 表示会话 cookie，正数表示 unix 时间戳（秒）
        let expiresValue = parseInt(expires);

        // 检查是否是毫秒/微秒时间戳并转换
        if (expiresValue > 9999999999999) {
          // 微秒级时间戳（16-17位），转换为秒
          expiresValue = Math.floor(expiresValue / 1000000);
        } else if (expiresValue > 9999999999) {
          // 毫秒级时间戳（13位），转换为秒
          expiresValue = Math.floor(expiresValue / 1000);
        }

        if (isNaN(expiresValue) || expiresValue <= 0) {
          // 默认 7 天后过期
          expiresValue = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
        }

        const cookie: Cookie = {
          domain: normalizedDomain,
          path: path || '/',
          secure: secure === 'TRUE',
          expires: expiresValue,
          name: name.trim(),
          value: value.trim(),
          httpOnly: false,
          sameSite: 'Lax',
        };

        cookies.push(cookie);
      }
    }

    return cookies;
  }

  /**
   * 提取当前可见的推文
   */
  private async extractVisibleTweets(page: Page): Promise<TweetData[]> {
    return page.evaluate(() => {
      const tweets: TweetData[] = [];
      const articles = document.querySelectorAll('article[data-testid="tweet"]');

      articles.forEach((article: Element) => {
        const tweet = extractTweetData(article);
        if (tweet) tweets.push(tweet);
      });

      return tweets;

      function extractTweetData(article: Element): TweetData | null {
        const contentEl = article.querySelector('[data-testid="tweetText"]');
        if (!contentEl) return null;

        const content = contentEl.textContent || '';

        // 提取作者
        const authorLink = article.querySelector('a[href^="/"]');
        const author = authorLink?.getAttribute('href')?.split('/')[1] || '';

        // 提取时间
        const timeEl = article.querySelector('time');
        const publishedAt = timeEl?.getAttribute('datetime') ?? undefined;

        // 提取互动数据
        const stats = article.querySelectorAll('[data-testid="app-text-transition-container"]');
        const replies = stats[0]?.textContent;
        const reposts = stats[1]?.textContent;
        const likes = stats[2]?.textContent;

        // 提取媒体
        const images = article.querySelectorAll('img[src*="pbs.twimg.com"]');
        const media: MediaItem[] = [];
        images.forEach((img: Element) => {
          const src = (img as HTMLImageElement).getAttribute('src');
          if (src && !src.includes('profile') && !src.includes('emoji')) {
            media.push({ type: 'image', url: src.replace(/\?.*$/, '') });
          }
        });

        return {
          author,
          content,
          publishedAt,
          likes,
          reposts,
          replies,
          media,
        };
      }
    });
  }

  /**
   * 滚动并收集推文
   */
  private async scrollAndCollect(
    page: Page,
    strategy: ScrollStrategy,
    maxTweets: number,
    waitTime: number,
    debug?: boolean
  ): Promise<TweetData[]> {
    const allTweets: Map<string, TweetData> = new Map();
    let lastHeight = 0;
    let unchangedCount = 0;
    const maxUnchanged = 3; // 连续 3 次没有新内容则停止

    console.log(`[X] Starting scroll collection (strategy: ${strategy}, max: ${maxTweets})`);

    while (true) {
      // 提取当前可见的推文
      const visibleTweets = await this.extractVisibleTweets(page);

      // 添加到集合（去重）
      let newCount = 0;
      for (const tweet of visibleTweets) {
        const key = `${tweet.author}_${tweet.content?.slice(0, 50)}`;
        if (!allTweets.has(key)) {
          allTweets.set(key, tweet);
          newCount++;
        }
      }

      console.log(`[X] Collected ${allTweets.size} unique tweets (+${newCount} new)`);

      // 检查退出条件
      if (strategy === 'max' && allTweets.size >= maxTweets) {
        console.log(`[X] Reached max tweets limit (${maxTweets})`);
        break;
      }

      // 滚动页面
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);

      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.8);
      });

      // 等待内容加载
      await page.waitForTimeout(waitTime);

      // 检查是否到达底部
      const newHeight = await page.evaluate(() => document.body.scrollHeight);

      if (newHeight === lastHeight) {
        unchangedCount++;
        console.log(`[X] No new content loaded (${unchangedCount}/${maxUnchanged})`);

        if (unchangedCount >= maxUnchanged) {
          console.log('[X] Reached end of content');
          break;
        }
      } else {
        unchangedCount = 0;
      }

      lastHeight = newHeight;

      // 调试模式下等待用户观察
      if (debug && allTweets.size % 10 === 0) {
        console.log('[X] Debug pause - check browser, continuing in 2s...');
        await page.waitForTimeout(2000);
      }
    }

    return Array.from(allTweets.values());
  }

  /**
   * 聚合媒体
   */
  private aggregateMedia(tweets: TweetData[]): MediaItem[] | undefined {
    const allMedia: MediaItem[] = [];
    const seen = new Set<string>();

    for (const tweet of tweets) {
      if (tweet.media) {
        for (const media of tweet.media) {
          if (!seen.has(media.url)) {
            seen.add(media.url);
            allMedia.push(media);
          }
        }
      }
    }

    return allMedia.length > 0 ? allMedia : undefined;
  }

  /**
   * 从 URL 提取作者
   */
  private extractAuthorFromUrl(url: string): string {
    try {
      const match = url.match(/x\.com\/([^\/]+)/);
      return match ? match[1] : '';
    } catch {
      return '';
    }
  }
}

interface TweetData {
  author?: string;
  content?: string;
  publishedAt?: string;
  likes?: string;
  reposts?: string;
  replies?: string;
  media?: MediaItem[];
}
