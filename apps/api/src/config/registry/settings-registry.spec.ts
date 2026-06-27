import { describe, it, expect } from "vitest";
import {
  getSettingDefinition,
  coerceSettingValue,
  SETTINGS_REGISTRY,
  SettingKey,
} from "./settings-registry";

describe("getSettingDefinition", () => {
  it("finds a setting by key", () => {
    const def = getSettingDefinition(SettingKey.APP_NAME);
    expect(def).toBeDefined();
    expect(def!.key).toBe(SettingKey.APP_NAME);
    expect(def!.type).toBe("string");
  });

  it("returns undefined for unknown key", () => {
    expect(getSettingDefinition("UNKNOWN_KEY")).toBeUndefined();
  });
});

describe("coerceSettingValue", () => {
  const numberDef = getSettingDefinition(
    SettingKey.RUNTIME_IDLE_TIMEOUT_SECONDS
  )!;
  const stringDef = getSettingDefinition(SettingKey.APP_NAME)!;

  it("passes through string type values unchanged", () => {
    expect(coerceSettingValue(stringDef, "MyApp")).toBe("MyApp");
  });

  it("coerces a valid number string to its numeric form", () => {
    const result = coerceSettingValue(numberDef, "42");
    expect(result).toBe("42");
    expect(Number(result)).toBe(42);
  });

  it("coerces zero as a valid number", () => {
    expect(Number(coerceSettingValue(numberDef, "0"))).toBe(0);
  });

  it("accepts negative numbers", () => {
    expect(Number(coerceSettingValue(numberDef, "-1"))).toBe(-1);
  });

  it("accepts decimal numbers", () => {
    expect(Number(coerceSettingValue(numberDef, "3.14"))).toBe(3.14);
  });

  it("rejects non-finite numbers (NaN, Infinity)", () => {
    expect(() => coerceSettingValue(numberDef, "abc")).toThrow();
    expect(() => coerceSettingValue(numberDef, "NaN")).toThrow();
    expect(() => coerceSettingValue(numberDef, "Infinity")).toThrow();
    expect(() => coerceSettingValue(numberDef, "-Infinity")).toThrow();
  });
});

describe("SETTINGS_REGISTRY", () => {
  it("has at least one entry", () => {
    expect(SETTINGS_REGISTRY.length).toBeGreaterThan(0);
  });

  it("each entry has required fields", () => {
    for (const def of SETTINGS_REGISTRY) {
      expect(def.key).toBeTruthy();
      expect(["string", "number"]).toContain(def.type);
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.defaultValue).toBeTruthy();
    }
  });
});
