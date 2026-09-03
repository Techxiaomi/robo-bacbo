'use strict';

const { chromium } = require('playwright');
const { createApprovedRegistry } = require('../../adapters/registry');
const { EngineBridge } = require('../../core/engine-bridge');

const MOCK_GAME_URL = 'data:text/html,<html><body><h1>Bac Bo Handoff Mock</h1></body></html>';

class MockTraderEngine {
  async acceptPlaywrightPage(page, metadata) {
    if (!page || page.isClosed()) {
      throw new Error('MOCK_ENGINE_INVALID_PAGE: expected a live Playwright Page.');
    }

    console.log(
      `HANDOFF_MOCK_SUCCESS: page received by Mock Trader Engine | house=${metadata.houseId} | url=${page.url()}`
    );

    return { ok: true };
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  let adapter = null;

  try {
    const registry = createApprovedRegistry();

    adapter = registry.create('brasil-da-sorte', {
      browser,
      gameUrl: process.env.BRASIL_DA_SORTE_GAME_URL || MOCK_GAME_URL,
      storageState: null,
      sessionCookies: [],
    });

    await adapter.prepareSession();
    await adapter.launchBacBo();

    const page = await adapter.getGamePage();
    const bridge = new EngineBridge();
    const mockEngine = new MockTraderEngine();

    bridge.prepare({
      page,
      houseId: 'brasil-da-sorte',
      accountId: 'handoff-mock',
    });

    await bridge.handoffTo(mockEngine);
  } finally {
    if (adapter) {
      await adapter.cleanup();
    }

    await browser.close();
  }
}

main().catch((error) => {
  console.error('HANDOFF_MOCK_FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
