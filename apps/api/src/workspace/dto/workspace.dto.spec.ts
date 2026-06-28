import { describe, it, expect } from "vitest";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { CreateWorkspaceDto } from "./create-workspace.dto";
import { UpdateWorkspaceDto } from "./update-workspace.dto";
import { WorkspaceIdDto } from "./workspace-id.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true });

function transformBody<T extends object>(
  metatype: new () => T,
  value: object
): Promise<T> {
  return pipe.transform(value, { type: "body", metatype }) as Promise<T>;
}

describe("CreateWorkspaceDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(CreateWorkspaceDto, {
      name: "My Workspace",
      description: "desc",
      gitUrl: "https://example.com",
    });
    expect(result).toBeInstanceOf(CreateWorkspaceDto);
    expect(result.name).toBe("My Workspace");
  });

  it("accepts a payload with only the required name", async () => {
    const result = await transformBody(CreateWorkspaceDto, {
      name: "My Workspace",
    });
    expect(result.name).toBe("My Workspace");
  });

  it("accepts runtime type in create payloads", async () => {
    const result = await transformBody(CreateWorkspaceDto, {
      name: "My Workspace",
      runtimeType: "sandbox",
      isolationScope: "workspace",
      sandboxEngine: "docker",
    });
    expect(result.runtimeType).toBe("sandbox");
    expect(result.isolationScope).toBe("workspace");
    expect(result.sandboxEngine).toBe("docker");
  });

  it("rejects invalid runtime isolation scope in create payloads", async () => {
    await expect(
      transformBody(CreateWorkspaceDto, {
        name: "My Workspace",
        runtimeType: "sandbox",
        isolationScope: "project",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects invalid runtime type in create payloads", async () => {
    await expect(
      transformBody(CreateWorkspaceDto, {
        name: "My Workspace",
        runtimeType: "docker",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a payload missing the required name", async () => {
    await expect(
      transformBody(CreateWorkspaceDto, { description: "desc" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-string name", async () => {
    await expect(
      transformBody(CreateWorkspaceDto, { name: 123 })
    ).rejects.toThrow(BadRequestException);
  });
});

describe("UpdateWorkspaceDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(UpdateWorkspaceDto, {
      id: "proj-1",
      name: "Renamed",
      description: null,
    });
    expect(result.id).toBe("proj-1");
    expect(result.name).toBe("Renamed");
  });

  it("rejects a payload missing the required name", async () => {
    await expect(
      transformBody(UpdateWorkspaceDto, { id: "proj-1" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a payload missing the required id", async () => {
    await expect(
      transformBody(UpdateWorkspaceDto, { name: "Renamed" })
    ).rejects.toThrow(BadRequestException);
  });

  it("strips runtime provider overrides from update payloads", async () => {
    const result = await transformBody(UpdateWorkspaceDto, {
      id: "proj-1",
      name: "Renamed",
      runtimeType: "opensandbox",
    });
    expect(
      (result as unknown as Record<string, unknown>).runtimeType
    ).toBeUndefined();
  });
});

describe("WorkspaceIdDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(WorkspaceIdDto, { id: "proj-1" });
    expect(result.id).toBe("proj-1");
  });

  it("rejects a missing id", async () => {
    await expect(transformBody(WorkspaceIdDto, {})).rejects.toThrow(
      BadRequestException
    );
  });
});
