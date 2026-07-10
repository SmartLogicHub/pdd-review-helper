const LOGIN_PATTERNS = [
  /\/login/i,
  /登录/,
  /手机号登录/,
  /扫码登录/,
];

export const SECURITY_VERIFICATION_TEXT_PATTERN = [
  '验证码',
  '人机验证',
  '安全验证',
  '身份验证',
  '账号安全',
  '拖动.*滑块',
  '滑块',
  '请完成验证',
  'verify',
  'captcha',
].join('|');

export function isSecurityVerificationText(text = '') {
  return new RegExp(SECURITY_VERIFICATION_TEXT_PATTERN, 'i').test(String(text || ''));
}

export function classifyPddPageState({
  url = '',
  visibleText = '',
  hasCloseControl = false,
} = {}) {
  const text = String(visibleText || '').replace(/\s+/g, ' ').trim();
  const currentUrl = String(url || '');
  const isLoginPage = LOGIN_PATTERNS.some(pattern => pattern.test(currentUrl)) && /登录/.test(text);

  if (isLoginPage) {
    return {
      kind: 'login',
      waiting: true,
      message: '请在打开的浏览器中登录拼多多商家后台，登录完成后任务会继续。',
    };
  }

  if (isSecurityVerificationText(text)) {
    if (hasCloseControl) {
      return {
        kind: 'closeable-verification',
        waiting: false,
        message: '检测到登录后的可关闭验证/提示弹窗，将关闭后继续。',
      };
    }
    return {
      kind: 'verification',
      waiting: true,
      message: '检测到拼多多验证/风控提示，请手动完成或关闭后任务会继续。',
    };
  }

  return { kind: 'ready', waiting: false, message: '' };
}

export async function getPddPageState(page) {
  const [{ visibleText, hasCloseControl }] = await Promise.all([
    page.evaluate(() => {
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8
          && rect.height > 8
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0';
      };

      const overlays = Array.from(document.querySelectorAll([
        '[role="dialog"]',
        '[class*="modal"]',
        '[class*="Modal"]',
        '[class*="dialog"]',
        '[class*="Dialog"]',
        '[class*="verify"]',
        '[class*="Verify"]',
        '[class*="captcha"]',
        '[class*="Captcha"]',
        '[class*="slider"]',
        '[class*="Slider"]',
      ].join(','))).filter(isVisible);

      const overlayText = overlays
        .map(node => node.innerText || node.textContent || '')
        .filter(Boolean)
        .join(' ');
      const bodyText = document.body?.innerText || '';
      const hasCloseControl = overlays.some(node => Array.from(node.querySelectorAll([
        'button',
        '[role="button"]',
        '[class*="close"]',
        '[class*="Close"]',
        '[aria-label*="关闭"]',
        '[aria-label*="close" i]',
      ].join(','))).some(isVisible));

      return {
        visibleText: (overlayText || bodyText).slice(0, 4000),
        hasCloseControl,
      };
    }).catch(() => ({ visibleText: '', hasCloseControl: false })),
  ]);

  return classifyPddPageState({
    url: page.url(),
    visibleText,
    hasCloseControl,
  });
}
