/**
 * Cookie 管理器 - 支持缓存和从浏览器提取
 */

import { mkdir, readFile, writeFile, stat, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import type { ICookieManager } from '../interfaces/index.js';

interface CookieCacheEntry {
  platform: string;
  browser: string;
  content: string;
  fetchedAt: Date;
}

export class CookieManager implements ICookieManager {
  private cacheDir: string;
  private ttlHours: number;
  private autoRefresh: boolean;

  constructor(options: {
    cacheDir?: string;
    ttlHours?: number;
    autoRefresh?: boolean;
  } = {}) {
    this.cacheDir = options.cacheDir || './cache/cookies';
    this.ttlHours = options.ttlHours || 24;
    this.autoRefresh = options.autoRefresh !== false;
  }

  private getCacheFilePath(platform: string, browser: string): string {
    return join(this.cacheDir, `${platform}_${browser}.txt`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
  }

  async getCookies(platform: string, browser: string): Promise<string | undefined> {
    const cachePath = this.getCacheFilePath(platform, browser);

    try {
      const content = await readFile(cachePath, 'utf-8');
      const stats = await stat(cachePath);
      const age = Date.now() - stats.mtime.getTime();
      const ttlMs = this.ttlHours * 60 * 60 * 1000;

      if (age > ttlMs) {
        console.log(`[CookieManager] ${platform}/${browser} cookies expired`);
        return undefined;
      }

      console.log(`[CookieManager] Using cached cookies for ${platform}/${browser}`);
      return content;
    } catch {
      return undefined;
    }
  }

  async setCookies(platform: string, browser: string, cookies: string): Promise<void> {
    const cachePath = this.getCacheFilePath(platform, browser);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, cookies, 'utf-8');
    console.log(`[CookieManager] Cookies cached for ${platform}/${browser}`);
  }

  async clearCookies(platform: string): Promise<void> {
    const files = await this.listCacheFiles();
    for (const file of files) {
      if (file.startsWith(platform + '_')) {
        await unlink(join(this.cacheDir, file)).catch(() => {});
      }
    }
  }

  async isValid(platform: string, browser: string): Promise<boolean> {
    const cookies = await this.getCookies(platform, browser);
    return cookies !== undefined;
  }

  async getOrExtract(platform: string, browser: string): Promise<string> {
    // 先尝试从缓存获取
    const cached = await this.getCookies(platform, browser);
    if (cached) {
      return cached;
    }

    // 从浏览器提取
    console.log(`[CookieManager] Extracting cookies from ${browser} browser...`);
    const extracted = await this.extractFromBrowser(browser);
    await this.setCookies(platform, browser, extracted);
    return extracted;
  }

  private async extractFromBrowser(browser: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const tempFile = join(this.cacheDir, `_temp_${Date.now()}.txt`);

      // 使用 yt-dlp 提取 cookies
      const proc = spawn('yt-dlp', [
        '--cookies-from-browser', browser,
        '--cookies', tempFile,
        '--print', 'cookies',
        'https://www.youtube.com/robots.txt'  // 随便一个 URL 触发 cookie 提取
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', async (code) => {
        try {
          // 读取临时文件中的 cookies
          const cookies = await readFile(tempFile, 'utf-8');
          await unlink(tempFile).catch(() => {});

          if (cookies && cookies.length > 0) {
            resolve(cookies);
          } else {
            reject(new Error(`Failed to extract cookies: ${stderr}`));
          }
        } catch (err) {
          await unlink(tempFile).catch(() => {});
          reject(new Error(`Failed to extract cookies: ${err}`));
        }
      });

      proc.on('error', (err) => {
        unlink(tempFile).catch(() => {});
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      });
    });
  }

  private async listCacheFiles(): Promise<string[]> {
    try {
      const { readdir } = await import('fs/promises');
      return await readdir(this.cacheDir);
    } catch {
      return [];
    }
  }

  /**
   * 清除所有缓存
   */
  async clearAll(): Promise<void> {
    const files = await this.listCacheFiles();
    for (const file of files) {
      if (file.endsWith('.txt')) {
        await unlink(join(this.cacheDir, file)).catch(() => {});
      }
    }
    console.log('[CookieManager] All cookies cleared');
  }
}
