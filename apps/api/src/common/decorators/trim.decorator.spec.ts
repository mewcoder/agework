import { describe, it, expect } from "vitest";
import { Trim } from "./trim.decorator";
import { plainToInstance } from "class-transformer";

class TestDto {
  @Trim()
  name!: string;
}

describe("Trim decorator", () => {
  it("trims whitespace from strings", () => {
    const dto = plainToInstance(TestDto, { name: "  hello  " });
    expect(dto.name).toBe("hello");
  });

  it("passes through non-string values", () => {
    const dto = plainToInstance(TestDto, { name: 123 });
    expect(dto.name).toBe(123);
  });

  it("handles already-trimmed strings", () => {
    const dto = plainToInstance(TestDto, { name: "clean" });
    expect(dto.name).toBe("clean");
  });
});
