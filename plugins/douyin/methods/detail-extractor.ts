import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir, rename, stat } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { pipeline } from 'stream/promises';
import type { BrowserContext, Page } from 'playwright';
import { WhisperTranscriber } from '../../../src/utils/whisper-transcriber.js';
import { createLogger } from '../../../src/core/logger.js';
import type { DouYinDetailExtractResult, DouYinPluginConfig, DouYinScrapeOptions } from './types.js';
import { BROWSER_UA } from './types.js';

const logger = createLogger('DouYinDetailExtractor');

interface CaptureResult {
  audioPath: string;
  metadata: Record<string, unknown>;
}

export async function detailExtractor(
  url: string,
  options: DouYinScrapeOptions,
  outputDir: string,
  context: BrowserContext,
  config: DouYinPluginConfig,
): Promise<DouYinDetailExtractResult> {
  const capture = await captureAndDownloadAudio(url, outputDir, context, config);

  const metadata = capture.metadata;
  let finalAudioPath: string | undefined = capture.audioPath;
  let transcript: string | undefined;
  let transcriptLanguage: string | undefined;

  if (options.extractTranscript) {
    const transcriber = new WhisperTranscriber({
      modelsDir: './models',
      tempDir: outputDir,
      modelName: options.whisperModel || 'base',
    });

    const transcriptResult = await transcriber.transcribe(capture.audioPath);
    if (transcriptResult) {
      transcript = transcriptResult.text;
      transcriptLanguage = transcriptResult.language;
      logger.debug('Transcript extracted', {
        language: transcriptLanguage,
        length: transcript.length,
      });
    } else {
      logger.warn('Whisper transcription returned empty result');
    }
  }

  if (!options.downloadAudio) {
    finalAudioPath = undefined;
  } else {
    const dateDir =
      options.audioOutputDir || join(resolve('..'), 'data', new Date().toISOString().slice(0, 10));
    const destination = join(dateDir, `${basename(outputDir)}.mp3`);
    await mkdir(dateDir, { recursive: true });
    await convertAudioToMp3(capture.audioPath, destination);
    finalAudioPath = destination;
  }

  return {
    title: (metadata.title as string) || 'Unknown',
    author: metadata.author as string | undefined,
    description: metadata.description as string | undefined,
    publishedAt: metadata.publishedAt as string | undefined,
    transcript,
    transcriptLanguage,
    audioPath: finalAudioPath,
    metadata: {
      mode: 'detail',
      duration: metadata.duration as number | undefined,
      coverUrl: metadata.coverUrl as string | undefined,
      createTime: metadata.createTime as number | undefined,
    },
  };
}

async function captureAndDownloadAudio(
  pageUrl: string,
  outputDir: string,
  context: BrowserContext,
  config: DouYinPluginConfig,
): Promise<CaptureResult> {
  const { default: axios } = await import('axios');
  const audioPath = join(outputDir, 'audio.m4a');
  const metadata: Record<string, unknown> = {};

  let page: Page | undefined;
  let audioUrl: string | undefined;
  let resolveCapture: (() => void) | null = null;
  const capturePromise = new Promise<void>((resolve) => {
    resolveCapture = resolve;
  });

  let capturedHeaders: Record<string, string> = {
    'user-agent': BROWSER_UA,
    referer: pageUrl,
  };

  try {
    page = await context.newPage();

    page.on('response', async (response) => {
      const responseUrl = response.url();

      if (
        responseUrl.includes('/aweme/v1/web/aweme/detail/') ||
        responseUrl.includes('/aweme/v1/aweme/details/')
      ) {
        try {
          const data = await response.json();
          const detail = data?.aweme_detail;
          if (detail) {
            metadata.title = detail.desc;
            metadata.author = detail.author?.nickname;
            metadata.description = detail.desc;
            metadata.duration = detail.duration;
            metadata.coverUrl = detail.video?.cover?.url_list?.[0];
            metadata.createTime = detail.create_time;
          }
        } catch {
          // Ignore parse errors from noisy API responses.
        }
      }

      if (!responseUrl.includes('douyinvod') || !responseUrl.includes('media-audio')) {
        return;
      }

      const firstCapture = !audioUrl;
      audioUrl = responseUrl;
      try {
        capturedHeaders = {
          ...capturedHeaders,
          ...(await response.request().allHeaders()),
        };
      } catch {
        // Ignore header collection failures.
      }

      if (firstCapture) {
        resolveCapture?.();
      }
    });

    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(config.detailDomReadyWaitMs);

    if (!audioUrl) {
      await Promise.race([capturePromise, page.waitForTimeout(config.detailCaptureTimeoutMs)]);
    }

    const pageInfo = await page.evaluate(() => {
      const timeElement = document.querySelector('[data-e2e="detail-video-publish-time"]');
      const titleElement = document.querySelector('[data-e2e="video-desc"]');
      return {
        publishTimeText: timeElement?.textContent?.trim() || '',
        pageTitle: titleElement?.textContent?.trim() || '',
      };
    });

    if (pageInfo.publishTimeText) {
      metadata.publishedAt = parsePublishTime(pageInfo.publishTimeText)?.toISOString();
    }
    if (pageInfo.pageTitle) {
      metadata.title = metadata.title || pageInfo.pageTitle;
      metadata.description = metadata.description || pageInfo.pageTitle;
    }

    if (!audioUrl) {
      throw new Error('No audio URL captured from network responses');
    }

    const requestHeaders: Record<string, string> = {
      'user-agent': capturedHeaders['user-agent'] || BROWSER_UA,
      referer: capturedHeaders.referer || pageUrl,
      accept: capturedHeaders.accept || '*/*',
    };

    const cookieHeader = await buildCookieHeader(context, audioUrl);
    if (cookieHeader) {
      requestHeaders.cookie = cookieHeader;
    }

    const response = await axios.get(audioUrl, {
      responseType: 'stream',
      headers: requestHeaders,
      timeout: 60000,
      maxRedirects: 5,
    });

    await pipeline(response.data, createWriteStream(audioPath));

    const contentRange =
      typeof response.headers['content-range'] === 'string' ? response.headers['content-range'] : '';
    const partialRangeWithoutZero = response.status === 206 && /^bytes\s+(?!0-)/i.test(contentRange);

    if (partialRangeWithoutZero) {
      const fullUrl = sanitizeAudioUrl(audioUrl);
      if (fullUrl !== audioUrl) {
        const retry = await axios.get(fullUrl, {
          responseType: 'stream',
          headers: requestHeaders,
          timeout: 60000,
          maxRedirects: 5,
        });
        await pipeline(retry.data, createWriteStream(audioPath));
      }
    }

    const fileStat = await stat(audioPath).catch(() => null);
    if (!fileStat || fileStat.size < 16 * 1024) {
      throw new Error(`Downloaded audio file is too small: ${fileStat?.size ?? 0} bytes`);
    }

    return {
      audioPath,
      metadata,
    };
  } finally {
    await page?.close().catch((err) => logger.warn('Failed to close detail page', err));
  }
}

async function buildCookieHeader(context: BrowserContext, url: string): Promise<string> {
  try {
    const cookies = await context.cookies(url);
    if (cookies.length === 0) {
      return '';
    }
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {
    return '';
  }
}

async function convertAudioToMp3(inputPath: string, outputPath: string): Promise<void> {
  logger.debug('Converting downloaded audio to mp3', { inputPath, outputPath });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-y',
      outputPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      logger.error('ffmpeg mp3 conversion failed', { code, stderr, inputPath, outputPath });
      reject(new Error(`ffmpeg mp3 conversion failed with code ${code}`));
    });

    proc.on('error', reject);
  });
}

function sanitizeAudioUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ['range', 'byterange', 'byte_range', 'start', 'end']) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function parsePublishTime(text: string): Date | undefined {
  const absoluteMatch = text.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (absoluteMatch) {
    const [, year, month, day, hour, minute] = absoluteMatch;
    return new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
    );
  }

  const trimmed = text.replace(/^·\s*/, '').trim();
  const now = new Date();

  const minuteMatch = trimmed.match(/(\d+)\s*分钟前/);
  if (minuteMatch) {
    return new Date(now.getTime() - Number.parseInt(minuteMatch[1], 10) * 60 * 1000);
  }

  const hourMatch = trimmed.match(/(\d+)\s*小时前/);
  if (hourMatch) {
    return new Date(now.getTime() - Number.parseInt(hourMatch[1], 10) * 60 * 60 * 1000);
  }

  const dayMatch = trimmed.match(/(\d+)\s*天前/);
  if (dayMatch) {
    return new Date(now.getTime() - Number.parseInt(dayMatch[1], 10) * 24 * 60 * 60 * 1000);
  }

  if (trimmed === '昨天') {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  const weekMatch = trimmed.match(/(\d+)\s*周前/);
  if (weekMatch) {
    return new Date(now.getTime() - Number.parseInt(weekMatch[1], 10) * 7 * 24 * 60 * 60 * 1000);
  }

  const monthMatch = trimmed.match(/(\d+)\s*月前/);
  if (monthMatch) {
    const date = new Date(now);
    date.setMonth(date.getMonth() - Number.parseInt(monthMatch[1], 10));
    return date;
  }

  const yearMatch = trimmed.match(/(\d+)\s*年前/);
  if (yearMatch) {
    const date = new Date(now);
    date.setFullYear(date.getFullYear() - Number.parseInt(yearMatch[1], 10));
    return date;
  }

  return undefined;
}
