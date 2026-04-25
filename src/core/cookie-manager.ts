/**
 * Cookie 管理器 - 支持缓存、从浏览器提取、解析 Netscape 格式并注入 Playwright BrowserContext
 */

import { mkdir, readFile, writeFile, stat, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import type { ICookieManager, ParseCookiesOptions, PlaywrightCookieRecord } from '../interfaces/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('CookieManager');

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
        logger.info(`${platform}/${browser} cookies expired`);
        return undefined;
      }

      logger.info(`Using cached cookies for ${platform}/${browser}`);
      return content;
    } catch {
      return undefined;
    }
  }

  async setCookies(platform: string, browser: string, cookies: string): Promise<void> {
    const cachePath = this.getCacheFilePath(platform, browser);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, cookies, 'utf-8');
    logger.info(`Cookies cached for ${platform}/${browser}`);
  }

  async clearCookies(platform: string): Promise<void> {
    const files = await this.listCacheFiles();
    for (const file of files) {
      if (file.startsWith(platform + '_')) {
        await unlink(join(this.cacheDir, file)).catch((err) => logger.warn('Failed to clear cookie file', err));
      }
    }
  }

  async isValid(platform: string, browser: string): Promise<boolean> {
    const cookies = await this.getCookies(platform, browser);
    return cookies !== undefined;
  }

  async getOrExtract(platform: string, browser: string): Promise<string> {
    const cached = await this.getCookies(platform, browser);
    if (cached) {
      return cached;
    }

    logger.info(`Extracting cookies from ${browser} browser...`);
    const extracted = await this.extractFromBrowser(platform, browser);
    if (!extracted) {
      throw new Error(`[CookieManager] Failed to extract cookies for ${platform}/${browser}`);
    }
    await this.setCookies(platform, browser, extracted);
    return extracted;
  }

  /**
   * 解析 Netscape 格式 cookie 文本，返回 Playwright addCookies() 兼容的对象列表。
   *
   * Netscape 格式每行 7 列（tab 分隔）:
   *   domain | includeSubdomains | path | secure | expires(秒) | name | value
   *
   * Playwright 特殊规则:
   * - __Host- cookies 必须 host-only（无点前缀）、Secure、Path=/
   * - __Secure- cookies 必须有 Secure
   * - expires 支持 Windows epoch (> 1e14 µs)、毫秒 (> 1e12)、Unix 秒
   */
  parseNetscapeCookies(content: string, options?: ParseCookiesOptions): PlaywrightCookieRecord[] {
    const MAX_EXPIRES_SEC = 32503680000;
    const WINDOWS_EPOCH_OFFSET_SEC = 11644473600;
    const cookies: PlaywrightCookieRecord[] = [];

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split('\t');
      if (parts.length < 7) continue;

      const [rawDomain, , path, secure, rawExpires, name, ...valueParts] = parts;
      const value = valueParts.join('\t');

      if (!name || !name.trim()) continue;

      // 调用方提供的域名过滤（如无则保留全部）
      if (options?.domainFilter && !options.domainFilter(rawDomain)) continue;

      const isHostPrefixed = name.startsWith('__Host-');
      const isSecurePrefixed = name.startsWith('__Secure-');

      // __Host- cookies 必须是 host-only（无点前缀）
      let domain: string;
      if (isHostPrefixed) {
        domain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
      } else {
        domain = rawDomain.startsWith('.') ? rawDomain : `.${rawDomain}`;
      }

      const cookiePath = path && path.startsWith('/') ? path : '/';

      // 解析 expires，支持多种时间戳格式
      let expiresValue: number | undefined;
      const rawNum = parseFloat(rawExpires);
      if (!isNaN(rawNum) && rawNum > 0) {
        let sec = rawNum;
        if (sec > 1e14) {
          // Windows FILETIME（100-ns 间隔，自 1601-01-01）→ Unix 秒
          sec = Math.floor(sec / 1e6) - WINDOWS_EPOCH_OFFSET_SEC;
        } else if (sec > 1e12) {
          // 毫秒级时间戳 → 秒
          sec = Math.floor(sec / 1e3);
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (sec > nowSec && sec <= MAX_EXPIRES_SEC) {
          expiresValue = Math.floor(sec);
        }
      }

      const isSecure = secure === 'TRUE' || isHostPrefixed || isSecurePrefixed;

      cookies.push({
        name: name.trim(),
        value,
        domain,
        path: cookiePath,
        ...(expiresValue !== undefined ? { expires: expiresValue } : {}),
        secure: isSecure,
        sameSite: 'Lax',
      });
    }

    return cookies;
  }

  /**
   * 将缓存中的 cookies 解析并注入到 Playwright BrowserContext。
   * 若缓存不存在或已过期，先从系统浏览器重新提取。
   */
  async injectIntoContext(
    context: import('playwright').BrowserContext,
    platform: string,
    browser: string,
    options?: ParseCookiesOptions,
  ): Promise<void> {
    let content: string | undefined;
    try {
      content = await this.getOrExtract(platform, browser);
    } catch (err) {
      logger.warn(`Could not obtain cookies for ${platform}/${browser}`, err);
      return;
    }

    const cookies = this.parseNetscapeCookies(content, options);
    if (cookies.length === 0) {
      logger.info(`No valid cookies to inject for ${platform}/${browser}`);
      return;
    }

    let injected = 0;
    const failed: string[] = [];
    for (const cookie of cookies) {
      try {
        await context.addCookies([cookie]);
        injected++;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${cookie.name}(${cookie.domain}): ${msg}`);
      }
    }

    logger.info(`[${platform}] Injected ${injected}/${cookies.length} cookies`);
    if (failed.length > 0) {
      logger.warn(`[${platform}] ${failed.length} cookies failed (first 3): ${failed.slice(0, 3).join('; ')}`);
    }
  }

  /**
   * 强制刷新 cookies：删除磁盘缓存，从系统浏览器重新提取，写入缓存并注入到 BrowserContext。
   * @returns true 表示刷新成功，false 表示提取失败
   */
  async refreshCookies(
    context: import('playwright').BrowserContext,
    platform: string,
    browser: string,
    options?: ParseCookiesOptions,
  ): Promise<boolean> {
    const cachePath = this.getCacheFilePath(platform, browser);

    // 删除旧的缓存文件
    await unlink(cachePath).catch(() => {});
    logger.info(`[${platform}] Cleared cached cookies, re-extracting from ${browser}...`);

    // 从浏览器重新提取
    const newContent = await this.extractFromBrowser(platform, browser);
    if (!newContent) {
      logger.error(`[${platform}] Failed to re-extract cookies from ${browser}`);
      return false;
    }

    // 写入新缓存
    await this.setCookies(platform, browser, newContent);

    // 清除 context 中的旧 cookies，重新注入
    await context.clearCookies();
    await this.injectIntoContext(context, platform, browser, options);

    logger.info(`[${platform}] Cookies refreshed successfully`);
    return true;
  }

  /**
   * 使用 yt-dlp 从系统浏览器提取 cookies，写入临时文件后读取内容。
   * 成功返回 Netscape 格式文本，失败返回 null（不抛出）。
   */
  private async extractFromBrowser(platform: string, browser: string): Promise<string | null> {
    const tempFile = join(this.cacheDir, `_temp_${Date.now()}.txt`);
    const probeUrl = this.getCookieProbeUrl(platform);

    return new Promise((resolve) => {
      const proc = spawn('yt-dlp', [
        '--cookies-from-browser', browser,
        '--cookies', tempFile,
        '--no-download',
        '-o', '/dev/null',
        probeUrl,
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
          const cookies = await readFile(tempFile, 'utf-8');
          await this.removeTempCookieFile(tempFile);
          if (cookies && cookies.includes('Netscape HTTP Cookie File')) {
            resolve(cookies);
          } else {
            logger.warn(`Cookie extraction produced invalid output (code=${code}): ${stderr}`);
            resolve(null);
          }
        } catch {
          await this.removeTempCookieFile(tempFile);
          logger.warn(`Cookie extraction failed: ${stderr || `exit code ${code}`}`);
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        this.removeTempCookieFile(tempFile).catch(() => undefined);
        logger.warn('Cookie extraction error', err);
        resolve(null);
      });
    });
  }

  private getCookieProbeUrl(platform: string): string {
    switch (platform) {
      case 'douyin':
        return 'https://www.douyin.com/robots.txt';
      case 'x':
        return 'https://x.com/robots.txt';
      case 'youtube':
      default:
        return 'https://www.youtube.com/robots.txt';
    }
  }

  private async removeTempCookieFile(tempFile: string): Promise<void> {
    await unlink(tempFile).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to remove temporary cookie file', err);
      }
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
        await unlink(join(this.cacheDir, file)).catch((err) => logger.warn('Failed to remove cookie cache file', err));
      }
    }
    logger.info('All cookies cleared');
  }
}
