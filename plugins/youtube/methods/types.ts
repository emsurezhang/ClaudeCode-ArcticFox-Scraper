import type { ScrapeOptions } from '../../../src/interfaces/index.js';

export interface YouTubePluginConfig {
  pageLoadWaitMs: number;
  loginCheckRetryWaitMs: number;
  scrollHeightChangeTimeoutMs: number;
  scrollSettleWaitMs: number;
  scrollStepIntervalMs: number;
  maxNoNewContentStreak: number;
}

export interface YouTubeScrapeOptions extends ScrapeOptions {
  mode?: 'list' | 'detail';
  maxItems?: number;
  whisperModel?: string;
}

export interface VideoItem {
  title: string;
  url: string;
  channel?: string;
  duration?: number;
  viewCount?: number;
  publishedAt?: string;
  thumbnail?: string;
}

export interface VideoMetadata {
  title: string;
  author: string;
  description: string;
  publishedAt?: string;
  duration?: number;
  viewCount?: number;
  likeCount?: number;
  thumbnail?: string;
}

export interface LoginStatus {
  hasAvatar: boolean;
  hasSignIn: boolean;
  isLoginPage: boolean;
  currentUrl: string;
  userName: string;
}

export const YOUTUBE_DOMAIN_FILTER = (domain: string): boolean =>
  domain.includes('youtube.com') ||
  domain.includes('google.com') ||
  domain.includes('accounts.google.com');

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
