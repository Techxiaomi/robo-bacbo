'use strict';

/**
 * Adapter contract for sportsbook-specific session and pre-launch work.
 * Financial interaction belongs exclusively to the universal trader engine.
 */
class BettingHouseAdapter {
  constructor(dependencies = {}) {
    if (new.target === BettingHouseAdapter) {
      throw new TypeError('BettingHouseAdapter is an abstract contract and cannot be instantiated directly.');
    }

    this._dependencies = Object.freeze({ ...dependencies });
  }

  async prepareSession() {
    throw new Error('ADAPTER_CONTRACT_VIOLATION: prepareSession() must be implemented.');
  }

  async launchBacBo() {
    throw new Error('ADAPTER_CONTRACT_VIOLATION: launchBacBo() must be implemented.');
  }

  async getGamePage() {
    throw new Error('ADAPTER_CONTRACT_VIOLATION: getGamePage() must be implemented.');
  }

  async cleanup() {
    throw new Error('ADAPTER_CONTRACT_VIOLATION: cleanup() must be implemented.');
  }

  // Financial commands are forbidden at the adapter boundary by design.
  async placeBet() {
    throw new Error('ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: placeBet() belongs to the universal trader engine.');
  }

  async selectChip() {
    throw new Error('ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: selectChip() belongs to the universal trader engine.');
  }

  async clickPlayer() {
    throw new Error('ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: clickPlayer() belongs to the universal trader engine.');
  }

  async clickBanker() {
    throw new Error('ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: clickBanker() belongs to the universal trader engine.');
  }

  async clickTie() {
    throw new Error('ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: clickTie() belongs to the universal trader engine.');
  }
}

const REQUIRED_METHODS = Object.freeze([
  'prepareSession',
  'launchBacBo',
  'getGamePage',
  'cleanup',
]);

const FORBIDDEN_FINANCIAL_METHODS = Object.freeze([
  'placeBet',
  'selectChip',
  'clickPlayer',
  'clickBanker',
  'clickTie',
]);

const FORBIDDEN_FINANCIAL_NAME_PATTERN = /(?:^|_)(?:bet|wager|stake|chip|player|banker|tie)(?:$|_)/i;

function validateAdapterClass(AdapterClass) {
  if (typeof AdapterClass !== 'function') {
    throw new TypeError('ADAPTER_INVALID_CLASS: adapter must be a class/function.');
  }

  if (AdapterClass === BettingHouseAdapter || !(AdapterClass.prototype instanceof BettingHouseAdapter)) {
    throw new TypeError('ADAPTER_INVALID_CLASS: adapter must extend BettingHouseAdapter.');
  }

  for (const methodName of REQUIRED_METHODS) {
    if (
      typeof AdapterClass.prototype[methodName] !== 'function' ||
      AdapterClass.prototype[methodName] === BettingHouseAdapter.prototype[methodName]
    ) {
      throw new TypeError(`ADAPTER_CONTRACT_VIOLATION: ${methodName}() must be implemented by the adapter.`);
    }
  }

  const ownMethods = Object.getOwnPropertyNames(AdapterClass.prototype)
    .filter((name) => name !== 'constructor');

  for (const methodName of ownMethods) {
    if (
      FORBIDDEN_FINANCIAL_METHODS.includes(methodName) ||
      (!REQUIRED_METHODS.includes(methodName) && FORBIDDEN_FINANCIAL_NAME_PATTERN.test(methodName))
    ) {
      throw new TypeError(
        `ADAPTER_FINANCIAL_ACCESS_FORBIDDEN: adapter cannot implement financial method "${methodName}".`
      );
    }
  }

  return true;
}

module.exports = {
  BettingHouseAdapter,
  REQUIRED_METHODS,
  FORBIDDEN_FINANCIAL_METHODS,
  validateAdapterClass,
};
