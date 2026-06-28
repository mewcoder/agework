import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { ModelProviderAgentQueryDto } from "./model-provider-query.dto";

describe("ModelProviderAgentQueryDto", () => {
  it("accepts supported agent types", async () => {
    const dto = plainToInstance(ModelProviderAgentQueryDto, {
      agentType: " claude ",
    });

    expect(dto.agentType).toBe("claude");
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects unsupported agent types", async () => {
    const dto = plainToInstance(ModelProviderAgentQueryDto, {
      agentType: "unknown",
    });

    expect((await validate(dto)).map((error) => error.property)).toContain(
      "agentType"
    );
  });
});
