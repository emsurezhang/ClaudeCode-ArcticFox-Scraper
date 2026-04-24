/**
 * YouTube 插件 - 支持视频刮削、音频下载和字幕提取
 *
 * 模式支持:
 * - detail: 获取单个视频详情
 * - list: 获取频道/播放列表视频列表 (Playwright DOM 提取)
 *
 * 字幕提取流程:
 * 1. 下载音频 (yt-dlp)
 * 2. ffmpeg 分片 (如音频过长)
 * 3. Whisper 本地转录
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { mkdir, unlink, rename } from 'fs/promises';
import { join, resolve, basename } from 'path';
import type {
  IPlatformPlugin,
  ScrapeResult,
  ScrapeOptions,
} from '../../src/interfaces/index.js';
import { WhisperTranscriber } from '../../src/utils/whisper-transcriber.js';

interface YouTubePluginConfig {
  /** 页面初始加载等待时间（毫秒） */
  pageLoadWaitMs: number;
  /** Cookie 刷新后重新验证登录的等待时间（毫秒） */
  loginCheckRetryWaitMs: number;
  /** 滚动后等待页面高度变化的超时时间（毫秒） */
  scrollHeightChangeTimeoutMs: number;
  /** 页面高度变化后的额外稳定等待时间（毫秒） */
  scrollSettleWaitMs: number;
  /** 分段滚动时每步之间的间隔时间（毫秒） */
  scrollStepIntervalMs: number;
  /** 连续无新内容多少次后停止滚动 */
  maxNoNewContentStreak: number;
}

interface YouTubeScrapeOptions extends ScrapeOptions {
  mode?: 'list' | 'detail';
  maxItems?: number;
  /** Whisper 模型名称: tiny, base, small, medium, large */
  whisperModel?: string;
}

interface VideoItem {
  title: string;
  url: string;
  channel?: string;
  duration?: number;
  viewCount?: number;
  publishedAt?: string;
  thumbnail?: string;
}

interface VideoMetadata {
  title: string;
  author: string;
  description: string;
  publishedAt?: string;
  duration?: number;
  viewCount?: number;
  likeCount?: number;
  thumbnail?: string;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 动态导入 Playwright */
let playwright: typeof import('playwright') | null = null;

async function getPlaywright(): Promise<typeof import('playwright')> {
  if (!playwright) {
    playwright = await import('playwright');
  }
  return playwright;
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

  private tempDir = './cache/temp';
  private config: YouTubePluginConfig;

  constructor() {
    mkdir(this.tempDir, { recursive: true }).catch((err) => console.warn('[YouTube] Warning:', err));
    this.config = this.loadConfig();
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
      return { ...defaults, ...JSON.parse(content) } as YouTubePluginConfig;
    } catch {
      console.log('[YouTube] Using default config');
      return defaults;
    }
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
    console.log(`[YouTube] Scraping: ${url} (mode: ${mode})`);

    if (mode === 'list') {
      return this.scrapeList(url, options);
    } else {
      return this.scrapeDetail(url, options);
    }
  }

  /**
   * 列表模式：获取频道/播放列表视频列表
   */
  private async scrapeList(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    const maxItems = options.maxItems || 50;
    console.log(`[YouTube] List mode: collecting up to ${maxItems} videos`);

    const videos = await this.getPlaylistVideos(url, maxItems, options);

    if (videos.length === 0) {
      return {
        url,
        platform: this.name,
        content: 'No videos found in playlist/channel',
        scrapedAt: new Date().toISOString(),
      };
    }

    // 获取频道信息（从第一个视频）
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
        videos: videos.map(v => ({
          title: v.title,
          url: v.url,
          duration: v.duration,
          viewCount: v.viewCount,
          publishedAt: v.publishedAt,
          thumbnail: v.thumbnail,
        })),
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * 详情模式：获取单个视频详情
   */
  private async scrapeDetail(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    console.log(`[YouTube] Detail mode: getting video info`);

    // 1. 获取视频元数据
    const metadata = await this.getMetadata(url);

    // 2. 下载音频（如果需要字幕或需要下载音频）
    let audioPath: string | undefined;
    if (options.downloadAudio || options.extractTranscript) {
      audioPath = await this.downloadAudio(url);
    }

    // 3. 使用 Whisper 本地转录提取字幕
    let transcript: string | undefined;
    let transcriptLanguage: string | undefined;

    if (options.extractTranscript && audioPath) {
      console.log(`[YouTube] Extracting transcript from audio...`);
      const transcriber = new WhisperTranscriber({
        modelsDir: './models',
        tempDir: this.tempDir,
        modelName: options.whisperModel || 'base',
      });

      const result = await transcriber.transcribe(audioPath);
      if (result) {
        transcript = result.text;
        transcriptLanguage = result.language;
        console.log(`[YouTube] Transcript extracted: ${transcript.length} characters`);
      } else {
        console.log('[YouTube] Failed to extract transcript');
      }
    }

    // 处理音频文件保存或清理
    const shouldKeepAudio = options.downloadAudio;
    let finalAudioPath = audioPath;
    if (shouldKeepAudio && audioPath) {
      const dateDir = options.audioOutputDir || join(resolve('..'), 'data', new Date().toISOString().slice(0, 10));
      await mkdir(dateDir, { recursive: true });
      const destPath = join(dateDir, basename(audioPath));
      await rename(audioPath, destPath);
      console.log(`[YouTube] Audio saved to: ${destPath}`);
      finalAudioPath = destPath;
    } else if (!shouldKeepAudio && audioPath) {
      await unlink(audioPath).catch((err) => console.warn('[YouTube] Warning:', err));
      console.log(`[YouTube] Cleaned up temp audio: ${audioPath}`);
    }

    return {
      url,
      platform: this.name,
      title: metadata.title,
      author: metadata.author,
      description: metadata.description,
      publishedAt: metadata.publishedAt,
      transcript,
      transcriptLanguage,
      audioPath: finalAudioPath,
      metadata: {
        mode: 'detail',
        duration: metadata.duration,
        viewCount: metadata.viewCount,
        likeCount: metadata.likeCount,
        thumbnail: metadata.thumbnail,
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * 获取播放列表/频道视频列表（Playwright DOM 提取，无 yt-dlp）
   */
  private async getPlaylistVideos(
    url: string,
    maxItems: number,
    options: ScrapeOptions
  ): Promise<VideoItem[]> {
    const pw = await getPlaywright();
    let browser: import('playwright').Browser | null = null;
    let context: import('playwright').BrowserContext | undefined;
    let page: import('playwright').Page | undefined;
    const usePool = !options.debug && options.browserPool;

    try {
      if (usePool) {
        context = await options.browserPool!.acquire(this.name, options.browser || 'chrome');
      } else {
        browser = await pw.chromium.launch({
          headless: !options.debug,
          args: ['--disable-blink-features=AutomationControlled'],
        });
        context = await browser.newContext({
          viewport: { width: 1366, height: 900 },
          userAgent: BROWSER_UA,
        });
      }

      // 注入 cookies
      await this.injectCookies(context, options.browser || 'chrome');

      page = await context.newPage();
      console.log('[YouTube] Navigating to list page...');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(this.config.pageLoadWaitMs);

      // 检测登录状态（含登录表单特征检测）
      const loginStatus = await page.evaluate(() => {
        const avatarBtn = document.querySelector('button#avatar-btn, yt-img-shadow#avatar-btn, img[alt="Avatar"]');
        const signInLink = document.querySelector('a[href="https://accounts.google.com/ServiceLogin"], a.yt-spec-button-shape-next--outline');
        const createBtn = document.querySelector('ytd-topbar-menu-button-renderer button, #create-icon');
        // 登录表单特征：URL 跳转 / Google 邮箱输入框 / YouTube 登录组件
        const isLoginPage =
          window.location.href.includes('accounts.google.com') ||
          !!document.querySelector('#identifierId') ||
          !!document.querySelector('ytd-signin-renderer') ||
          !!document.querySelector('yt-upsell-dialog-renderer');
        return {
          hasAvatar: !!avatarBtn,
          hasSignIn: !!signInLink,
          hasCreate: !!createBtn,
          isLoginPage,
          currentUrl: window.location.href,
          userName: document.querySelector('button#avatar-btn img')?.getAttribute('alt') || '',
        };
      });
      console.log(`[YouTube] Login status: avatar=${loginStatus.hasAvatar}, signIn=${loginStatus.hasSignIn}, loginPage=${loginStatus.isLoginPage}, url=${loginStatus.currentUrl}`);

      // 若检测到未登录 / 出现登录表单，自动尝试刷新 cookies 并重试
      if (loginStatus.isLoginPage || (!loginStatus.hasAvatar && loginStatus.hasSignIn)) {
        console.warn('[YouTube] 检测到未登录状态（cookies 失效），正在尝试重新获取 cookies 并重试...');
        const refreshed = await this.refreshCookiesAndReload(page, context, options.browser || 'chrome', url);
        if (!refreshed) {
          const alertMsg = '[YouTube] ALERT: Cookie 自动刷新失败，登录仍未成功。请检查浏览器是否已登录 YouTube，然后手动重启服务以重新提取 cookies。';
          console.error(alertMsg);
          throw new Error(alertMsg);
        }
        console.log('[YouTube] Cookie 刷新成功，继续抓取...');
      }

      // 判断页面类型：播放列表 / 频道主页 / Shorts
      const isPlaylist = url.includes('/playlist?list=');
      const isShorts = url.includes('/shorts') || url.includes('@') && url.includes('/shorts');

      console.log(`[YouTube] Page type: ${isPlaylist ? 'playlist' : isShorts ? 'shorts' : 'channel'}`);

      const videos: VideoItem[] = [];
      let noNewContentStreak = 0;
      const MAX_NO_NEW_STREAK = this.config.maxNoNewContentStreak;
      let scrollAttempts = 0;
      const maxScrollAttempts = Math.ceil(maxItems / 20) + 5;

      while (videos.length < maxItems && scrollAttempts < maxScrollAttempts && noNewContentStreak < MAX_NO_NEW_STREAK) {
        // 提取页面视频数据 —— 零内部函数，彻底避免 esbuild __name 注入
        const newVideos = await page.evaluate((opts: {
          maxItems: number;
          isPlaylist: boolean;
          existingUrls: string[];
        }) => {
          const result: Array<{
            title: string;
            url: string;
            channel?: string;
            duration?: number;
            viewCount?: number;
            publishedAt?: string;
            thumbnail?: string;
          }> = [];
          const existing = new Set(opts.existingUrls);

          const items = opts.isPlaylist
            ? document.querySelectorAll('ytd-playlist-video-renderer')
            : document.querySelectorAll('ytd-rich-item-renderer');

          for (const item of items) {
            if (result.length >= opts.maxItems) break;

            let title = '';
            let href: string | null = null;
            let channel = '';
            let thumbnail = '';
            let duration: number | undefined;
            let viewCount: number | undefined;
            let publishedAt: string | undefined;

            if (opts.isPlaylist) {
              const titleLink = item.querySelector('#video-title') as HTMLAnchorElement | null;
              title = titleLink?.getAttribute('title')?.trim() || titleLink?.textContent?.trim() || '';
              href = titleLink?.getAttribute('href') ?? null;

              const channelEl = item.querySelector('ytd-channel-name #text a, #channel-name a, .ytd-channel-name a');
              channel = channelEl?.textContent?.trim() || '';

              const thumbEl = item.querySelector('yt-img-shadow img, ytd-thumbnail img');
              thumbnail = thumbEl?.getAttribute('src') || '';

              const durEl = item.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, #time-status #text, span.ytd-thumbnail-overlay-time-status-renderer');
              if (durEl) {
                const durText = durEl.textContent?.trim() || '';
                const parts = durText.split(':').map((x) => parseInt(x, 10));
                if (!parts.some(isNaN)) {
                  if (parts.length === 2) duration = parts[0] * 60 + parts[1];
                  if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
              }

              const metaItems = item.querySelectorAll('#video-info span, #byline-container span, .inline-metadata-item, ytd-video-meta-block span');
              for (const el of metaItems) {
                const txt = el.textContent?.trim() || '';
                if (!viewCount && (txt.includes('view') || txt.includes('观看') || txt.includes('次') || /\d+/.test(txt))) {
                  const clean = txt.replace(/,/g, '').trim();
                  const m = clean.match(/([\d.]+)\s*万/);
                  if (m) { viewCount = Math.round(parseFloat(m[1]) * 10000); }
                  else {
                    const m2 = clean.match(/([\d.]+)\s*[Kk]/);
                    if (m2) { viewCount = Math.round(parseFloat(m2[1]) * 1000); }
                    else {
                      const m3 = clean.match(/(\d+)/);
                      if (m3) { viewCount = parseInt(m3[1], 10); }
                    }
                  }
                }
                if (!publishedAt) {
                  const now = new Date();
                  let match: RegExpMatchArray | null;
                  if ((match = txt.match(/(\d+)\s*(分钟|分鐘|minute|min)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 60 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(小时|小時|hour|hr)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(天|day)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 24 * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(周|星期|week|wk)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 7 * 24 * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(月|month|mo)s?\s*前|ago/i))) {
                    const d = new Date(now); d.setMonth(d.getMonth() - parseInt(match[1], 10));
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(年|year|yr)s?\s*前|ago/i))) {
                    const d = new Date(now); d.setFullYear(d.getFullYear() - parseInt(match[1], 10));
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if (txt.match(/昨天|yesterday/i)) {
                    const d = new Date(now.getTime() - 24 * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else {
                    const absMatch = txt.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
                    if (absMatch) {
                      const d = new Date(absMatch[1] + '-' + absMatch[2] + '-' + absMatch[3]);
                      publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                    }
                  }
                }
              }
            } else {
              const media = item.querySelector('ytd-rich-grid-media');
              if (!media) continue;

              const titleLink = media.querySelector('#video-title-link') as HTMLAnchorElement | null;
              title = titleLink?.getAttribute('title')?.trim() || titleLink?.textContent?.trim() || '';
              href = titleLink?.getAttribute('href') ?? null;

              const channelEl = media.querySelector('#channel-name #text, ytd-channel-name #text');
              channel = channelEl?.textContent?.trim() || '';

              const thumbEl = media.querySelector('ytd-thumbnail img, yt-image img');
              thumbnail = thumbEl?.getAttribute('src') || '';

              const durEl = media.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, badge-shape .ytBadgeShapeText');
              if (durEl) {
                const durText = durEl.textContent?.trim() || '';
                const parts = durText.split(':').map((x) => parseInt(x, 10));
                if (!parts.some(isNaN)) {
                  if (parts.length === 2) duration = parts[0] * 60 + parts[1];
                  if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
              }

              const metaItems = media.querySelectorAll('.inline-metadata-item, ytd-video-meta-block span, #metadata-line span');
              for (const el of metaItems) {
                const txt = el.textContent?.trim() || '';
                if (!viewCount && (txt.includes('view') || txt.includes('观看') || txt.includes('次') || /\d+/.test(txt))) {
                  const clean = txt.replace(/,/g, '').trim();
                  const m = clean.match(/([\d.]+)\s*万/);
                  if (m) { viewCount = Math.round(parseFloat(m[1]) * 10000); }
                  else {
                    const m2 = clean.match(/([\d.]+)\s*[Kk]/);
                    if (m2) { viewCount = Math.round(parseFloat(m2[1]) * 1000); }
                    else {
                      const m3 = clean.match(/(\d+)/);
                      if (m3) { viewCount = parseInt(m3[1], 10); }
                    }
                  }
                }
                if (!publishedAt) {
                  const now = new Date();
                  let match: RegExpMatchArray | null;
                  if ((match = txt.match(/(\d+)\s*(分钟|分鐘|minute|min)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 60 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(小时|小時|hour|hr)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(天|day)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 24 * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(周|星期|week|wk)s?\s*前|ago/i))) {
                    const d = new Date(now.getTime() - parseInt(match[1], 10) * 7 * 24 * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(月|month|mo)s?\s*前|ago/i))) {
                    const d = new Date(now); d.setMonth(d.getMonth() - parseInt(match[1], 10));
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if ((match = txt.match(/(\d+)\s*(年|year|yr)s?\s*前|ago/i))) {
                    const d = new Date(now); d.setFullYear(d.getFullYear() - parseInt(match[1], 10));
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else if (txt.match(/昨天|yesterday/i)) {
                    const d = new Date(now.getTime() - 24 * 3600 * 1000);
                    publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                  } else {
                    const absMatch = txt.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
                    if (absMatch) {
                      const d = new Date(absMatch[1] + '-' + absMatch[2] + '-' + absMatch[3]);
                      publishedAt = d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' + (d.getMonth() + 1) : (d.getMonth() + 1)) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate()) + ' ' + (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' + (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes()) + ':' + (d.getSeconds() < 10 ? '0' + d.getSeconds() : d.getSeconds());
                    }
                  }
                }
              }
            }

            const videoUrl = href ? (href.startsWith('http') ? href : 'https://www.youtube.com' + href) : '';
            if (!videoUrl || existing.has(videoUrl)) continue;
            result.push({ title, url: videoUrl, channel, duration, viewCount, publishedAt, thumbnail });
          }

          return result;
        }, { maxItems: maxItems - videos.length, isPlaylist, existingUrls: videos.map((v) => v.url) });

        // 合并新视频（去重）
        const countBefore = videos.length;
        for (const v of newVideos) {
          if (!videos.find((existing) => existing.url === v.url)) {
            videos.push(v);
          }
        }

        const gained = videos.length - countBefore;
        if (gained === 0) {
          noNewContentStreak++;
          console.log(`[YouTube] 本次滚动无新视频（连续 ${noNewContentStreak}/${this.config.maxNoNewContentStreak} 次无新内容）`);
        } else {
          noNewContentStreak = 0;
          console.log(`[YouTube] 已加载 ${videos.length} 个视频（本次 +${gained}）...`);
        }

        if (noNewContentStreak >= MAX_NO_NEW_STREAK) {
          console.log('[YouTube] 连续多次无新内容，已到达页面底部，停止滚动');
          break;
        }

        if (videos.length >= maxItems) {
          console.log(`[YouTube] 已达到目标数量 ${maxItems} 个，停止滚动`);
          break;
        }

        // 分段模拟鼠标滚轮滚动到底部，触发 YouTube 懒加载监听器
        const prevHeight = await page.evaluate(() => document.body.scrollHeight);
        const viewportHeight = page.viewportSize()?.height ?? 900;
        const currentScrollY = await page.evaluate(() => window.scrollY);
        const totalScroll = prevHeight - currentScrollY - viewportHeight;
        const step = Math.max(viewportHeight, 500);
        const steps = Math.max(1, Math.ceil(totalScroll / step));
        for (let i = 0; i < steps; i++) {
          await page.mouse.wheel(0, step);
          await page.waitForTimeout(this.config.scrollStepIntervalMs);
        }
        // 等待页面高度增加（表示新内容已渲染）
        await page.waitForFunction(
          (h: number) => document.body.scrollHeight > h,
          prevHeight,
          { timeout: this.config.scrollHeightChangeTimeoutMs }
        ).catch(() => {});
        await page.waitForTimeout(this.config.scrollSettleWaitMs);
        scrollAttempts++;
      }

      if (videos.length >= maxItems) {
        console.log(`[YouTube] 已达到目标数量，共收集 ${videos.length} 个视频`);
      } else {
        console.log(`[YouTube] 已到达页面底部，共收集 ${videos.length} 个视频（目标: ${maxItems}）`);
      }

      await page.close();
      return videos.slice(0, maxItems);
    } catch (err) {
      console.error('[YouTube] List scraping error:', err);
      return [];
    } finally {
      if (page) {
        await page.close().catch((err) => console.warn('[YouTube] Warning:', err));
      }
      if (usePool && options.browserPool && context) {
        await options.browserPool.release(this.name, options.browser || 'chrome', context);
      } else if (browser) {
        await browser.close().catch((err) => console.warn('[YouTube] Warning:', err));
      }
    }
  }

  /**
   * 清除旧 Cookie 缓存，从浏览器重新提取，注入到 context 后重新加载页面。
   * 返回 true 表示刷新后登录成功，false 表示仍未登录（需发出告警）。
   */
  private async refreshCookiesAndReload(
    page: import('playwright').Page,
    context: import('playwright').BrowserContext,
    browserName: string,
    url: string,
  ): Promise<boolean> {
    try {
      const fs = await import('fs/promises');
      const cookiePath = join('./cache/cookies', `youtube_${browserName}.txt`);

      // 删除过期的 cookie 缓存
      await fs.unlink(cookiePath).catch(() => {});
      console.log('[YouTube] 已清除旧 cookies 缓存，正在从浏览器重新提取...');

      // 重新从浏览器提取
      const newContent = await this.extractCookiesFromBrowser(browserName);
      if (!newContent) {
        console.error('[YouTube] 无法从浏览器重新提取 cookies（yt-dlp 失败）');
        return false;
      }

      // 写入新缓存
      await fs.writeFile(cookiePath, newContent, 'utf-8');
      console.log('[YouTube] 新 cookies 已写入缓存');

      // 清除 context 中的旧 cookies，重新注入
      await context.clearCookies();
      await this.injectCookies(context, browserName);

      // 重新加载目标页面
      console.log('[YouTube] 重新加载页面以验证登录状态...');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(this.config.loginCheckRetryWaitMs);

      // 再次检测登录状态
      const retryStatus = await page.evaluate(() => {
        const avatarBtn = document.querySelector('button#avatar-btn, yt-img-shadow#avatar-btn, img[alt="Avatar"]');
        const signInLink = document.querySelector('a[href="https://accounts.google.com/ServiceLogin"], a.yt-spec-button-shape-next--outline');
        const isLoginPage =
          window.location.href.includes('accounts.google.com') ||
          !!document.querySelector('#identifierId') ||
          !!document.querySelector('ytd-signin-renderer') ||
          !!document.querySelector('yt-upsell-dialog-renderer');
        return { hasAvatar: !!avatarBtn, hasSignIn: !!signInLink, isLoginPage };
      });

      if (retryStatus.isLoginPage || (!retryStatus.hasAvatar && retryStatus.hasSignIn)) {
        console.error('[YouTube] Cookie 刷新后仍处于未登录状态');
        return false;
      }

      console.log('[YouTube] Cookie 刷新成功，已恢复登录');
      return true;
    } catch (err) {
      console.error('[YouTube] refreshCookiesAndReload 出错:', err);
      return false;
    }
  }

  /**
   * 注入 YouTube cookies，注入后验证登录状态
   */
  private async injectCookies(
    context: import('playwright').BrowserContext,
    browserName: string
  ): Promise<void> {
    try {
      const cookiePath = join('./cache/cookies', `youtube_${browserName}.txt`);
      const fs = await import('fs/promises');
      let content = await fs.readFile(cookiePath, 'utf-8').catch(() => null);

      // 如果没有缓存或文件为空，尝试从浏览器重新提取
      if (!content || content.trim().length === 0) {
        console.log('[YouTube] No cached cookies found, attempting to extract from browser...');
        content = await this.extractCookiesFromBrowser(browserName);
        if (content) {
          await fs.writeFile(cookiePath, content, 'utf-8');
        }
      }

      if (!content) {
        console.log('[YouTube] No cookies available');
        return;
      }

      const cookies = this.parseNetscapeCookies(content);
      if (cookies.length === 0) {
        console.log('[YouTube] No valid cookies after parsing');
        return;
      }

      // 批量注入，比逐条注入更高效
      let injected = 0;
      const failed: string[] = [];
      for (const cookie of cookies) {
        try {
          await context.addCookies([cookie]);
          injected++;
        } catch (e: any) {
          failed.push(`${cookie.name}(${cookie.domain}): ${e.message || 'unknown'}`);
        }
      }

      console.log(`[YouTube] Injected ${injected}/${cookies.length} cookies`);
      if (failed.length > 0) {
        console.log(`[YouTube] ${failed.length} cookies failed (first 3): ${failed.slice(0, 3).join('; ')}`);
      }

      // 验证关键 cookie 是否已注入
      const ctxCookies = await context.cookies('https://www.youtube.com');
      const hasLoginInfo = ctxCookies.some((c) => c.name === 'LOGIN_INFO');
      const hasSid = ctxCookies.some((c) => c.name === 'SID');
      console.log(`[YouTube] Context cookies: ${ctxCookies.length} total, LOGIN_INFO=${hasLoginInfo}, SID=${hasSid}`);
    } catch (err) {
      console.error('[YouTube] Failed to inject cookies:', err);
    }
  }

  /**
   * 使用 yt-dlp 从浏览器提取 cookies 到 Netscape 格式文件
   */
  private async extractCookiesFromBrowser(browserName: string): Promise<string | null> {
    const fs = await import('fs/promises');
    const tempFile = join(this.tempDir, `_yt_cookies_${Date.now()}.txt`);

    return new Promise((resolve) => {
      // yt-dlp --cookies-from-browser 会将提取的 cookies 写入 --cookies 指定的文件
      const args = [
        '--cookies-from-browser', browserName,
        '--cookies', tempFile,
        '--no-download',
        '-o', '/dev/null',
        'https://www.youtube.com/robots.txt',
      ];
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', async (code) => {
        try {
          const cookies = await fs.readFile(tempFile, 'utf-8');
          await fs.unlink(tempFile).catch(() => {});
          if (cookies && cookies.includes('Netscape HTTP Cookie File')) {
            resolve(cookies);
          } else {
            console.warn(`[YouTube] Cookie extraction produced invalid output (code=${code}): ${stderr}`);
            resolve(null);
          }
        } catch {
          await fs.unlink(tempFile).catch(() => {});
          console.warn(`[YouTube] Cookie extraction failed: ${stderr || `exit code ${code}`}`);
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        fs.unlink(tempFile).catch(() => {});
        console.warn('[YouTube] Cookie extraction error:', err);
        resolve(null);
      });
    });
  }

  /**
   * 解析 Netscape cookies 格式
   *
   * Netscape 格式每行 7 列（tab 分隔）:
   *   domain | includeSubdomains(flag) | path | secure | expires(秒) | name | value
   *
   * Playwright 的 addCookies 要求:
   * - __Host- cookies 必须是 host-only（domain 不带点前缀）、Secure、Path=/
   * - __Secure- cookies 必须有 Secure
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
    const MAX_EXPIRES_SEC = 32503680000;
    const WINDOWS_EPOCH_OFFSET_SEC = 11644473600;

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
      if (parts.length < 7) continue;

      const [rawDomain, flag, path, secure, rawExpires, name, ...valueParts] = parts;
      const value = valueParts.join('\t');

      if (!name || !name.trim()) continue;

      // 只保留 youtube.com / google.com / accounts.google.com 相关的 cookies
      const isRelevant =
        rawDomain.includes('youtube.com') ||
        rawDomain === 'google.com' ||
        rawDomain === '.google.com' ||
        rawDomain.includes('accounts.google.com');
      if (!isRelevant) continue;

      const isHostPrefixed = name.startsWith('__Host-');
      const isSecurePrefixed = name.startsWith('__Secure-');

      // __Host- cookies 必须是 host-only：domain 不带点前缀，且必须 Secure + Path=/
      let domain: string;
      if (isHostPrefixed) {
        // Playwright 接受不带点的 domain 表示 host-only
        domain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
      } else {
        domain = rawDomain.startsWith('.') ? rawDomain : `.${rawDomain}`;
      }

      const cookiePath = path && path.startsWith('/') ? path : '/';

      // 解析 expires
      let expiresValue: number | undefined;
      const rawNum = parseFloat(rawExpires);
      if (!isNaN(rawNum) && rawNum > 0) {
        let sec = rawNum;
        if (sec > 1e14) {
          sec = Math.floor(sec / 1e6) - WINDOWS_EPOCH_OFFSET_SEC;
        } else if (sec > 1e12) {
          sec = Math.floor(sec / 1e3);
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (sec > nowSec && sec <= MAX_EXPIRES_SEC) {
          expiresValue = Math.floor(sec);
        }
      }

      // __Host- 和 __Secure- 前缀的 cookies 必须有 Secure
      const isSecure = secure === 'TRUE' || isHostPrefixed || isSecurePrefixed;

      cookies.push({
        name: name.trim(),
        value,
        domain,
        path: cookiePath,
        ...(expiresValue !== undefined ? { expires: expiresValue } : {}),
        secure: isSecure,
        sameSite: 'Lax',
      });
    }

    return cookies;
  }

  private async getMetadata(url: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      const args = [
        '--dump-json',
        '--no-download',
        '--cookies-from-browser', 'chrome',
        '--proxy', 'http://127.0.0.1:7897',
        url,
      ];
      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });

      let output = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && output) {
          try {
            const data = JSON.parse(output);
            resolve({
              title: data.title,
              author: data.uploader || data.channel,
              description: data.description,
              publishedAt: data.upload_date ?
                `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}` :
                undefined,
              duration: data.duration,
              viewCount: data.view_count,
              likeCount: data.like_count,
              thumbnail: data.thumbnail,
            });
          } catch {
            reject(new Error('Failed to parse metadata'));
          }
        } else {
          reject(new Error(`yt-dlp failed: ${stderr || `exit code ${code}`}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private async downloadAudio(url: string): Promise<string> {
    const videoId = this.extractVideoId(url);
    const outputPath = join(this.tempDir, `${videoId}.mp3`);

    return new Promise((resolve, reject) => {
      const args = [
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--cookies-from-browser', 'chrome',
        '--proxy', 'http://127.0.0.1:7897',
        '-o', outputPath,
        url,
      ];
      const proc = spawn('yt-dlp', args, {
        stdio: 'ignore',
        timeout: 300000,
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`Failed to download audio: exit code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private extractVideoId(url: string): string {
    const patterns = [
      /[?&]v=([^&]+)/,
      /youtu\.be\/([^?&]+)/,
      /\/embed\/([^?&]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    return 'unknown';
  }
}