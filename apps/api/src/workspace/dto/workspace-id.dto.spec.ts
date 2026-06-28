import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { WorkspaceIdDto } from "./workspace-id.dto";
import { CreateWorkspaceDto } from "./create-workspace.dto";
import { UpdateWorkspaceDto } from "./update-workspace.dto";

describe("WorkspaceIdDto", () => {
  it("accepts valid id", async () => {
    const dto = Object.assign(new WorkspaceIdDto(), { id: "ws-1" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new WorkspaceIdDto(), { id: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});

describe("CreateWorkspaceDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new CreateWorkspaceDto(), { name: "my-ws" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty name", async () => {
    const dto = Object.assign(new CreateWorkspaceDto(), { name: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "name")).toBe(true);
  });
});

describe("UpdateWorkspaceDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new UpdateWorkspaceDto(), {
      id: "ws-1",
      name: "new",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new UpdateWorkspaceDto(), { id: "", name: "n" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});
