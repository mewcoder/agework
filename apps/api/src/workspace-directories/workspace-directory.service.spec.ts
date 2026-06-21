vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

import { WorkspaceDirectoryService } from "./workspace-directory.service";

describe("WorkspaceDirectoryService", () => {
  it("creates a workspace directory with the given rootPath and ready status", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "workspace-1",
      rootPath: "/tmp/workspace/admin-1/abc12345",
      status: "ready",
      source: "managed",
      metadata: "{}",
    });
    const service = new WorkspaceDirectoryService({
      workspaceDirectory: { create },
    } as never);

    const workspace = await service.create(
      "workspace-1",
      "/tmp/workspace/admin-1/abc12345"
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-1",
        rootPath: "/tmp/workspace/admin-1/abc12345",
        status: "ready",
        source: "managed",
        metadata: {},
      },
    });
    expect(workspace.id).toBe("workspace-1");
    expect(workspace.rootPath).toBe("/tmp/workspace/admin-1/abc12345");
  });
});
