import { describe, expect, it } from "vitest";

import { isRecordStringUnknown } from "./types.js";

describe("isRecordStringUnknown", () => {
  it("should return true for plain objects", () => {
    expect(isRecordStringUnknown({ foo: "bar" })).toBe(true);
    expect(isRecordStringUnknown({ a: 1, b: 2, c: 3 })).toBe(true);
  });

  it("should return true for empty objects", () => {
    expect(isRecordStringUnknown({})).toBe(true);
  });

  it("should return true for nested objects", () => {
    expect(isRecordStringUnknown({ nested: { deep: { value: 1 } } })).toBe(true);
  });

  it("should return true for objects with mixed value types", () => {
    expect(
      isRecordStringUnknown({
        string: "value",
        number: 42,
        boolean: true,
        null: null,
        undefined: undefined,
        array: [1, 2, 3],
        object: { nested: true },
      }),
    ).toBe(true);
  });

  it("should return false for null", () => {
    expect(isRecordStringUnknown(null)).toBe(false);
  });

  it("should return false for arrays", () => {
    expect(isRecordStringUnknown([])).toBe(false);
    expect(isRecordStringUnknown([1, 2, 3])).toBe(false);
    expect(isRecordStringUnknown([{ foo: "bar" }])).toBe(false);
  });

  it("should return false for primitive types", () => {
    expect(isRecordStringUnknown("string")).toBe(false);
    expect(isRecordStringUnknown(123)).toBe(false);
    expect(isRecordStringUnknown(true)).toBe(false);
    expect(isRecordStringUnknown(false)).toBe(false);
    expect(isRecordStringUnknown(undefined)).toBe(false);
    expect(isRecordStringUnknown(Symbol("test"))).toBe(false);
    expect(isRecordStringUnknown(BigInt(123))).toBe(false);
  });

  it("should return true for class instances", () => {
    // Known behavior: this guard is loose by design — see JSDoc on isRecordStringUnknown.
    class TestClass {
      value = 1;
    }
    expect(isRecordStringUnknown(new TestClass())).toBe(true);
  });

  it("should return true for Object.create(null)", () => {
    const nullPrototypeObj = Object.create(null);
    nullPrototypeObj.foo = "bar";
    expect(isRecordStringUnknown(nullPrototypeObj)).toBe(true);
  });

  it("should return false for functions", () => {
    expect(isRecordStringUnknown(() => {})).toBe(false);
    expect(isRecordStringUnknown(function () {})).toBe(false);
    expect(
      isRecordStringUnknown(
        class {
          foo = 1;
        },
      ),
    ).toBe(false);
  });

  it("should return true for Date objects", () => {
    expect(isRecordStringUnknown(new Date())).toBe(true);
  });

  it("should return true for RegExp objects", () => {
    expect(isRecordStringUnknown(/test/)).toBe(true);
    expect(isRecordStringUnknown(new RegExp("test"))).toBe(true);
  });

  it("should return true for Map and Set objects", () => {
    expect(isRecordStringUnknown(new Map())).toBe(true);
    expect(isRecordStringUnknown(new Set())).toBe(true);
  });
});
