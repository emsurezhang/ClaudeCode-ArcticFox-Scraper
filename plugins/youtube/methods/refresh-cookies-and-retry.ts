import type { BrowserContext, Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import type { YouTubePluginConfig, YouTubeScrapeOptions } from './types.js';
import { isLoggedIn, requiresCookieRecovery } from './is-logged-in.js';
import { visitAndWaitLoaded } from './visit-and-wait-loaded.js';
import { YOUTUBE_DOMAIN_FILTER } from './types.js';

const logger = createLogger('YouTubeCookieRecovery');

export async function refreshCookiesAndRetry(
  page: Page,
  context: BrowserContext,
  options: YouTubeScrapeOptions,
  browserName: string,
  url: string,
  config: YouTubePluginConfig,
): Promise<boolean> {
  logger.info('Starting cookie refresh and retry flow');
  if (!options.cookieManager) {
    logger.warn('Cookie manager not available, cannot refresh cookies');
    return false;
  }

  const refreshed = await options.cookieManager.refreshCookies(
    context,
    'youtube',
    browserName,
    { domainFilter: YOUTUBE_DOMAIN_FILTER },
  );

  if (!refreshed) {
    logger.warn('Cookie refresh failed');
    return false;
  }
  logger.debug('Cookie refresh succeeded, retrying page load');

  const isPlaylist = url.includes('/playlist?list=');
  await visitAndWaitLoaded(page, url, config.loginCheckRetryWaitMs, isPlaylist);
  const status = await isLoggedIn(page);
  const recovered = !requiresCookieRecovery(status);
  logger.info(`Cookie retry flow completed: ${recovered ? 'recovered' : 'still not logged in'}`);
  logger.debug('Post-refresh login status', status);
  return recovered;
}
