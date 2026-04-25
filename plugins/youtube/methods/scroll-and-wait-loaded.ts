import type { Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import type { YouTubePluginConfig } from './types.js';

const logger = createLogger('YouTubeScroll');

export async function scrollAndWaitLoaded(
  page: Page,
  config: YouTubePluginConfig,
): Promise<void> {
  const prevHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = page.viewportSize()?.height ?? 900;
  const currentScrollY = await page.evaluate(() => window.scrollY);
  const totalScroll = Math.max(0, prevHeight - currentScrollY - viewportHeight);
  const step = Math.max(viewportHeight, 500);
  const steps = Math.max(1, Math.ceil(totalScroll / step));
  logger.debug('Starting scroll cycle', {
    prevHeight,
    currentScrollY,
    viewportHeight,
    totalScroll,
    step,
    steps,
  });

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(config.scrollStepIntervalMs);
  }

  await page
    .waitForFunction((height: number) => document.body.scrollHeight > height, prevHeight, {
      timeout: config.scrollHeightChangeTimeoutMs,
    })
    .catch(() => {
      logger.debug('No page height increase detected during timeout window', {
        timeout: config.scrollHeightChangeTimeoutMs,
      });
    });

  await page.waitForTimeout(config.scrollSettleWaitMs);
  const newHeight = await page.evaluate(() => document.body.scrollHeight);
  logger.debug('Scroll cycle completed', { prevHeight, newHeight, gainedHeight: newHeight - prevHeight });
}
