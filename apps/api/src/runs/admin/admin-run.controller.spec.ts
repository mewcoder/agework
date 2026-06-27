import { describe, it, expect, vi } from "vitest";
import { AdminRunController, parseMulti } from "./admin-run.controller";
import type { RunRepository } from "../run.repository";
import type { RunEventQuery } from "../../run-events/run-event.query";

function makeController() {
  const runRepository = {
    listAdmin: vi.fn().mockResolvedValue({ list: [] }),
    detailAdmin: vi.fn().mockResolvedValue({}),
  };
  const runEventQueryService = {
    listAdminEvents: vi.fn().mockResolvedValue({ list: [] }),
  };
  return {
    controller: new AdminRunController(
      runRepository as unknown as RunRepository,
      runEventQueryService as unknown as RunEventQuery
    ),
    runRepository,
    runEventQueryService,
  };
}

describe("AdminRunController", () => {
  describe("listAdmin()", () => {
    it("passes pagination and status filter", async () => {
      const { controller, runRepository } = makeController();
      await controller.listAdmin("running", "2", "25");
      expect(runRepository.listAdmin).toHaveBeenCalledWith({
        status: "running",
        take: 25,
        skip: 25,
      });
    });

    it("uses defaults when params are omitted", async () => {
      const { controller, runRepository } = makeController();
      await controller.listAdmin();
      expect(runRepository.listAdmin).toHaveBeenCalledWith({
        status: undefined,
        take: 10,
        skip: 0,
      });
    });
  });

  describe("query()", () => {
    it("delegates to runRepository.detailAdmin", async () => {
      const { controller, runRepository } = makeController();
      await controller.query("run-1");
      expect(runRepository.detailAdmin).toHaveBeenCalledWith("run-1");
    });
  });

  describe("listEvents()", () => {
    it("passes all query params to runEventQueryService", async () => {
      const { controller, runEventQueryService } = makeController();
      await controller.listEvents(
        "run-1",
        "run.status",
        undefined,
        "worker",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "2",
        "50"
      );
      expect(runEventQueryService.listAdminEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          type: ["run.status"],
          origin: ["worker"],
          take: 50,
          skip: 50,
        })
      );
    });

    it("parses comma-separated type filter", async () => {
      const { controller, runEventQueryService } = makeController();
      await controller.listEvents("run-1", "run.status,command.trace");
      expect(runEventQueryService.listAdminEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ["run.status", "command.trace"],
        })
      );
    });
  });
});

describe("parseMulti", () => {
  it("returns undefined for falsy input", () => {
    expect(parseMulti(undefined)).toBeUndefined();
  });

  it("splits comma-separated string", () => {
    expect(parseMulti("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("handles array input", () => {
    expect(parseMulti(["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns undefined for empty items", () => {
    expect(parseMulti(",,")).toBeUndefined();
  });
});
