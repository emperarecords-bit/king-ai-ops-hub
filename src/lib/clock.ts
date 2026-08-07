/**
 * Read the wall clock at an explicit request-time boundary.
 *
 * Keeping this outside React render functions makes time-dependent UI decisions
 * visible and gives tests one small seam to replace when deterministic time is
 * required.
 */
export function currentEpochMs(): number {
  return Date.now();
}
