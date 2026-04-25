import type { Page } from 'playwright';
import { createLogger } from '../../../src/core/logger.js';
import type { LoginStatus } from './types.js';

const logger = createLogger('YouTubeLoginCheck');

export async function isLoggedIn(page: Page): Promise<LoginStatus> {
  const status = await page.evaluate(() => {
    const avatarBtn = document.querySelector('button#avatar-btn, yt-img-shadow#avatar-btn, img[alt="Avatar"]');
    const signInLink = document.querySelector('a[href="https://accounts.google.com/ServiceLogin"], a.yt-spec-button-shape-next--outline');
    const isLoginPage =
      window.location.href.includes('accounts.google.com') ||
      !!document.querySelector('#identifierId') ||
      !!document.querySelector('ytd-signin-renderer') ||
      !!document.querySelector('yt-upsell-dialog-renderer');

    return {
      hasAvatar: !!avatarBtn,
      hasSignIn: !!signInLink,
      isLoginPage,
      currentUrl: window.location.href,
      userName: document.querySelector('button#avatar-btn img')?.getAttribute('alt') || '',
    };
  });

  logger.debug('Login status evaluated', {
    hasAvatar: status.hasAvatar,
    hasSignIn: status.hasSignIn,
    isLoginPage: status.isLoginPage,
    currentUrl: status.currentUrl,
    userName: status.userName,
  });

  return status;
}

export function requiresCookieRecovery(status: LoginStatus): boolean {
  return status.isLoginPage || (!status.hasAvatar && status.hasSignIn);
}
