/**
 * Type guard: narrows `value` to `Record<string, unknown>`.
 *
 * Intended for narrowing values returned from `JSON.parse` / `jsonc.parse`,
 * where Date, Map, Set, RegExp, and class instances cannot appear. For those inputs,
 * this guard returns `true` if and only if `value` is a plain object.
 *
 * Caveat: when given runtime values from other sources, this also returns `true` for
 * Date, Map, Set, RegExp, and class instances (anything that is `typeof "object" &&
 * value !== null && !Array.isArray(value)`). Use a stricter check if you need to
 * exclude those.
 */
export function isRecordStringUnknown(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
