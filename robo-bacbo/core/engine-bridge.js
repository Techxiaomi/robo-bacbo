'use strict';

function assertPlaywrightPage(page) {
  const isPageLike = page &&
    typeof page.url === 'function' &&
    typeof page.frames === 'function' &&
    typeof page.isClosed === 'function';

  if (!isPageLike) {
    throw new TypeError('ENGINE_BRIDGE_INVALID_PAGE: expected a Playwright Page.');
  }

  if (page.isClosed()) {
    throw new Error('ENGINE_BRIDGE_CLOSED_PAGE: adapter returned a closed Playwright Page.');
  }
}

/**
 * Boundary between sportsbook adapters and the universal financial engine.
 * The adapter hands over Page; Evolution frame discovery remains in the engine.
 */
class EngineBridge {
  constructor() {
    this._handoff = null;
  }

  prepare({ page, houseId, accountId = null } = {}) {
    assertPlaywrightPage(page);

    if (typeof houseId !== 'string' || houseId.trim() === '') {
      throw new TypeError('ENGINE_BRIDGE_INVALID_HOUSE_ID: houseId is required.');
    }

    const metadata = Object.freeze({
      houseId: houseId.trim().toLowerCase(),
      accountId: accountId == null ? null : String(accountId),
    });

    // Freeze only the envelope; the Playwright Page must remain live/mutable.
    this._handoff = Object.freeze({ page, metadata });
    return this._handoff;
  }

  getPreparedHandoff() {
    if (!this._handoff) {
      throw new Error('ENGINE_BRIDGE_NOT_PREPARED: no adapter Page has been prepared.');
    }

    return this._handoff;
  }

  async handoffTo(engine) {
    const handoff = this.getPreparedHandoff();

    if (!engine || typeof engine.acceptPlaywrightPage !== 'function') {
      throw new TypeError(
        'ENGINE_BRIDGE_INVALID_ENGINE: universal engine must implement acceptPlaywrightPage(page, metadata).'
      );
    }

    // No iframe lookup or financial click is allowed in the bridge.
    return engine.acceptPlaywrightPage(handoff.page, handoff.metadata);
  }

  reset() {
    this._handoff = null;
  }
}

module.exports = {
  EngineBridge,
  assertPlaywrightPage,
};
