  import type { Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import type { VideoItem } from './types.js';

const logger = createLogger('YouTubeListExtractor');

interface ExtractOptions {
  maxItems: number;
  isPlaylist: boolean;
  existingUrls: string[];
}

export async function listExtractor(page: Page, options: ExtractOptions): Promise<VideoItem[]> {
  logger.debug('Starting listExtractor evaluation', {
    maxItems: options.maxItems,
    isPlaylist: options.isPlaylist,
    existingUrls: options.existingUrls.length,
  });

  const extracted = await page.evaluate(function (opts: ExtractOptions) {
    const result: VideoItem[] = [];
    const existing = new Set(opts.existingUrls);

    const items = opts.isPlaylist
      ? Array.from(document.querySelectorAll('ytd-playlist-video-renderer'))
      : Array.from(document.querySelectorAll('ytd-rich-item-renderer'));

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

        const durationEl = item.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, #time-status #text');
        const durationText = durationEl?.textContent?.trim() || '';
        const durationParts = durationText
          .split(':')
          .map((x) => parseInt(x.trim(), 10))
          .filter((x) => !Number.isNaN(x));
        if (durationParts.length === 2) {
          duration = durationParts[0] * 60 + durationParts[1];
        } else if (durationParts.length === 3) {
          duration = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
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

        const durationEl = media.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, badge-shape .ytBadgeShapeText');
        const durationText = durationEl?.textContent?.trim() || '';
        const durationParts = durationText
          .split(':')
          .map((x) => parseInt(x.trim(), 10))
          .filter((x) => !Number.isNaN(x));
        if (durationParts.length === 2) {
          duration = durationParts[0] * 60 + durationParts[1];
        } else if (durationParts.length === 3) {
          duration = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
        }
      }

      const videoUrl = href ? (href.startsWith('http') ? href : `https://www.youtube.com${href}`) : '';
      if (!videoUrl || existing.has(videoUrl)) continue;

      const metaSelectors = opts.isPlaylist
        ? ['#video-info span', '#byline-container span', '.inline-metadata-item', 'ytd-video-meta-block span']
        : ['.inline-metadata-item', 'ytd-video-meta-block span', '#metadata-line span'];
      const metaList: string[] = [];
      for (const selector of metaSelectors) {
        for (const el of item.querySelectorAll(selector)) {
          const text = el.textContent?.trim();
          if (text) metaList.push(text);
        }
      }

      for (const meta of metaList) {
        if (!viewCount && (meta.includes('view') || meta.includes('观看') || meta.includes('次') || /\d/.test(meta))) {
          const normalizedMeta = meta.replace(/,/g, '').trim();
          const wan = normalizedMeta.match(/([\d.]+)\s*万/);
          if (wan) {
            viewCount = Math.round(parseFloat(wan[1]) * 10000);
          } else {
            const k = normalizedMeta.match(/([\d.]+)\s*[Kk]/);
            if (k) {
              viewCount = Math.round(parseFloat(k[1]) * 1000);
            } else {
              const digits = normalizedMeta.match(/(\d+)/);
              if (digits) {
                viewCount = parseInt(digits[1], 10);
              }
            }
          }
        }
        if (!publishedAt && !meta.includes('view') && !meta.includes('观看')) {
          publishedAt = meta;
        }
      }

      result.push({
        title,
        url: videoUrl,
        channel,
        duration,
        viewCount,
        publishedAt,
        thumbnail,
      });
    }

    return result;
  }, options);

  logger.debug('listExtractor evaluation completed', {
    extractedCount: extracted.length,
    isPlaylist: options.isPlaylist,
  });

  return extracted;
}
