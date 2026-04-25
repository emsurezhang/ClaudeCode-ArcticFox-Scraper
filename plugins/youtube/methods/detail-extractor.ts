import { spawn } from 'child_process';
import { basename, join, resolve } from 'path';
import { mkdir, rename, unlink } from 'fs/promises';
import { WhisperTranscriber } from '../../../src/utils/whisper-transcriber.js';
import { createLogger } from '../../../src/core/logger.js';
import type { YouTubeScrapeOptions, VideoMetadata } from './types.js';

const logger = createLogger('YouTubeDetailExtractor');

interface DetailExtractResult {
  title: string;
  author: string;
  description: string;
  publishedAt?: string;
  transcript?: string;
  transcriptLanguage?: string;
  audioPath?: string;
  metadata: {
    mode: 'detail';
    duration?: number;
    viewCount?: number;
    likeCount?: number;
    thumbnail?: string;
  };
}

export async function detailExtractor(
  url: string,
  options: YouTubeScrapeOptions,
  tempDir: string,
): Promise<DetailExtractResult> {
  logger.info(`Starting detail extraction for ${url}`);
  const metadata = await getMetadata(url);
  logger.debug('Metadata fetched', {
    title: metadata.title,
    author: metadata.author,
    duration: metadata.duration,
    viewCount: metadata.viewCount,
  });

  let audioPath: string | undefined;
  if (options.downloadAudio || options.extractTranscript) {
    logger.info('Audio download requested for detail extraction');
    audioPath = await downloadAudio(url, tempDir);
    logger.debug('Audio downloaded', { audioPath });
  }

  let transcript: string | undefined;
  let transcriptLanguage: string | undefined;
  if (options.extractTranscript && audioPath) {
    logger.info('Transcript extraction requested, invoking Whisper transcriber');
    const transcriber = new WhisperTranscriber({
      modelsDir: './models',
      tempDir,
      modelName: options.whisperModel || 'base',
    });

    const transcriptResult = await transcriber.transcribe(audioPath);
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

  const shouldKeepAudio = !!options.downloadAudio;
  let finalAudioPath = audioPath;
  if (audioPath && shouldKeepAudio) {
    const dateDir =
      options.audioOutputDir || join(resolve('..'), 'data', new Date().toISOString().slice(0, 10));
    await mkdir(dateDir, { recursive: true });
    const destPath = join(dateDir, basename(audioPath));
    await rename(audioPath, destPath);
    finalAudioPath = destPath;
    logger.info(`Audio file preserved at ${destPath}`);
  } else if (audioPath) {
    await unlink(audioPath).catch((err) => logger.warn('Failed to remove temporary audio file', err));
    finalAudioPath = undefined;
    logger.debug('Temporary audio file removed because downloadAudio=false');
  }

  logger.info(`Detail extraction completed for ${url}`);

  return {
    title: metadata.title,
    author: metadata.author,
    description: metadata.description,
    publishedAt: metadata.publishedAt,
    transcript,
    transcriptLanguage,
    audioPath: finalAudioPath,
    metadata: {
      mode: 'detail',
      duration: metadata.duration,
      viewCount: metadata.viewCount,
      likeCount: metadata.likeCount,
      thumbnail: metadata.thumbnail,
    },
  };
}

async function getMetadata(url: string): Promise<VideoMetadata> {
  logger.debug(`Fetching metadata with yt-dlp for ${url}`);
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      'yt-dlp',
      [
        '--dump-json',
        '--no-download',
        '--cookies-from-browser',
        'chrome',
        '--proxy',
        'http://127.0.0.1:7897',
        url,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      },
    );

    let output = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0 || !output) {
        logger.error('yt-dlp metadata fetch failed', { code, stderr: stderr || undefined, url });
        rejectPromise(new Error(`yt-dlp failed: ${stderr || `exit code ${code}`}`));
        return;
      }

      try {
        const data = JSON.parse(output);
        logger.debug('yt-dlp metadata parse succeeded', { url, title: data.title, uploader: data.uploader || data.channel });
        resolvePromise({
          title: data.title,
          author: data.uploader || data.channel,
          description: data.description,
          publishedAt: data.upload_date
            ? `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}`
            : undefined,
          duration: data.duration,
          viewCount: data.view_count,
          likeCount: data.like_count,
          thumbnail: data.thumbnail,
        });
      } catch {
        logger.error('Failed to parse metadata JSON from yt-dlp output', { url });
        rejectPromise(new Error('Failed to parse metadata'));
      }
    });

    proc.on('error', (err) => {
      logger.error('yt-dlp metadata process error', err);
      rejectPromise(err);
    });
  });
}

async function downloadAudio(url: string, tempDir: string): Promise<string> {
  const videoId = extractVideoId(url);
  const outputPath = join(tempDir, `${videoId}.mp3`);
  logger.debug('Downloading audio with yt-dlp', { url, outputPath });

  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      'yt-dlp',
      [
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '--cookies-from-browser',
        'chrome',
        '--proxy',
        'http://127.0.0.1:7897',
        '-o',
        outputPath,
        url,
      ],
      {
        stdio: 'ignore',
        timeout: 300000,
      },
    );

    proc.on('close', (code) => {
      if (code === 0) {
        logger.debug('Audio download finished successfully', { outputPath });
        resolvePromise(outputPath);
      } else {
        logger.error('Audio download failed', { code, url });
        rejectPromise(new Error(`Failed to download audio: exit code ${code}`));
      }
    });

    proc.on('error', (err) => {
      logger.error('yt-dlp audio process error', err);
      rejectPromise(err);
    });
  });
}

function extractVideoId(url: string): string {
  const patterns = [/[?&]v=([^&]+)/, /youtu\.be\/([^?&]+)/, /\/embed\/([^?&]+)/];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return 'unknown';
}
