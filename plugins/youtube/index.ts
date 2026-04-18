/**
 * YouTube 插件 - 支持视频刮削、音频下载和字幕提取
 *
 * 模式支持:
 * - detail: 获取单个视频详情
 * - list: 获取频道视频列表
 *
 * 字幕提取流程:
 * 1. 下载音频 (yt-dlp)
 * 2. ffmpeg 分片 (如音频过长)
 * 3. Whisper 本地转录
 */

import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import type {
  IPlatformPlugin,
  ScrapeResult,
  ScrapeOptions,
} from '../../src/interfaces/index.js';
import { WhisperTranscriber } from '../../src/utils/whisper-transcriber.js';

interface YouTubeScrapeOptions extends ScrapeOptions {
  mode?: 'list' | 'detail';
  maxItems?: number;
  /** Whisper 模型名称: tiny, base, small, medium, large */
  whisperModel?: string;
}

export default class YouTubePlugin implements IPlatformPlugin {
  readonly name = 'youtube';
  readonly hostnames = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'];
  readonly capabilities = {
    scrapeMetadata: true,
    scrapeContent: true,
    downloadAudio: true,
    extractTranscript: true,
  };

  private tempDir = './cache/temp';

  constructor() {
    // 确保临时目录存在
    mkdir(this.tempDir, { recursive: true }).catch(() => {});
  }

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.hostnames.includes(hostname);
    } catch {
      return false;
    }
  }

  async scrape(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    const mode = options.mode || 'detail';
    console.log(`[YouTube] Scraping: ${url} (mode: ${mode})`);

    if (mode === 'list') {
      return this.scrapeList(url, options);
    } else {
      return this.scrapeDetail(url, options);
    }
  }

  /**
   * 列表模式：获取频道/播放列表视频列表
   */
  private async scrapeList(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    const maxItems = options.maxItems || 50;
    console.log(`[YouTube] List mode: collecting up to ${maxItems} videos`);

    const videos = await this.getPlaylistVideos(url, maxItems);

    if (videos.length === 0) {
      return {
        url,
        platform: this.name,
        content: 'No videos found in playlist/channel',
        scrapedAt: new Date().toISOString(),
      };
    }

    // 获取频道信息（从第一个视频）
    const channelName = videos[0]?.channel || 'Unknown';

    return {
      url,
      platform: this.name,
      author: channelName,
      title: `${channelName}'s Videos`,
      content: `Collected ${videos.length} videos`,
      metadata: {
        mode: 'list',
        totalVideos: videos.length,
        videos: videos.map(v => ({
          title: v.title,
          url: v.url,
          duration: v.duration,
          viewCount: v.viewCount,
          publishedAt: v.publishedAt,
        })),
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * 详情模式：获取单个视频详情
   */
  private async scrapeDetail(url: string, options: YouTubeScrapeOptions): Promise<ScrapeResult> {
    console.log(`[YouTube] Detail mode: getting video info`);

    // 1. 获取视频元数据
    const metadata = await this.getMetadata(url);

    // 2. 下载音频（如果需要字幕或需要下载音频）
    let audioPath: string | undefined;
    if (options.downloadAudio || options.extractTranscript) {
      audioPath = await this.downloadAudio(url);
    }

    // 3. 使用 Whisper 本地转录提取字幕
    let transcript: string | undefined;
    let transcriptLanguage: string | undefined;

    if (options.extractTranscript && audioPath) {
      console.log(`[YouTube] Extracting transcript from audio...`);
      const transcriber = new WhisperTranscriber({
        modelsDir: './models',
        tempDir: this.tempDir,
        modelName: options.whisperModel || 'base',
      });

      const result = await transcriber.transcribe(audioPath);
      if (result) {
        transcript = result.text;
        transcriptLanguage = result.language;
        console.log(`[YouTube] Transcript extracted: ${transcript.length} characters`);
      } else {
        console.log('[YouTube] Failed to extract transcript');
      }
    }

    return {
      url,
      platform: this.name,
      title: metadata.title,
      author: metadata.author,
      description: metadata.description,
      publishedAt: metadata.publishedAt,
      transcript,
      transcriptLanguage,
      audioPath: options.downloadAudio ? audioPath : undefined,
      metadata: {
        mode: 'detail',
        duration: metadata.duration,
        viewCount: metadata.viewCount,
        likeCount: metadata.likeCount,
        thumbnail: metadata.thumbnail,
      },
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * 获取播放列表/频道视频列表
   */
  private async getPlaylistVideos(url: string, maxItems: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const args = [
        '--dump-json',
        '--playlist-end', maxItems.toString(),
        '--cookies-from-browser', 'chrome',
        '--extractor-args', 'youtube:skip=hls,dash', // 跳过下载以提高速度
        url,
      ];

      console.log(`[YouTube] Running: yt-dlp ${args.join(' ')}`);

      const proc = spawn('yt-dlp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        // 输出进度信息
        const line = data.toString().trim();
        if (line.includes('Downloading') || line.includes('Extracting')) {
          console.log(`[YouTube] ${line}`);
        }
      });

      proc.on('close', (code) => {
        if (code === 0 || code === 101) { // 101 = partial download (playlist not fully downloaded)
          try {
            // 解析多行 JSON 输出
            const videos: any[] = [];
            const lines = output.trim().split('\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                videos.push({
                  title: data.title,
                  url: data.webpage_url || `https://youtube.com/watch?v=${data.id}`,
                  channel: data.channel || data.uploader,
                  duration: data.duration,
                  viewCount: data.view_count,
                  publishedAt: data.upload_date ?
                    `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}` :
                    undefined,
                });
              } catch {
                // 忽略解析失败的行
              }
            }

            console.log(`[YouTube] Found ${videos.length} videos`);
            resolve(videos);
          } catch (err) {
            reject(new Error('Failed to parse playlist data'));
          }
        } else {
          reject(new Error(`yt-dlp failed: ${stderr || `exit code ${code}`}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private async getMetadata(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', [
        '--dump-json',
        '--no-download',
        '--cookies-from-browser', 'chrome',
        url,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && output) {
          try {
            const data = JSON.parse(output);
            resolve({
              title: data.title,
              author: data.uploader || data.channel,
              description: data.description,
              publishedAt: data.upload_date ?
                `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}` :
                undefined,
              duration: data.duration,
              viewCount: data.view_count,
              likeCount: data.like_count,
              thumbnail: data.thumbnail,
            });
          } catch {
            reject(new Error('Failed to parse metadata'));
          }
        } else {
          reject(new Error(`yt-dlp failed: ${stderr || `exit code ${code}`}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private async downloadAudio(url: string): Promise<string> {
    const videoId = this.extractVideoId(url);
    const outputPath = join(this.tempDir, `${videoId}.mp3`);

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', [
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--cookies-from-browser', 'chrome',
        '-o', outputPath,
        url,
      ], {
        stdio: 'ignore',
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`Failed to download audio: exit code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private extractVideoId(url: string): string {
    const patterns = [
      /[?&]v=([^&]+)/,
      /youtu\.be\/([^?&]+)/,
      /\/embed\/([^?&]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    return 'unknown';
  }

}
