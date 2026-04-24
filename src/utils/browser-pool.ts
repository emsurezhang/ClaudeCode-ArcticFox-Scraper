/**
 * Playwright 浏览器池
 * 复用 Browser 进程和 BrowserContext，减少启动开销
 */

import { chromium, Browser, BrowserContext } from 'playwright';
import type { IBrowserPool } from '../interfaces/index.js';

export class BrowserPool implements IBrowserPool {
  private browser?: Browser;
  private available = new Map<string, BrowserContext[]>();
  private inUse = new Set<BrowserContext>();

  async acquire(platform: string, browserName: string): Promise<BrowserContext> {
    const key = `${platform}_${browserName}`;

    const list = this.available.get(key);
    if (list && list.length > 0) {
      const ctx = list.pop()!;
      this.inUse.add(ctx);
      return ctx;
    }

    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }

    const ctx = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    this.inUse.add(ctx);
    return ctx;
  }

  async release(platform: string, browserName: string, context: BrowserContext): Promise<void> {
    const key = `${platform}_${browserName}`;
    this.inUse.delete(context);

    // 关闭上下文中的所有页面，保持上下文本身可复用
    const pages = context.pages();
    await Promise.all(pages.map((p) => p.close().catch((err) => console.warn('[BrowserPool] Warning:', err))));

    const list = this.available.get(key) || [];
    list.push(context);
    this.available.set(key, list);
  }

  async destroy(): Promise<void> {
    for (const ctx of this.inUse) {
      await ctx.close().catch((err) => console.warn('[BrowserPool] Warning:', err));
    }
    this.inUse.clear();

    for (const list of this.available.values()) {
      await Promise.all(list.map((ctx) => ctx.close().catch((err) => console.warn('[BrowserPool] Warning:', err))));
    }
    this.available.clear();

    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
  }
}
