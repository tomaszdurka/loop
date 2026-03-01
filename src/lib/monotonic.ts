/**
 * Checks if a sequence is monotonic (either entirely non-increasing or entirely non-decreasing).
 *
 * @param sequence - Array of numbers to check
 * @returns true if the sequence is monotonic, false otherwise
 */
export function isMonotonic(sequence: number[]): boolean {
  if (sequence.length <= 1) {
    return true;
  }

  let isNonDecreasing = true;
  let isNonIncreasing = true;

  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] < sequence[i - 1]) {
      isNonDecreasing = false;
    }
    if (sequence[i] > sequence[i - 1]) {
      isNonIncreasing = false;
    }
  }

  return isNonDecreasing || isNonIncreasing;
}
