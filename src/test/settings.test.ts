// Settings resolution: defaults, flag/env precedence, forced Playwright keys, early rejection of bad input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSettings, resolveSettings } from '../settings.js';

test('defaults to prod with derived URLs and forced playwright keys', () => {
  const s = resolveSettings({ OXY_AB_USERNAME: 'u', OXY_AB_PASSWORD: 'secretpw' });
  assert.equal(s.username, 'u');
  assert.equal(s.authMode, 'header');
  assert.deepEqual(s.playwright.capabilities, ['vision', 'pdf']);
  assert.equal(s.playwright.browser?.isolated, false);
  assert.equal(s.playwright.secrets?.OXY_AB_PASSWORD, 'secretpw');
  assert.equal(s.playwright.timeouts?.navigation, 60000);
  assert.equal(JSON.stringify(describeSettings(s)).includes('secretpw'), false);
});

test('flags override env', () => {
  const s = resolveSettings({ HB_DEFAULT_PARAMS: 'p_cc=US', HB_CAPS: 'storage' }, { caps: 'network,storage', timeoutNavigation: 90000, outputDir: '/tmp/x' });
  assert.deepEqual(s.defaultParams, { p_cc: 'US' });
  assert.deepEqual(s.playwright.capabilities, ['network', 'storage']);
  assert.equal(s.playwright.timeouts?.navigation, 90000);
  assert.equal(s.playwright.outputDir, '/tmp/x');
  assert.equal(s.username, undefined);
});

test('rejects bad input early', () => {
  assert.throws(() => resolveSettings({ HB_DEFAULT_PARAMS: 'keep_alive=true' }), /keep_alive requires session_name/);
  assert.throws(() => resolveSettings({ HB_AUTH_MODE: 'cookie' }), /HB_AUTH_MODE/);
  assert.throws(() => resolveSettings({}, { caps: 'magic' }), /unknown capability/);
});
