import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBUG_MODE_KEY,
  createDebugModePreference,
  shouldShowPageContext,
} from "../../extension/settings/debug-mode.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) { listeners.forEach((listener) => listener(...args)); },
    count: () => listeners.length,
  };
}

function createHarness(initialValue) {
  const stored = initialValue === undefined ? {} : { [DEBUG_MODE_KEY]: initialValue };
  const storageChanged = createEvent();
  const writes = [];
  const storageArea = {
    async get(key) { return { [key]: stored[key] }; },
    async set(values) {
      writes.push(values);
      Object.assign(stored, values);
    },
  };
  const preference = createDebugModePreference({ storageArea, storageChanged });
  return { preference, storageChanged, writes };
}

test("Debug mode defaults off and accepts only a stored boolean true", async () => {
  assert.equal(await createHarness().preference.load(), false);
  assert.equal(await createHarness("true").preference.load(), false);
  assert.equal(await createHarness(true).preference.load(), true);
});

test("Debug mode persists a normalized local preference", async () => {
  const harness = createHarness();

  assert.equal(await harness.preference.save(true), true);
  assert.deepEqual(harness.writes, [{ [DEBUG_MODE_KEY]: true }]);
  assert.equal(await harness.preference.load(), true);
});

test("Debug mode subscriptions accept only local changes and can unsubscribe", () => {
  const harness = createHarness();
  const received = [];
  const unsubscribe = harness.preference.subscribe((enabled) => received.push(enabled));

  harness.storageChanged.emit({ [DEBUG_MODE_KEY]: { newValue: true } }, "sync");
  harness.storageChanged.emit({ unrelated: { newValue: true } }, "local");
  harness.storageChanged.emit({ [DEBUG_MODE_KEY]: { newValue: true } }, "local");
  harness.storageChanged.emit({ [DEBUG_MODE_KEY]: { newValue: "true" } }, "local");
  assert.deepEqual(received, [true, false]);

  unsubscribe();
  assert.equal(harness.storageChanged.count(), 0);
});

test("page context visibility requires Debug mode and a user context attachment", () => {
  const userMessage = { role: "user", context: { snapshot: { title: "Page" } } };
  assert.equal(shouldShowPageContext(false, userMessage), false);
  assert.equal(shouldShowPageContext(true, userMessage), true);
  assert.equal(shouldShowPageContext(true, { role: "assistant", context: {} }), false);
  assert.equal(shouldShowPageContext(true, { role: "user" }), false);
});
