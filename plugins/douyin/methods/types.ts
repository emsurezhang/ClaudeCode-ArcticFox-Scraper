import type { ScrapeOptions } from '../../../src/interfaces/index.js';

export interface DouYinScrapeOptions extends ScrapeOptions {
  mode?: 'list' | 'detail';
  whisperModel?: string;
}

export interface DouYinPluginConfig {
  listPageLoadWaitMs: number;
  listVideoSelectorTimeoutMs: number;
  listScrollWaitMs: number;
  scrollStepIntervalMs: number;
  scrollHeightChangeTimeoutMs: number;
  scrollSettleWaitMs: number;
  loginCheckRetryWaitMs: number;
  detailDomReadyWaitMs: number;
  detailCaptureTimeoutMs: number;
}

export interface DouYinVideoItem {
  title: string;
  url: string;
  videoId: string;
  coverUrl?: string;
}

export interface DouYinListExtractResult {
  nickname: string;
  videos: DouYinVideoItem[];
}

export interface DouYinDetailExtractResult {
  title: string;
  author?: string;
  description?: string;
  publishedAt?: string;
  transcript?: string;
  transcriptLanguage?: string;
  audioPath?: string;
  metadata: {
    mode: 'detail';
    duration?: number;
    coverUrl?: string;
    createTime?: number;
  };
}

export interface DouYinLoginStatus {
  /** 页面上检测到验证码遮罩层 */
  hasCaptcha: boolean;
  /** 检测到用户头像，表示已登录 */
  hasAvatar: boolean;
  /** 检测到登录按钮，表示未登录 */
  hasLoginButton: boolean;
  /** 当前页面 URL */
  currentUrl: string;
}

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export const DOUYIN_DOMAIN_FILTER = (domain: string): boolean =>
  domain.includes('douyin.com') || domain.includes('douyinstatic.com');
