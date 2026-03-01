import { describe, it } from "node:test";
import assert from "node:assert";
import { isMonotonic } from "./monotonic.js";

describe("isMonotonic", () => {
  it("should return true for empty arrays", () => {
    assert.strictEqual(isMonotonic([]), true);
  });

  it("should return true for single element arrays", () => {
    assert.strictEqual(isMonotonic([5]), true);
  });

  it("should return true for arrays with all equal elements", () => {
    assert.strictEqual(isMonotonic([3, 3, 3, 3]), true);
  });

  it("should return true for strictly increasing sequences", () => {
    assert.strictEqual(isMonotonic([1, 2, 3, 4, 5]), true);
  });

  it("should return true for non-decreasing sequences", () => {
    assert.strictEqual(isMonotonic([1, 2, 2, 3, 4]), true);
  });

  it("should return true for strictly decreasing sequences", () => {
    assert.strictEqual(isMonotonic([5, 4, 3, 2, 1]), true);
  });

  it("should return true for non-increasing sequences", () => {
    assert.strictEqual(isMonotonic([5, 4, 4, 3, 1]), true);
  });

  it("should return false for non-monotonic sequences", () => {
    assert.strictEqual(isMonotonic([1, 3, 2, 4]), false);
  });

  it("should return false for sequences that go up then down", () => {
    assert.strictEqual(isMonotonic([1, 2, 3, 2, 1]), false);
  });

  it("should return false for sequences that go down then up", () => {
    assert.strictEqual(isMonotonic([5, 3, 4]), false);
  });

  it("should handle two-element arrays correctly", () => {
    assert.strictEqual(isMonotonic([1, 2]), true);
    assert.strictEqual(isMonotonic([2, 1]), true);
    assert.strictEqual(isMonotonic([1, 1]), true);
  });

  it("should handle negative numbers", () => {
    assert.strictEqual(isMonotonic([-5, -3, -1, 0, 2]), true);
    assert.strictEqual(isMonotonic([2, 0, -1, -3, -5]), true);
    assert.strictEqual(isMonotonic([-1, -5, -3]), false);
  });

  it("should handle mixed positive and negative numbers", () => {
    assert.strictEqual(isMonotonic([-10, -5, 0, 5, 10]), true);
    assert.strictEqual(isMonotonic([10, 5, 0, -5, -10]), true);
  });
});
