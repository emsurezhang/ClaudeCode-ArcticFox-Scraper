import type { Page } from 'playwright';
import type { DouYinListExtractResult, DouYinPluginConfig } from './types.js';
import { scrollAndWaitLoaded } from './scroll-and-wait-loaded.js';

export async function listExtractor(
  page: Page,
  config: DouYinPluginConfig,
  maxItems: number,
): Promise<DouYinListExtractResult> {
  await page
    .waitForSelector('a[href*="/video/"]', { timeout: config.listVideoSelectorTimeoutMs })
    .catch(() => null);

  let snapshot = await extractSnapshot(page, maxItems);
  let previousCount = snapshot.videos.length;
  let noNewContentStreak = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = Math.ceil(maxItems / 10) + 3;

  while (
    snapshot.videos.length < maxItems &&
    scrollAttempts < maxScrollAttempts &&
    noNewContentStreak < 2
  ) {
    await scrollAndWaitLoaded(page, config);

    const nextSnapshot = await extractSnapshot(page, maxItems);
    if (nextSnapshot.videos.length === previousCount) {
      noNewContentStreak += 1;
    } else {
      noNewContentStreak = 0;
      previousCount = nextSnapshot.videos.length;
      snapshot = nextSnapshot;
    }

    scrollAttempts += 1;
  }

  return {
    nickname: snapshot.nickname,
    videos: snapshot.videos.slice(0, maxItems),
  };
}

async function extractSnapshot(page: Page, limit: number): Promise<DouYinListExtractResult> {
  return page.evaluate((maxResults) => {
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
      const element = document.querySelector(selector);
      if (element?.textContent) {
        nickname = element.textContent.trim();
        break;
      }
    }

    const videoCardSelectors = [
      'li a[href*="/video/"]',
      '.wqW3g_Kl a[href*="/video/"]',
      '[data-e2e="user-post-list"] > div > a',
      '[data-e2e="user-post-list"] a[href*="/video/"]',
      '.B6JkCp0k a[href*="/video/"]',
      'a[href*="/video/"]',
      '[class*="video"] a[href*="/video/"]',
      '[class*="item"] a[href*="/video/"]',
      '.swiper-slide a[href*="/video/"]',
    ];

    const titleSelectors = [
      'img[alt]',
      'p.EtttsrEw',
      'p.eJFBAbdI',
      '.title',
      '[class*="title"]',
      '.desc',
    ];

    const imgSelectors = ['img', 'div[class*="cover"] img', 'div img', '.swiper-slide img'];

    const videos: Array<{
      title: string;
      url: string;
      videoId: string;
      coverUrl?: string;
    }> = [];

    for (const selector of videoCardSelectors) {
      if (videos.length >= maxResults) {
        break;
      }

      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        if (videos.length >= maxResults) {
          break;
        }

        const href = element.getAttribute('href');
        if (!href || !href.includes('/video/')) {
          continue;
        }

        const videoId = href.split('/video/')[1]?.split('?')[0];
        if (!videoId || videos.some((item) => item.videoId === videoId)) {
          continue;
        }

        let coverUrl = '';
        for (const imgSelector of imgSelectors) {
          const image =
            element.querySelector(imgSelector) ||
            element.closest('div[class*="item"]')?.querySelector(imgSelector);
          if (image) {
            coverUrl = image.getAttribute('src') || image.getAttribute('data-src') || '';
            if (coverUrl) {
              break;
            }
          }
        }

        let title = '';
        for (const titleSelector of titleSelectors) {
          const titleElement =
            element.querySelector(titleSelector) ||
            element.closest('li')?.querySelector(titleSelector);
          if (titleElement) {
            title = titleElement.getAttribute('alt') || titleElement.textContent || '';
            if (title) {
              break;
            }
          }
        }

        const normalizedTitle = title.trim();
        const normalizedCoverUrl = coverUrl.trim();
        if (!normalizedTitle && !normalizedCoverUrl) {
          continue;
        }

        videos.push({
          title: normalizedTitle,
          url: `https://www.douyin.com/video/${videoId}`,
          videoId,
          coverUrl: normalizedCoverUrl,
        });
      }
    }

    return {
      nickname,
      videos,
    };
  }, limit);
}
