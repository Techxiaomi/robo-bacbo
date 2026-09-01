'use strict';

const { validateAdapterClass } = require('./contract/betting-house-adapter');

const HOUSE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function normalizeHouseId(houseId) {
  if (typeof houseId !== 'string') {
    throw new TypeError('ADAPTER_INVALID_HOUSE_ID: house id must be a string.');
  }

  const normalized = houseId.trim().toLowerCase();

  if (!HOUSE_ID_PATTERN.test(normalized)) {
    throw new TypeError('ADAPTER_INVALID_HOUSE_ID: use only lowercase letters, numbers, hyphens or underscores.');
  }

  return normalized;
}

/**
 * Registry of explicitly approved adapter classes.
 * It never resolves module paths from runtime/user input.
 */
class BettingHouseAdapterRegistry {
  constructor() {
    this._adapters = new Map();
    this._sealed = false;
  }

  register(houseId, AdapterClass) {
    if (this._sealed) {
      throw new Error('ADAPTER_REGISTRY_SEALED: no adapters can be registered after bootstrap.');
    }

    const normalizedHouseId = normalizeHouseId(houseId);
    validateAdapterClass(AdapterClass);

    if (this._adapters.has(normalizedHouseId)) {
      throw new Error(`ADAPTER_ALREADY_REGISTERED: "${normalizedHouseId}" is already approved.`);
    }

    this._adapters.set(normalizedHouseId, AdapterClass);
    return this;
  }

  seal() {
    this._sealed = true;
    return this;
  }

  has(houseId) {
    return this._adapters.has(normalizeHouseId(houseId));
  }

  listApproved() {
    return Object.freeze([...this._adapters.keys()].sort());
  }

  create(houseId, dependencies = {}) {
    const normalizedHouseId = normalizeHouseId(houseId);
    const AdapterClass = this._adapters.get(normalizedHouseId);

    if (!AdapterClass) {
      throw new Error(`UNSUPPORTED_BETTING_HOUSE: "${normalizedHouseId}" is not registered.`);
    }

    // Validation is repeated at load time to fail closed if a class was mutated.
    validateAdapterClass(AdapterClass);
    return new AdapterClass(dependencies);
  }
}

module.exports = {
  BettingHouseAdapterRegistry,
  normalizeHouseId,
};
