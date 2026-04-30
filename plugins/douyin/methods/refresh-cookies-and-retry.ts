import type { BrowserContext, Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import { DOUYIN_DOMAIN_FILTER } from './types.js';
import type { DouYinPluginConfig, DouYinScrapeOptions } from './types.js';
import { isLoggedIn, requiresCookieRecovery } from './is-logged-in.js';
import { navigateAndWaitLoaded } from './visit-and-wait-loaded.js';

const logger = createLogger('DouYinCookieRecovery');

export async function ensurePageAccessible(
  page: Page,
  context: BrowserContext,
  options: DouYinScrapeOptions,
  url: string,
  config: DouYinPluginConfig,
  pageLoadWaitMs: number = config.listPageLoadWaitMs,
): Promise<void> {
  await navigateAndWaitLoaded(page, url, pageLoadWaitMs);

  const status = await isLoggedIn(page);
  if (!requiresCookieRecovery(status)) {
    return;
  }

  logger.warn('Detected captcha or login redirect after navigation, refreshing cookies', status);
  const recovered = await refreshCookiesAndRetry(
    page,
    context,
    options,
    url,
    config,
    pageLoadWaitMs,
  );

  if (!recovered) {
    throw new Error('DouYin page entered captcha/login flow and cookie refresh did not recover access');
  }
}

/**
 * 使用 CookieManager 重新提取 cookies 并重试页面加载，然后检测登录是否恢复。
 *
 * 返回 `true` 表示 cookie 刷新后已成功登录；`false` 表示刷新失败或仍未登录。
 */
export async function refreshCookiesAndRetry(
  page: Page,
  context: BrowserContext,
  options: DouYinScrapeOptions,
  url: string,
  config: DouYinPluginConfig,
  pageLoadWaitMs: number = config.listPageLoadWaitMs,
): Promise<boolean> {
  logger.info('Starting cookie refresh and retry flow');

  if (!options.cookieManager) {
    logger.warn('Cookie manager not available, cannot refresh cookies');
    return false;
  }

  const browserName = options.browser || 'chrome';

  const refreshed = await options.cookieManager.refreshCookies(
    context,
    'douyin',
    browserName,
    { domainFilter: DOUYIN_DOMAIN_FILTER },
  );

  if (!refreshed) {
    logger.warn('Cookie refresh failed');
    return false;
  }

  logger.debug('Cookie refresh succeeded, retrying page load');
  await navigateAndWaitLoaded(page, url, pageLoadWaitMs);

  const status = await isLoggedIn(page);
  const recovered = !requiresCookieRecovery(status);

  logger.info(`Cookie retry flow completed: ${recovered ? 'recovered' : 'still not logged in'}`);
  logger.debug('Post-refresh login status', status);

  return recovered;
}
