/**
 * Non-blocking async delay — replaces execFileSync('/bin/sleep', …) to keep
 * the libuv event loop free for HTTP handlers, message delivery, and other I/O.
 *
 * Port of upstream PR #555 (zollak, fix/dashboard-eventloop-block-reconnect):
 * every previously-blocking /bin/sleep on the timer and delivery stacks becomes
 * an `await delay(ms)` so the dashboard no longer goes HTTP-deaf under fleet
 * load (~15 agents polling at 5-second ticks).
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
