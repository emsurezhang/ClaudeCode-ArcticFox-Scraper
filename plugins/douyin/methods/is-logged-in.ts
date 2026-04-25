import type { Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import type { DouYinLoginStatus } from './types.js';

const logger = createLogger('DouYinLoginCheck');

/**
 * 检测当前页面的登录状态。
 *
 * 判断依据（均来自真实 HTML 样本）：
 *
 * **验证码**（`captcha.html`）：
 * - `<title>Captcha</title>`
 * - `iframe[src*="rmc.bytedance.com/verifycenter"]`
 * - `.middle_page_loading` 占位层
 *
 * **已登录**（`login_success.html`）：
 * - `[data-e2e="live-avatar"]` — 导航栏用户头像（nav 常驻）
 * - `a[href*="douyin.com/user/self"]` — 指向当前用户主页的链接
 *
 * **未登录**：
 * - 页面跳转至 `passport.douyin.com`
 * - 未检测到头像元素
 */
export async function isLoggedIn(page: Page): Promise<DouYinLoginStatus> {
  const status = await page.evaluate(() => {
    // 验证码：页面标题为 "Captcha"
    const titleIsCaptcha = document.title.trim().toLowerCase() === 'captcha';
    // 验证码：字节跳动验证中心 iframe
    const captchaIframe = document.querySelector(
      'iframe[src*="rmc.bytedance.com/verifycenter"], iframe[src*="verify.zijieapi.com"]',
    );
    // 验证码：专属加载占位层
    const loadingLayer = document.querySelector('.middle_page_loading');
    const hasCaptcha = titleIsCaptcha || !!(captchaIframe || loadingLayer);

    // 已登录：导航栏头像（login_success.html 确认的 data-e2e 值）
    const liveAvatar = document.querySelector('[data-e2e="live-avatar"]');
    // 已登录：指向当前用户个人页的链接（仅登录后存在）
    const selfLink = document.querySelector('a[href*="douyin.com/user/self"]');
    const hasAvatar = !!(liveAvatar || selfLink);

    // 未登录：明确的登录按钮（抖音 PC 导航栏）
    const loginBtn = document.querySelector(
      '[data-e2e="login-button"], .login-button, button.semi-button[class*="login"]',
    );
    const hasLoginButton = !!loginBtn;

    return {
      hasCaptcha,
      hasAvatar,
      hasLoginButton,
      currentUrl: window.location.href,
    };
  });

  logger.debug('Login status evaluated', {
    hasCaptcha: status.hasCaptcha,
    hasAvatar: status.hasAvatar,
    hasLoginButton: status.hasLoginButton,
    currentUrl: status.currentUrl,
  });

  return status;
}

/**
 * 判断是否需要重新注入 cookie 并重试。
 *
 * 以下任一条件成立即触发恢复：
 * - 出现验证码（cookie 过期或 IP 异常）
 * - 页面跳转至 passport.douyin.com 登录页
 * - 未检测到头像且明确显示登录按钮
 */
export function requiresCookieRecovery(status: DouYinLoginStatus): boolean {
  const isPassportPage = status.currentUrl.includes('passport.douyin.com');
  return status.hasCaptcha || isPassportPage || (!status.hasAvatar && status.hasLoginButton);
}
