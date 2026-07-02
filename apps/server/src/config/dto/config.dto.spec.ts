import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { SetSettingDto } from "./set-setting.dto";
import { ResetSettingDto } from "./reset-setting.dto";

describe("SetSettingDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new SetSettingDto(), {
      key: "theme",
      value: "dark",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty key", async () => {
    const dto = Object.assign(new SetSettingDto(), { key: "", value: "v" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "key")).toBe(true);
  });

  it("rejects non-string key", async () => {
    const dto = Object.assign(new SetSettingDto(), { key: 123, value: "v" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "key")).toBe(true);
  });
});

describe("ResetSettingDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new ResetSettingDto(), { key: "theme" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty key", async () => {
    const dto = Object.assign(new ResetSettingDto(), { key: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "key")).toBe(true);
  });
});
