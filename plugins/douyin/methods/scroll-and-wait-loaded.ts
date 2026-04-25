import type { Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import type { DouYinPluginConfig } from './types.js';

const logger = createLogger('DouYinScroll');

/**
 * 向下滚动一次并等待新的视频列表项加载完成。
 *
 * 目标 DOM（来自 list_sample.html）：
 * - 视频卡片：`a[href*="/video/"]`（每个 `<li>` 内的链接）
 *
 * 策略：
 * 1. 记录当前 scrollHeight
 * 2. 按视口高度步进平滑滚动到页底
 * 3. 等待 scrollHeight 增大（新内容追加）或超时
 * 4. 固定 settle 等待，让懒加载图片和动画完成
 */
export async function scrollAndWaitLoaded(
  page: Page,
  config: DouYinPluginConfig,
): Promise<void> {
  const prevState = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement;
    let maxContainerScrollTop = 0;
    let maxContainerScrollHeight = 0;
    let scrollableContainerCount = 0;

    for (const element of document.querySelectorAll('main, section, div, ul, article')) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (!/(auto|scroll)/.test(style.overflowY)) {
        continue;
      }

      if (element.scrollHeight <= element.clientHeight + 4 || element.clientHeight < 200) {
        continue;
      }

      scrollableContainerCount += 1;
      maxContainerScrollTop = Math.max(maxContainerScrollTop, element.scrollTop);
      maxContainerScrollHeight = Math.max(maxContainerScrollHeight, element.scrollHeight);
    }

    return {
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      rootScrollTop: scrollingElement?.scrollTop ?? document.documentElement.scrollTop ?? document.body.scrollTop ?? 0,
      windowScrollY: window.scrollY,
      maxContainerScrollTop,
      maxContainerScrollHeight,
      scrollableContainerCount,
    };
  });
  const viewportHeight = page.viewportSize()?.height ?? 900;
  const currentScrollY = Math.max(prevState.windowScrollY, prevState.rootScrollTop, prevState.maxContainerScrollTop);
  const prevHeight = Math.max(
    prevState.bodyScrollHeight,
    prevState.documentScrollHeight,
    prevState.maxContainerScrollHeight,
  );
  const totalScroll = Math.max(0, prevHeight - currentScrollY - viewportHeight);
  const step = Math.max(viewportHeight, 500);
  const steps = Math.max(1, Math.ceil(totalScroll / step));

  logger.debug('Starting scroll cycle', {
    prevHeight,
    currentScrollY,
    prevState,
    viewportHeight,
    totalScroll,
    step,
    steps,
  });

  for (let i = 0; i < steps; i++) {
    await page.evaluate((distance: number) => {
      window.scrollBy(0, distance);

      const scrollingElement = document.scrollingElement;
      if (scrollingElement instanceof HTMLElement) {
        scrollingElement.scrollTop += distance;
      }

      for (const element of document.querySelectorAll('main, section, div, ul, article')) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }

        const style = window.getComputedStyle(element);
        if (!/(auto|scroll)/.test(style.overflowY)) {
          continue;
        }

        if (element.scrollHeight <= element.clientHeight + 4 || element.clientHeight < 200) {
          continue;
        }

        element.scrollTop += distance;
      }
    }, step);
    await page.waitForTimeout(config.scrollStepIntervalMs);
  }

  // DouYin may load inside a nested scroll container, so treat scroll movement as progress too.
  await page
    .waitForFunction(
      (previous: {
        bodyScrollHeight: number;
        documentScrollHeight: number;
        rootScrollTop: number;
        windowScrollY: number;
        maxContainerScrollTop: number;
        maxContainerScrollHeight: number;
      }) => {
        const scrollingElement = document.scrollingElement;
        const currentRootScrollTop = scrollingElement?.scrollTop ?? document.documentElement.scrollTop ?? document.body.scrollTop ?? 0;
        if (document.body.scrollHeight > previous.bodyScrollHeight) {
          return true;
        }
        if (document.documentElement.scrollHeight > previous.documentScrollHeight) {
          return true;
        }
        if (window.scrollY > previous.windowScrollY || currentRootScrollTop > previous.rootScrollTop) {
          return true;
        }

        let maxContainerScrollTop = 0;
        let maxContainerScrollHeight = 0;
        for (const element of document.querySelectorAll('main, section, div, ul, article')) {
          if (!(element instanceof HTMLElement)) {
            continue;
          }

          const style = window.getComputedStyle(element);
          if (!/(auto|scroll)/.test(style.overflowY)) {
            continue;
          }

          if (element.scrollHeight <= element.clientHeight + 4 || element.clientHeight < 200) {
            continue;
          }

          maxContainerScrollTop = Math.max(maxContainerScrollTop, element.scrollTop);
          maxContainerScrollHeight = Math.max(maxContainerScrollHeight, element.scrollHeight);
        }

        return (
          maxContainerScrollTop > previous.maxContainerScrollTop ||
          maxContainerScrollHeight > previous.maxContainerScrollHeight
        );
      },
      prevState,
      { timeout: config.scrollHeightChangeTimeoutMs },
    )
    .catch(() => {
      logger.debug('No page height increase detected during timeout window', {
        timeout: config.scrollHeightChangeTimeoutMs,
      });
    });

  await page.waitForTimeout(config.scrollSettleWaitMs);

  const nextState = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement;
    let maxContainerScrollTop = 0;
    let maxContainerScrollHeight = 0;

    for (const element of document.querySelectorAll('main, section, div, ul, article')) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (!/(auto|scroll)/.test(style.overflowY)) {
        continue;
      }

      if (element.scrollHeight <= element.clientHeight + 4 || element.clientHeight < 200) {
        continue;
      }

      maxContainerScrollTop = Math.max(maxContainerScrollTop, element.scrollTop);
      maxContainerScrollHeight = Math.max(maxContainerScrollHeight, element.scrollHeight);
    }

    return {
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      rootScrollTop: scrollingElement?.scrollTop ?? document.documentElement.scrollTop ?? document.body.scrollTop ?? 0,
      windowScrollY: window.scrollY,
      maxContainerScrollTop,
      maxContainerScrollHeight,
    };
  });
  const newHeight = Math.max(
    nextState.bodyScrollHeight,
    nextState.documentScrollHeight,
    nextState.maxContainerScrollHeight,
  );
  logger.debug('Scroll cycle completed', {
    prevHeight,
    newHeight,
    gainedHeight: newHeight - prevHeight,
    scrollDelta: Math.max(
      nextState.windowScrollY - prevState.windowScrollY,
      nextState.rootScrollTop - prevState.rootScrollTop,
      nextState.maxContainerScrollTop - prevState.maxContainerScrollTop,
    ),
    nextState,
  });
}
