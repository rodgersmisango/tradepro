/**
 * Allowed parent-frame origins for the no-code editor/preview postMessage
 * protocol. The edit/ and preview/ routes are embedded in a phone frame by the
 * App Builder dashboard; every incoming `message` event has its `event.origin`
 * validated against these patterns before any payload is trusted.
 *
 * Shared across all no-code templates (rise-fall, accumulators, digits) via
 * `@/lib/no-code-origins`.
 *
 * THIS FILE MUST NOT IMPORT ANYTHING. It is reached from `hooks/` and so is
 * detected and copied into every assembled partner app by the App Builder BFF
 * (`detectUsedSharedFiles` scans all of repo-root `hooks/`). That copy loop
 * resolves a dependency as `lib/<name>.ts` or `.tsx` only — a `./x.mjs` import
 * is followed by the detector, silently dropped by the copier, and then fails
 * the partner's own `next build` with TS2307. So the wizard host list is
 * duplicated here rather than imported from `lib/wizard-host-origins.mjs`;
 * `__tests__/allowed-origins.test.ts` fails if the two ever diverge.
 */
export const ALLOWED_ORIGINS = [
  /^https:\/\/developers\.deriv\.com$/,
  /^https:\/\/staging-developers\.deriv\.com$/,
  /^https:\/\/.*\.deriv-api-v2\.pages\.dev$/,
  /^http:\/\/localhost:\d+$/,
  /^https:\/\/.*\.deriv-blox\.pages\.dev$/,
  /^https:\/\/staging-blox\.deriv\.com$/,
  /^https:\/\/staging-blox\.deriv\.be$/,
  /^https:\/\/staging-blox\.deriv\.me$/,
  /^https:\/\/blox\.deriv\.com$/,
  /^https:\/\/blox\.deriv\.be$/,
  /^https:\/\/blox\.deriv\.me$/,
];

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.some((pattern) => pattern.test(origin));
}
