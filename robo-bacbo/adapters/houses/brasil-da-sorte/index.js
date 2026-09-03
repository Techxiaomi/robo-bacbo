'use strict';

const { BettingHouseAdapter } = require('../../contract/betting-house-adapter');

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;

function assertNonEmptyString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${code}: expected a non-empty string.`);
  }

  return value.trim();
}

/**
 * Brasil da Sorte shell adapter.
 * Owns only session/login/pre-launch; financial interaction remains in the core engine.
 */
class BrasilDaSorteAdapter extends BettingHouseAdapter {
  constructor(dependencies = {}) {
    super(dependencies);

    const {
      browser,
      gameUrl,
      homeUrl = null,
      storageState = null,
      sessionCookies = [],
      login = null,
      navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
    } = dependencies;

    if (!browser || typeof browser.newContext !== 'function') {
      throw new TypeError('BRASIL_DA_SORTE_INVALID_BROWSER: expected a Playwright Browser.');
    }

    this._browser = browser;
    this._gameUrl = assertNonEmptyString(gameUrl, 'BRASIL_DA_SORTE_INVALID_GAME_URL');
    this._homeUrl = homeUrl == null
      ? null
      : assertNonEmptyString(homeUrl, 'BRASIL_DA_SORTE_INVALID_HOME_URL');
    this._storageState = storageState;
    this._sessionCookies = Array.isArray(sessionCookies) ? [...sessionCookies] : null;
    this._login = login;
    this._navigationTimeoutMs = Number(navigationTimeoutMs);
    this._context = null;
    this._page = null;

    if (!this._sessionCookies) {
      throw new TypeError('BRASIL_DA_SORTE_INVALID_COOKIES: sessionCookies must be an array.');
    }

    if (!Number.isFinite(this._navigationTimeoutMs) || this._navigationTimeoutMs <= 0) {
      throw new TypeError('BRASIL_DA_SORTE_INVALID_TIMEOUT: navigationTimeoutMs must be positive.');
    }
  }

  async prepareSession() {
    if (this._context || this._page) {
      throw new Error('BRASIL_DA_SORTE_SESSION_ALREADY_PREPARED: adapter instances are single-session.');
    }

    const contextOptions = {};
    if (this._storageState != null) {
      contextOptions.storageState = this._storageState;
    }

    this._context = await this._browser.newContext(contextOptions);

    if (this._sessionCookies.length > 0) {
      await this._context.addCookies(this._sessionCookies);
    }

    this._page = await this._context.newPage();
    this._page.setDefaultNavigationTimeout(this._navigationTimeoutMs);

    if (this._homeUrl) {
      await this._page.goto(this._homeUrl, { waitUntil: 'domcontentloaded' });
    }

    if (this._login) {
      await this._performInjectedLogin();
    }

    return this._page;
  }

  async launchBacBo() {
    const page = this._requirePreparedPage();
    await page.goto(this._gameUrl, { waitUntil: 'domcontentloaded' });
    return page;
  }

  async getGamePage() {
    return this._requirePreparedPage();
  }

  async cleanup() {
    const context = this._context;
    this._page = null;
    this._context = null;

    if (context) {
      await context.close();
    }
  }

  async _performInjectedLogin() {
    const login = this._login;

    if (!login || typeof login !== 'object') {
      throw new TypeError('BRASIL_DA_SORTE_INVALID_LOGIN: login configuration must be an object.');
    }

    const username = assertNonEmptyString(login.username, 'BRASIL_DA_SORTE_INVALID_USERNAME');
    const password = assertNonEmptyString(login.password, 'BRASIL_DA_SORTE_INVALID_PASSWORD');
    const usernameSelector = assertNonEmptyString(
      login.usernameSelector,
      'BRASIL_DA_SORTE_INVALID_USERNAME_SELECTOR'
    );
    const passwordSelector = assertNonEmptyString(
      login.passwordSelector,
      'BRASIL_DA_SORTE_INVALID_PASSWORD_SELECTOR'
    );
    const submitSelector = assertNonEmptyString(
      login.submitSelector,
      'BRASIL_DA_SORTE_INVALID_SUBMIT_SELECTOR'
    );

    // Login is shell-only. No Evolution selectors or financial controls are allowed here.
    await this._page.locator(usernameSelector).fill(username);
    await this._page.locator(passwordSelector).fill(password);
    await this._page.locator(submitSelector).click();

    if (login.postLoginUrlPattern) {
      await this._page.waitForURL(login.postLoginUrlPattern, {
        timeout: this._navigationTimeoutMs,
      });
    }
  }

  _requirePreparedPage() {
    if (!this._page || this._page.isClosed()) {
      throw new Error('BRASIL_DA_SORTE_PAGE_NOT_READY: call prepareSession() before launch/getGamePage.');
    }

    return this._page;
  }
}

module.exports = BrasilDaSorteAdapter;
