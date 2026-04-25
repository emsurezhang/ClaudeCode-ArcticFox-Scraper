import type { Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';

const logger = createLogger('YouTubeVisit');

export async function visitAndWaitLoaded(
  page: Page,
  url: string,
  waitMs: number,
  isPlaylist: boolean,
): Promise<void> {
  logger.debug('Navigating to YouTube page', { url, waitMs, isPlaylist });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(waitMs);

  const selector = isPlaylist ? 'ytd-playlist-video-renderer' : 'ytd-rich-item-renderer, ytd-rich-grid-media';
  await page.waitForSelector(selector, { timeout: 15000 }).catch((err) => {
    logger.warn('Target list selector did not appear within timeout', { selector, err });
  });
  logger.debug('Initial page load wait completed', { selector, url });
}
