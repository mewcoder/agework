import { describe, it, expect } from "vitest";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { CreateModelProviderDto } from "./create-model-provider.dto";
import { UpdateModelProviderDto } from "./update-model-provider.dto";
import { ModelProviderIdDto } from "./model-provider-id.dto";
import { SetModelProviderEnabledDto } from "./set-model-provider-enabled.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true });

function transformBody<T extends object>(
  metatype: new () => T,
  value: object
): Promise<T> {
  return pipe.transform(value, { type: "body", metatype }) as Promise<T>;
}

describe("CreateModelProviderDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(CreateModelProviderDto, {
      agentType: "claude",
      name: "My Config",
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-xxx",
        models: ["claude-test"],
        extraConfig: {},
      },
    });
    expect(result).toBeInstanceOf(CreateModelProviderDto);
    expect(result.providerConfig).toEqual({
      baseUrl: "https://example.com",
      apiKey: "sk-xxx",
      models: ["claude-test"],
      extraConfig: {},
    });
  });

  it("rejects a payload missing required fields", async () => {
    await expect(
      transformBody(CreateModelProviderDto, { agentType: "claude" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unsupported agentType", async () => {
    await expect(
      transformBody(CreateModelProviderDto, {
        agentType: "unknown",
        name: "My Config",
        providerConfig: {
          baseUrl: "https://example.com",
          apiKey: "sk-xxx",
          models: ["model"],
          extraConfig: {},
        },
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a providerConfig with non-string values", async () => {
    await expect(
      transformBody(CreateModelProviderDto, {
        agentType: "claude",
        name: "My Config",
        providerConfig: {
          baseUrl: "https://example.com",
          apiKey: "sk-xxx",
          models: ["claude-test"],
          extraConfig: { FOO: 123 },
        },
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-object providerConfig", async () => {
    await expect(
      transformBody(CreateModelProviderDto, {
        agentType: "claude",
        name: "My Config",
        providerConfig: "not-an-object",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a providerConfig with empty models array", async () => {
    await expect(
      transformBody(CreateModelProviderDto, {
        agentType: "claude",
        name: "My Config",
        providerConfig: {
          baseUrl: "https://example.com",
          apiKey: "sk-xxx",
          models: [],
          extraConfig: {},
        },
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a providerConfig missing baseUrl/apiKey", async () => {
    await expect(
      transformBody(CreateModelProviderDto, {
        agentType: "claude",
        name: "My Config",
        providerConfig: { models: ["claude-test"], extraConfig: {} },
      })
    ).rejects.toThrow(BadRequestException);
  });
});

describe("UpdateModelProviderDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(UpdateModelProviderDto, {
      id: "mc-1",
      name: "Renamed",
      providerConfig: {
        baseUrl: "https://example.com",
        apiKey: "sk-xxx",
        models: ["m"],
        extraConfig: {},
      },
    });
    expect(result.id).toBe("mc-1");
  });

  it("rejects a payload missing id", async () => {
    await expect(
      transformBody(UpdateModelProviderDto, {
        name: "Renamed",
        providerConfig: {
          baseUrl: "https://example.com",
          apiKey: "sk-xxx",
          models: ["m"],
          extraConfig: {},
        },
      })
    ).rejects.toThrow(BadRequestException);
  });
});

describe("ModelProviderIdDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(ModelProviderIdDto, {
      id: "mc-1",
    });
    expect(result.id).toBe("mc-1");
  });

  it("rejects a missing id", async () => {
    await expect(transformBody(ModelProviderIdDto, {})).rejects.toThrow(
      BadRequestException
    );
  });
});

describe("SetModelProviderEnabledDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(SetModelProviderEnabledDto, {
      id: "mc-1",
      isEnabled: true,
    });
    expect(result.isEnabled).toBe(true);
  });

  it("rejects a non-boolean isEnabled", async () => {
    await expect(
      transformBody(SetModelProviderEnabledDto, {
        id: "mc-1",
        isEnabled: "true",
      })
    ).rejects.toThrow(BadRequestException);
  });
});
