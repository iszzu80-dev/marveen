// THE SUITE'S CLOCK IS PINNED, because otherwise it is the host's.
//
// `APP_TZ` (src/config.ts) falls back to the SYSTEM zone when SCHEDULER_TZ is
// unset. This machine is Europe/Budapest; a CI runner is UTC. Every
// time-of-day rule in the reader -- quiet hours, the midnight wrap, the morning
// package -- is therefore evaluated against a different clock in the two
// places, while the fixtures that pin absolute epochs are written for one of
// them.
//
// FOUND BY CI, 2026-09-04, and the test file's own header had claimed the
// opposite: that pinning epochs and asserting through the same helper the
// reader uses meant "a change of APP_TZ moves the tests and the code together".
// It does not. The helper moves; the fixture's `at()` hard-codes a UTC+1
// offset, so on a UTC runner the two describe different hours and five tests
// failed that had been green here all day.
//
// TZ IS THE LEVER, and finding that out took one failed attempt. config.ts
// reads SCHEDULER_TZ from the .env FILE (`readEnvFile()`), never from the
// environment, so exporting SCHEDULER_TZ here changes nothing. What it falls
// back to is `Intl.DateTimeFormat().resolvedOptions().timeZone`, and that
// follows TZ. So TZ is what pins APP_TZ, and it also fixes any test reaching
// for a local Date method rather than the helper.
//
// UNCONDITIONAL, not `??=`. The suite does not test "whichever zone you like";
// every fixture in it encodes Budapest rules, so a run under another zone is
// not a stricter run, it is a run of tests whose expectations no longer match
// the code they exercise. Set here rather than in the CI workflow on purpose:
// a pin that lives only in the runner leaves the developer machine free to
// disagree, which is the exact shape of the bug this closes.

process.env.TZ = 'Europe/Budapest'
