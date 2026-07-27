import test from 'node:test';
import assert from 'node:assert/strict';

// time.js builds day boundaries from LOCAL Date fields (new Date('YYYY-MM-DDT00:00:00'),
// .getHours(), .getFullYear()). The gap-free chunker invariant therefore depends on the process
// running in Africa/Cairo. `npm test` pins TZ; this guard makes a wrong environment fail with a
// clear message instead of a mysterious chunker/date test failure on, say, a UTC CI runner.
const HINT = 'Run tests with TZ=Africa/Cairo (npm test / npm run test:tz set it). ' +
  'The chunker uses Cairo-local day boundaries; a different zone shifts them.';

test('environment: timezone is Africa/Cairo (UTC+2 winter / +3 summer DST)', () => {
  const janOff = new Date('2025-01-15T00:00:00').getTimezoneOffset(); // standard time → -120
  const julOff = new Date('2025-07-15T00:00:00').getTimezoneOffset(); // DST → -180
  assert.equal(janOff, -120, `January offset should be -120 (UTC+2). Got ${janOff}. ${HINT}`);
  assert.equal(julOff, -180, `July offset should be -180 (UTC+3 DST). Got ${julOff}. ${HINT}`);
});
