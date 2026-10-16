// Parameter validation table: accepted sets with normalisation, every rejection rule, env-default merging and
// HB_DEFAULT_PARAMS parsing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeParams, paramsFromQueryString, toQueryString, validateParams } from '../hb/params.js';

test('accepts a full public parameter set with normalisation', () => {
  const p = validateParams({
    session_name: 'job-42',
    keep_alive: true,
    proxy: 'resi',
    p_cc: 'us',
    p_state: 'Texas',
    p_city: 'Los Angeles',
    proxy_resi_ses_id: 'acmeus01',
    proxy_resi_ses_time: 30,
    p_device: 'desktop',
    p_src: 'oxybrowser',
    p_fp_tag: 'oxyfp_mac_optimized',
    o_profile: 'acme-us-01',
    o_profile_save: true,
    record: true,
    record_name: 'job_42',
    page_handler: false,
  });
  assert.equal(p.p_cc, 'US');
  assert.equal(p.p_state, 'texas');
  assert.equal(p.p_city, 'los_angeles');
  assert.equal(
    toQueryString(p),
    'keep_alive=true&o_profile=acme-us-01&o_profile_save=true&p_cc=US&p_city=los_angeles&p_device=desktop&p_fp_tag=oxyfp_mac_optimized&p_src=oxybrowser&p_state=texas&page_handler=false&proxy=resi&proxy_resi_ses_id=acmeus01&proxy_resi_ses_time=30&record=true&record_name=job_42&session_name=job-42',
  );
});

const rejects: Array<[string, Record<string, unknown>, RegExp]> = [
  ['session_name format', { session_name: 'a_b' }, /session_name must be 3-36/],
  ['keep_alive without name', { keep_alive: true }, /keep_alive requires session_name/],
  ['proxy=dc with geo', { proxy: 'dc', p_cc: 'US', proxy_resi_ses_id: 'abc' }, /proxy=dc does not support \[p_cc proxy_resi_ses_id\]/],
  ['bad proxy', { proxy: 'ddc' }, /proxy/],
  ['bad p_cc', { p_cc: 'USA' }, /invalid p_cc/],
  ['p_city alone', { p_city: 'berlin' }, /p_city requires p_cc or p_state/],
  ['sticky id format', { proxy_resi_ses_id: '_abc' }, /proxy_resi_ses_id must be/],
  ['sticky time range', { proxy_resi_ses_time: 0 }, /proxy_resi_ses_time must be between 1 and 1440/],
  ['tablet', { p_device: 'tablet' }, /p_device/],
  ['unknown engine', { p_src: 'cachro' }, /p_src/],
  ['unknown browser profile tag', { p_fp_tag: 'v1' }, /p_fp_tag/],
  ['mac_optimized without oxybrowser', { p_fp_tag: 'oxyfp_mac_optimized' }, /oxyfp_mac_optimized requires p_src=oxybrowser/],
  ['browser profile tag on mobile', { p_device: 'mobile', p_fp_tag: 'oxyfp_mac' }, /desktop profile family/],
  ['profile format', { o_profile: 'ab' }, /o_profile must contain/],
  ['profile save without profile', { o_profile_save: true }, /o_profile_save requires o_profile/],
  ['record_name without record', { record_name: 'x' }, /record_name requires record=true/],
  ['record_name format', { record: true, record_name: 'a b' }, /record_name must contain/],
  ['internal param', { p_fp_id: '1' }, /p_fp_id is not a public parameter/],
  ['internal humanize', { o_humanize: true }, /o_humanize is not a public parameter/],
  ['unknown param', { foo: 'bar' }, /unknown parameter foo/],
  ['wrong type', { record: 'yes' }, /record/],
];

test('accepts every public browser engine and browser profile tag', () => {
  for (const tag of ['oxyfp_win', 'oxyfp_mac', 'oxyfp_v1_win']) {
    assert.deepEqual(validateParams({ p_fp_tag: tag }), { p_fp_tag: tag });
    assert.deepEqual(validateParams({ p_fp_tag: tag, p_src: 'oxybrowser' }), { p_fp_tag: tag, p_src: 'oxybrowser' });
  }
  assert.deepEqual(validateParams({ p_src: 'oxybrowser' }), { p_src: 'oxybrowser' });
  assert.equal(toQueryString(validateParams({ p_cc: 'US', p_src: 'oxybrowser', p_fp_tag: 'oxyfp_mac_optimized' })), 'p_cc=US&p_fp_tag=oxyfp_mac_optimized&p_src=oxybrowser');
  // The engine rule applies after env defaults are merged, in both directions.
  const engine = validateParams({ p_src: 'oxybrowser' });
  assert.deepEqual(mergeParams(engine, { p_fp_tag: 'oxyfp_mac_optimized' }), { p_src: 'oxybrowser', p_fp_tag: 'oxyfp_mac_optimized' });
  assert.throws(() => mergeParams(engine, { p_fp_tag: 'oxyfp_mac_optimized' }, true), /requires p_src=oxybrowser/);
  assert.deepEqual(paramsFromQueryString('p_src=oxybrowser&p_fp_tag=oxyfp_mac_optimized'), { p_src: 'oxybrowser', p_fp_tag: 'oxyfp_mac_optimized' });
});

for (const [name, input, re] of rejects) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateParams(input), re);
  });
}

test('merges env defaults and applies combination rules after the merge', () => {
  const defaults = validateParams({ p_cc: 'US' });
  assert.throws(() => mergeParams(defaults, { proxy: 'dc' }), /proxy=dc does not support \[p_cc\]/);
  const replaced = mergeParams(defaults, { proxy: 'dc' }, true);
  assert.deepEqual(replaced, { proxy: 'dc' });
  const merged = mergeParams(defaults, { p_device: 'mobile' });
  assert.deepEqual(merged, { p_cc: 'US', p_device: 'mobile' });
});

test('parses HB_DEFAULT_PARAMS query strings with coercion', () => {
  const p = paramsFromQueryString('?p_cc=de&record=1&proxy_resi_ses_time=15&page_handler=false');
  assert.deepEqual(p, { p_cc: 'DE', record: true, proxy_resi_ses_time: 15, page_handler: false });
  assert.throws(() => paramsFromQueryString('keep_alive=true'), /keep_alive requires session_name/);
});
