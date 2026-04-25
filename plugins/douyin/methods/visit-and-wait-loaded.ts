import type { Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import type { DouYinPluginConfig } from './types.js';

const logger = createLogger('DouYinVisit');

/**
 * 导航到抖音页面并等待 SPA 内容挂载完成。
 *
 * 抖音用户页的 networkidle 很难达到（持续有统计请求），
 * 因此改用 load 事件 + 固定等待时长的组合策略。
 */
export async function visitAndWaitLoaded(
  page: Page,
  url: string,
  config: DouYinPluginConfig,
): Promise<void> {
  logger.debug('Navigating to DouYin page', { url });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {
    logger.debug('load event timed out, continuing');
  });
  await page.waitForTimeout(config.listPageLoadWaitMs);
  logger.debug('Initial page load wait completed', { url });
}
