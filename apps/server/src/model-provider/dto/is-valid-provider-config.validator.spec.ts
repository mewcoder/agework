import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { IsValidProviderConfig } from "./is-valid-provider-config.validator";

class TestDto {
  @IsValidProviderConfig()
  config!: unknown;
}

async function validateConfig(config: unknown) {
  const dto = new TestDto();
  (dto as unknown as Record<string, unknown>).config = config;
  return validate(dto);
}

const validConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "sk-test-123",
  models: ["gpt-4", "gpt-3.5-turbo"],
  extraConfig: { region: "us-east-1" },
};

describe("IsValidProviderConfig", () => {
  it("accepts a valid config", async () => {
    const errors = await validateConfig(validConfig);
    expect(errors).toHaveLength(0);
  });

  it("rejects null", async () => {
    const errors = await validateConfig(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects array", async () => {
    const errors = await validateConfig([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects missing baseUrl", async () => {
    const errors = await validateConfig({ ...validConfig, baseUrl: "" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects non-string baseUrl", async () => {
    const errors = await validateConfig({ ...validConfig, baseUrl: 123 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects missing apiKey", async () => {
    const errors = await validateConfig({ ...validConfig, apiKey: "" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects empty models array", async () => {
    const errors = await validateConfig({ ...validConfig, models: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects models with empty strings", async () => {
    const errors = await validateConfig({ ...validConfig, models: [""] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects models with non-string entries", async () => {
    const errors = await validateConfig({ ...validConfig, models: [123] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects missing extraConfig", async () => {
    const errors = await validateConfig({ ...validConfig, extraConfig: null });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects extraConfig with non-string values", async () => {
    const errors = await validateConfig({
      ...validConfig,
      extraConfig: { count: 42 },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts empty extraConfig object", async () => {
    const errors = await validateConfig({
      ...validConfig,
      extraConfig: {},
    });
    expect(errors).toHaveLength(0);
  });
});
