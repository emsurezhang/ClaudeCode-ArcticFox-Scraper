/**
 * 抖音插件 - 使用 Playwright 拦截网络请求获取音频
 *
 * 参考实现：使用 Playwright 捕获音频 URL，下载后转换为 WAV，使用 Whisper 转录
 */

import { spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, readFile, unlink, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { pipeline } from 'stream/promises';
import type {
  IPlatformPlugin,
  ScrapeResult,
  ScrapeOptions,
} from '../../src/interfaces/index.js';

// 动态导入 Playwright（ESM 兼容）
let playwright: typeof import('playwright') | null = null;

async function getPlaywright(): Promise<typeof import('playwright')> {
  if (!playwright) {
    playwright = await import('playwright');
  }
  return playwright;
}

// 动态导入 axios
async function getAxios() {
  const { default: axios } = await import('axios');
  return axios;
}

interface DouYinScrapeOptions extends ScrapeOptions {
  mode?: 'list' | 'detail';
  whisperModel?: string;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export default class DouYinPlugin implements IPlatformPlugin {
  readonly name = 'douyin';
  readonly hostnames = ['douyin.com', 'www.douyin.com', 'v.douyin.com', 'm.douyin.com'];
  readonly capabilities = {
    scrapeMetadata: true,
    scrapeContent: true,
    downloadAudio: true,
    extractTranscript: true,
  };

  private tempDir = './cache/temp';
  private modelsDir = './models';

  constructor() {
    mkdir(this.tempDir, { recursive: true }).catch(() => {});
  }

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.hostnames.some(h => hostname.includes(h));
    } catch {
      return false;
    }
  }

  async scrape(url: string, options: DouYinScrapeOptions): Promise<ScrapeResult> {
    const mode = options.mode || 'detail';
    console.log(`[DouYin] Scraping: ${url} (mode: ${mode})`);

    if (mode === 'list') {
      return this.scrapeList(url, options);
    }
    return this.scrapeDetail(url, options);
  }

  /**
   * 列表模式：获取用户主页视频列表
   */
  private async scrapeList(url: string, options: DouYinScrapeOptions): Promise<ScrapeResult> {
    const maxItems = options.maxItems || 30;
    console.log(`[DouYin] List mode: collecting up to ${maxItems} videos from ${url}`);

    const pw = await getPlaywright();
    let browser: import('playwright').Browser | null = null;

    try {
      browser = await pw.chromium.launch({
        headless: !options.debug,
        args: ['--disable-blink-features=AutomationControlled'],
      });

      const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: BROWSER_UA,
      });

      // 加载并注入 cookies
      await this.injectCookies(context, options.browser || 'chrome');

      const page = await context.newPage();

      // 导航到用户主页
      console.log('[DouYin] Navigating to user page...');
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // 等待页面加载
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // 获取用户信息和视频列表
      const userInfo = await page.evaluate(() => {
        // 尝试多种选择器获取昵称
        const nicknameSelectors = [
          '[data-e2e="user-title"]',
          '.lC6iS6Aq',
          '.J6ms8dP1',
          '.NnqXCVJA',
          '.YpwIi0An',
          'h1',
          '.user-info .nickname',
          '[class*="nickname"]',
        ];
        let nickname = '';
        for (const selector of nicknameSelectors) {
          const el = document.querySelector(selector);
          if (el?.textContent) {
            nickname = el.textContent.trim();
            break;
          }
        }

        // 尝试多种选择器获取视频列表
        const videoCardSelectors = [
          '[data-e2e="user-post-list"] > div > a',
          '[data-e2e="user-post-list"] a[href*="/video/"]',
          '.B6JkCp0k a[href*="/video/"]',
          'a[href*="/video/"]',
          '[class*="video"] a[href*="/video/"]',
          '[class*="item"] a[href*="/video/"]',
          '.swiper-slide a[href*="/video/"]',
        ];

        const videos: Array<{
          title: string;
          url: string;
          videoId: string;
          coverUrl?: string;
        }> = [];

        for (const selector of videoCardSelectors) {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => {
            const href = el.getAttribute('href');
            if (href && href.includes('/video/')) {
              const videoId = href.split('/video/')[1]?.split('?')[0];
              if (videoId && !videos.find(v => v.videoId === videoId)) {
                // 获取封面
                let coverUrl = '';
                const imgSelectors = ['img', 'div[class*="cover"] img', 'div img', '.swiper-slide img'];
                for (const imgSel of imgSelectors) {
                  const img = el.querySelector(imgSel) || el.closest('div[class*="item"]')?.querySelector(imgSel);
                  if (img) {
                    coverUrl = img.getAttribute('src') || img.getAttribute('data-src') || '';
                    if (coverUrl) break;
                  }
                }

                // 获取标题
                let title = '';
                const titleSelectors = ['img[alt]', '.title', '[class*="title"]', '.desc'];
                for (const titleSel of titleSelectors) {
                  const titleEl = el.querySelector(titleSel);
                  if (titleEl) {
                    title = titleEl.getAttribute('alt') || titleEl.textContent || '';
                    if (title) break;
                  }
                }

                videos.push({
                  title: title.trim(),
                  url: `https://www.douyin.com/video/${videoId}`,
                  videoId,
                  coverUrl,
                });
              }
            }
          });
        }

        return { nickname, videos };
      });

      console.log(`[DouYin] Found ${userInfo.videos.length} videos initially`);

      // 滚动加载更多视频
      let previousVideoCount = userInfo.videos.length;
      let scrollAttempts = 0;
      const maxScrollAttempts = Math.ceil(maxItems / 10);

      while (userInfo.videos.length < maxItems && scrollAttempts < maxScrollAttempts) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);

        const newVideos = await page.evaluate(() => {
          const videos: Array<{
            title: string;
            url: string;
            videoId: string;
            coverUrl?: string;
          }> = [];

          const videoElements = document.querySelectorAll(
            'a[href*="/video/"], [data-e2e="user-post-list"] a, .B6JkCp0k a, .B6JkCp0k a[href*="/video/"]'
          );

          videoElements.forEach((el) => {
            const href = el.getAttribute('href');
            if (href && href.includes('/video/')) {
              const videoId = href.split('/video/')[1]?.split('?')[0];
              if (videoId && !videos.find(v => v.videoId === videoId)) {
                const img = el.querySelector('img') || el.closest('div')?.querySelector('img');
                const coverUrl = img?.getAttribute('src') || '';
                const title = img?.getAttribute('alt') || '';

                videos.push({
                  title,
                  url: `https://www.douyin.com/video/${videoId}`,
                  videoId,
                  coverUrl,
                });
              }
            }
          });

          return videos;
        });

        userInfo.videos = newVideos;

        if (userInfo.videos.length === previousVideoCount) {
          console.log('[DouYin] No more videos loaded');
          break;
        }

        previousVideoCount = userInfo.videos.length;
        console.log(`[DouYin] Loaded ${userInfo.videos.length} videos...`);
        scrollAttempts++;
      }

      const limitedVideos = userInfo.videos.slice(0, maxItems);
      await page.close();

      return {
        url,
        platform: this.name,
        author: userInfo.nickname,
        title: `${userInfo.nickname || 'Unknown'}'s Videos`,
        content: `Collected ${limitedVideos.length} videos`,
        metadata: {
          mode: 'list',
          totalVideos: limitedVideos.length,
          videos: limitedVideos.map(v => ({
            title: v.title,
            url: v.url,
            coverUrl: v.coverUrl,
          })),
        },
        scrapedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[DouYin] List mode error:', err);
      return {
        url,
        platform: this.name,
        content: `Error scraping user page: ${err instanceof Error ? err.message : String(err)}`,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  /**
   * 详情模式：获取单个视频详情
   */
  private async scrapeDetail(url: string, options: DouYinScrapeOptions): Promise<ScrapeResult> {
    const videoId = this.extractVideoId(url);
    const outputDir = join(this.tempDir, videoId);
    await mkdir(outputDir, { recursive: true });

    let audioPath: string | undefined;
    let transcript: string | undefined;
    let transcriptLanguage: string | undefined;
    let metadata: any = {};

    try {
      const result = await this.captureAndDownloadAudio(url, outputDir, options);
      audioPath = result.audioPath;
      metadata = result.metadata;

      // 提取字幕（如果需要）
      if (options.extractTranscript && audioPath) {
        console.log('[DouYin] Extracting transcript...');
        const transcriptResult = await this.transcribeAudio(audioPath, outputDir, options.whisperModel || 'base');
        transcript = transcriptResult.text;
        transcriptLanguage = transcriptResult.language;
        console.log(`[DouYin] Transcript extracted: ${transcript.length} characters`);
      }
    } catch (err) {
      console.error('[DouYin] Failed to capture audio:', err);
    }

    return {
      url,
      platform: this.name,
      title: metadata.title || 'Unknown',
      author: metadata.author,
      description: metadata.description,
      publishedAt: metadata.publishedAt,
      transcript,
      transcriptLanguage,
      audioPath: options.downloadAudio ? audioPath : undefined,
      metadata: {
        duration: metadata.duration,
        coverUrl: metadata.coverUrl,
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * 使用 Playwright 拦截网络请求，捕获音频 URL 并下载
   */
  private async captureAndDownloadAudio(
    pageUrl: string,
    outputDir: string,
    options: ScrapeOptions
  ): Promise<{ audioPath: string; metadata: any }> {
    const pw = await getPlaywright();
    const axios = await getAxios();

    const audioPath = join(outputDir, 'audio.m4a');
    let browser: import('playwright').Browser | null = null;
    let audioUrl: string | null = null;
    const metadata: any = {};

    try {
      console.log('[DouYin] Launching browser to capture audio...');

      browser = await pw.chromium.launch({
        headless: !options.debug,
        args: ['--disable-blink-features=AutomationControlled'],
      });

      const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: BROWSER_UA,
      });

      // 加载并注入 cookies
      await this.injectCookies(context, options.browser || 'chrome');

      const page = await context.newPage();

      // 设置拦截器捕获音频请求
      let resolveCapture: (() => void) | null = null;
      const capturePromise = new Promise<void>(resolve => {
        resolveCapture = resolve;
      });

      // 捕获请求头用于后续下载
      let capturedHeaders: Record<string, string> = {
        'user-agent': BROWSER_UA,
        referer: pageUrl,
      };

      console.log('[DouYin] Setting up response interceptor...');

      page.on('response', async (response) => {
        const respUrl = response.url();

        // 尝试从页面 API 响应中提取视频信息
        if (respUrl.includes('/aweme/v1/web/aweme/detail/') || respUrl.includes('/aweme/v1/aweme/details/')) {
          try {
            const data = await response.json();
            if (data?.aweme_detail) {
              const detail = data.aweme_detail;
              metadata.title = detail.desc;
              metadata.author = detail.author?.nickname;
              metadata.description = detail.desc;
              metadata.duration = detail.duration;
              metadata.coverUrl = detail.video?.cover?.url_list?.[0];
              metadata.createTime = detail.create_time;
            }
          } catch {
            // 忽略解析错误
          }
        }

        // 只匹配抖音 CDN 纯音频请求 (media-audio)
        if (!respUrl.includes('douyinvod') || !respUrl.includes('media-audio')) {
          return;
        }

        const isFirstCapture = !audioUrl;
        audioUrl = respUrl;

        // 捕获原始请求头以便后续下载
        try {
          capturedHeaders = {
            ...capturedHeaders,
            ...(await response.request().allHeaders()),
          };
        } catch {
          // 忽略
        }

        if (isFirstCapture) {
          console.log(`[DouYin] Captured audio URL: ${respUrl.slice(0, 120)}...`);
          resolveCapture?.();
        }
      });

      // 导航到页面
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // 等待网络空闲 + 额外时间让播放器加载
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(5000);

      // 如果还没捕获到，等待更长时间
      if (!audioUrl) {
        console.log('[DouYin] Waiting for audio URL to load...');
        await Promise.race([capturePromise, page.waitForTimeout(20000)]);
      }

      // 等待页面关键元素渲染（SPA 异步挂载）
      await page.waitForSelector('[data-e2e="video-desc"]', { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('.video-create-time', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // 从页面 DOM 提取发布时间和标题
      const pageInfo = await page.evaluate(() => {
        const timeEl = document.querySelector('[data-e2e="detail-video-publish-time"]');
        const titleEl = document.querySelector('[data-e2e="video-desc"]');
        return {
          publishTimeText: timeEl?.textContent?.trim() || '',
          pageTitle: titleEl?.textContent?.trim() || '',
          rawTimeHTML: timeEl?.outerHTML || '',
          rawTitleHTML: titleEl?.outerHTML?.slice(0, 500) || '',
        };
      });

      console.log(`[DouYin] DOM extracted: publishTime="${pageInfo.publishTimeText}", pageTitle length=${pageInfo.pageTitle.length}`);
      if (pageInfo.rawTimeHTML) {
        console.log(`[DouYin] Time element HTML: ${pageInfo.rawTimeHTML}`);
      }

      if (pageInfo.publishTimeText) {
        // 格式: "发布时间：2026-03-17 19:55"
        const match = pageInfo.publishTimeText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
        if (match) {
          const [, year, month, day, hour, minute] = match;
          metadata.publishedAt = new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            parseInt(hour),
            parseInt(minute)
          ).toISOString();
          console.log(`[DouYin] Parsed publishedAt: ${metadata.publishedAt}`);
        } else {
          // 回退：尝试相对时间
          const parsedDate = this.parseRelativeTime(pageInfo.publishTimeText);
          if (parsedDate) {
            metadata.publishedAt = parsedDate.toISOString();
            console.log(`[DouYin] Parsed relative publishedAt: ${metadata.publishedAt}`);
          } else {
            console.log(`[DouYin] Failed to parse publish time: "${pageInfo.publishTimeText}"`);
          }
        }
      }

      if (pageInfo.pageTitle) {
        metadata.title = pageInfo.pageTitle;
        metadata.description = pageInfo.pageTitle;
      }

      // 获取 Cookie 用于下载
      let cookieHeader = '';
      if (audioUrl) {
        try {
          const ctxCookies = await context.cookies(audioUrl);
          if (ctxCookies.length > 0) {
            cookieHeader = ctxCookies.map(c => `${c.name}=${c.value}`).join('; ');
          }
        } catch {
          // 忽略
        }
      }

      await page.close();

      if (!audioUrl) {
        throw new Error('No audio URL captured from network responses');
      }

      // 用 axios 下载音频
      console.log('[DouYin] Downloading audio...');

      const requestHeaders: Record<string, string> = {
        'user-agent': capturedHeaders['user-agent'] || BROWSER_UA,
        referer: capturedHeaders.referer || pageUrl,
      };
      if (capturedHeaders.accept) {
        requestHeaders.accept = capturedHeaders.accept;
      }
      if (cookieHeader) {
        requestHeaders.cookie = cookieHeader;
      }

      const response = await axios.get(audioUrl, {
        responseType: 'stream',
        headers: requestHeaders,
        timeout: 60000,
        maxRedirects: 5,
      });

      console.log(`[DouYin] Download response: status=${response.status}`);
      await pipeline(response.data, createWriteStream(audioPath));

      // 处理 partial range：如果返回 206 且 range 不从 0 开始，用清理后的 URL 重试
      const contentRange = typeof response.headers['content-range'] === 'string'
        ? response.headers['content-range']
        : '';
      const isNonZeroPartialRange =
        response.status === 206 &&
        /^bytes\s+(?!0-)/i.test(contentRange);

      if (isNonZeroPartialRange) {
        console.log(`[DouYin] Detected partial-range response, retrying with full URL`);
        const fullUrl = this.sanitizeAudioUrl(audioUrl);
        if (fullUrl !== audioUrl) {
          const retryResponse = await axios.get(fullUrl, {
            responseType: 'stream',
            headers: requestHeaders,
            timeout: 60000,
            maxRedirects: 5,
          });
          await pipeline(retryResponse.data, createWriteStream(audioPath));
        }
      }

      // 验证文件有效性
      const fileStat = await stat(audioPath).catch(() => null);
      if (!fileStat || fileStat.size < 16 * 1024) {
        throw new Error(`Downloaded audio file is too small: ${fileStat?.size ?? 0} bytes`);
      }

      console.log(`[DouYin] Audio saved: ${audioPath} (${fileStat.size} bytes)`);

      return { audioPath, metadata };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  /** 解析中文相对时间为绝对时间 */
  private parseRelativeTime(text: string): Date | undefined {
    const trimmed = text.replace(/^·\s*/, '').trim();
    const now = new Date();

    if (trimmed === '刚刚') return now;

    const minMatch = trimmed.match(/(\d+)\s*分钟前/);
    if (minMatch) {
      return new Date(now.getTime() - parseInt(minMatch[1]) * 60 * 1000);
    }

    const hourMatch = trimmed.match(/(\d+)\s*小时前/);
    if (hourMatch) {
      return new Date(now.getTime() - parseInt(hourMatch[1]) * 60 * 60 * 1000);
    }

    const dayMatch = trimmed.match(/(\d+)\s*天前/);
    if (dayMatch) {
      return new Date(now.getTime() - parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000);
    }

    if (trimmed === '昨天') {
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    const weekMatch = trimmed.match(/(\d+)\s*周前/);
    if (weekMatch) {
      return new Date(now.getTime() - parseInt(weekMatch[1]) * 7 * 24 * 60 * 60 * 1000);
    }

    const monthMatch = trimmed.match(/(\d+)\s*月前/);
    if (monthMatch) {
      return new Date(now.getTime() - parseInt(monthMatch[1]) * 30 * 24 * 60 * 60 * 1000);
    }

    const yearMatch = trimmed.match(/(\d+)\s*年前/);
    if (yearMatch) {
      return new Date(now.getTime() - parseInt(yearMatch[1]) * 365 * 24 * 60 * 60 * 1000);
    }

    return undefined;
  }

  /** 删除 URL 中的 range 参数以获取完整音频 */
  private sanitizeAudioUrl(url: string): string {
    try {
      const parsed = new URL(url);
      for (const key of ['range', 'byterange', 'byte_range', 'start', 'end']) {
        parsed.searchParams.delete(key);
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  /**
   * 从 cookie 缓存文件加载并注入 cookies
   */
  private async injectCookies(
    context: import('playwright').BrowserContext,
    browserName: string
  ): Promise<void> {
    try {
      const cookiePath = join('./cache/cookies', `douyin_${browserName}.txt`);
      const content = await readFile(cookiePath, 'utf-8').catch(() => null);

      if (!content) {
        console.log('[DouYin] No cached cookies found');
        return;
      }

      const cookies = this.parseNetscapeCookies(content);
      if (cookies.length > 0) {
        await context.addCookies(cookies);
        console.log(`[DouYin] Injected ${cookies.length} cookies`);
      }
    } catch (err) {
      console.error('[DouYin] Failed to inject cookies:', err);
    }
  }

  /**
   * 解析 Netscape cookies 格式
   */
  private parseNetscapeCookies(content: string): Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }> {
    const cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: 'Strict' | 'Lax' | 'None';
    }> = [];

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        const [domain, flag, path, secure, expires, name, value] = parts;
        let expiresValue = parseInt(expires, 10);

        // 处理微秒/毫秒时间戳转换
        if (expiresValue > 9999999999999) {
          expiresValue = Math.floor(expiresValue / 1000000);
        } else if (expiresValue > 9999999999) {
          expiresValue = Math.floor(expiresValue / 1000);
        }

        // 只保留 douyin.com 相关的 cookies
        if (domain.includes('douyin.com') || domain.includes('douyinstatic.com')) {
          cookies.push({
            name,
            value,
            domain: domain.startsWith('.') ? domain : `.${domain}`,
            path,
            expires: expiresValue > 0 ? expiresValue : undefined,
            httpOnly: flag === 'TRUE',
            secure: secure === 'TRUE',
            sameSite: 'Lax',
          });
        }
      }
    }

    return cookies;
  }

  private extractVideoId(url: string): string {
    const patterns = [
      /video\/([a-zA-Z0-9_-]+)/,
      /\/([a-zA-Z0-9_-]{19,})/,
      /modal_id=([0-9]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.length > 10) {
        return lastPart;
      }
    } catch {
      // 忽略
    }

    return 'douyin_' + Date.now();
  }

  /**
   * 将音频转换为 WAV 并使用 Whisper 转录
   */
  private async transcribeAudio(
    audioPath: string,
    outputDir: string,
    modelName: string
  ): Promise<{ text: string; language: string }> {
    // 转换为 WAV 格式
    const wavPath = join(outputDir, 'audio.wav');
    console.log('[DouYin] Converting to WAV...');
    await this.convertToWav(audioPath, wavPath);

    // 获取音频时长
    const duration = await this.getAudioDuration(wavPath);
    console.log(`[DouYin] Audio duration: ${duration}s`);

    // 使用 Whisper 转录
    const modelPath = join(this.modelsDir, `ggml-${modelName}.bin`);
    const outputPrefix = join(outputDir, 'subtitles');

    console.log('[DouYin] Transcribing with Whisper...');
    await this.spawnAsync('whisper-cli', [
      '-m', modelPath,
      '-f', wavPath,
      '-l', 'zh',
      '-osrt',
      '-of', outputPrefix,
    ]);

    // 读取 SRT 文件
    const srtPath = `${outputPrefix}.srt`;
    if (!existsSync(srtPath)) {
      throw new Error('Whisper did not generate SRT file');
    }

    const srtContent = readFileSync(srtPath, 'utf-8');
    const textLines = srtContent
      .split('\n')
      .filter(line => line.trim() && !/^\d+$/.test(line.trim()) && !/-->/.test(line))
      .map(line => line.trim().replace(/^"+|"+$/g, ''));

    const text = textLines.join('');
    console.log(`[DouYin] Transcription complete: ${text.length} characters`);

    return { text, language: 'zh' };
  }

  /**
   * 使用 ffmpeg 转换为 16kHz mono WAV
   */
  private async convertToWav(inputPath: string, outputPath: string): Promise<void> {
    await this.spawnAsync('ffmpeg', [
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-y',
      outputPath,
    ]);
  }

  /**
   * 获取音频时长
   */
  private async getAudioDuration(audioPath: string): Promise<number> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ]);
      let out = '';
      ffprobe.stdout.on('data', (d) => { out += d.toString(); });
      ffprobe.on('close', () => {
        const sec = parseFloat(out.trim());
        resolve(isNaN(sec) ? 0 : Math.round(sec));
      });
      ffprobe.on('error', () => resolve(0));
    });
  }

  /**
   * 执行命令行工具
   */
  private spawnAsync(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });
  }
}
