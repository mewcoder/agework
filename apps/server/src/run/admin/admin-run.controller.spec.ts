import { describe, it, expect, vi } from "vitest";
import { AdminRunController } from "./admin-run.controller";
import type { RunService } from "../run.service";

function makeController() {
  const runService = {
    listForAdmin: vi.fn().mockResolvedValue({ list: [] }),
    getDetailForAdmin: vi.fn().mockResolvedValue({}),
    listEventsForAdmin: vi.fn().mockResolvedValue({ list: [] }),
    listRawEventsForAdmin: vi.fn().mockResolvedValue({ list: [] }),
  };
  return {
    controller: new AdminRunController(runService as unknown as RunService),
    runService,
  };
}

describe("AdminRunController", () => {
  describe("listAdmin()", () => {
    it("passes pagination and status filter to the run service", async () => {
      const { controller, runService } = makeController();
      await controller.listAdmin({
        status: "running",
        pageNo: 2,
        pageSize: 25,
      });
      expect(runService.listForAdmin).toHaveBeenCalledWith({
        status: "running",
        take: 25,
        skip: 25,
      });
    });

    it("uses defaults when params are omitted", async () => {
      const { controller, runService } = makeController();
      await controller.listAdmin({});
      expect(runService.listForAdmin).toHaveBeenCalledWith({
        status: undefined,
        take: 10,
        skip: 0,
      });
    });
  });

  describe("query()", () => {
    it("delegates to runService.getDetailForAdmin", async () => {
      const { controller, runService } = makeController();
      await controller.query({ id: "run-1" });
      expect(runService.getDetailForAdmin).toHaveBeenCalledWith("run-1");
    });
  });

  describe("listEvents()", () => {
    it("passes all query params to the run service", async () => {
      const { controller, runService } = makeController();
      await controller.listEvents({
        runId: "run-1",
        type: ["run.status"],
        origin: ["worker"],
        pageNo: 2,
        pageSize: 50,
      });
      expect(runService.listEventsForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          type: ["run.status"],
          origin: ["worker"],
          take: 50,
          skip: 50,
        })
      );
    });

    it("forwards the multi-value type filter", async () => {
      const { controller, runService } = makeController();
      await controller.listEvents({
        runId: "run-1",
        type: ["run.status", "command.trace"],
      });
      expect(runService.listEventsForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ["run.status", "command.trace"],
        })
      );
    });
  });

  describe("listRawEvents()", () => {
    it("passes runId, channel and pagination to the run service", async () => {
      const { controller, runService } = makeController();
      await controller.listRawEvents({
        runId: "run-1",
        channel: ["sdk.raw"],
        pageNo: 2,
        pageSize: 50,
      });
      expect(runService.listRawEventsForAdmin).toHaveBeenCalledWith({
        runId: "run-1",
        channel: ["sdk.raw"],
        take: 50,
        skip: 50,
      });
    });

    it("uses defaults when channel and pagination are omitted", async () => {
      const { controller, runService } = makeController();
      await controller.listRawEvents({ runId: "run-1" });
      expect(runService.listRawEventsForAdmin).toHaveBeenCalledWith({
        runId: "run-1",
        channel: undefined,
        take: 100,
        skip: 0,
      });
    });
  });
});
