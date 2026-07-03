import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import {
  METHOD_METADATA,
  PATH_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { describe, expect, it } from "vitest";
import { AuthController } from "../auth/auth.controller";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RAW_RESPONSE_KEY } from "./decorators/raw-response.decorator";
import { AdminConfigController } from "../config/admin/admin-config.controller";
import { ConversationController } from "../conversation/conversation.controller";
import { AgentController } from "../agent/agent.controller";
import { AdminModelProviderController } from "../model-provider/admin/admin-model-provider.controller";
import { ModelProviderController } from "../model-provider/model-provider.controller";
import { AdminRunController } from "../run/admin/admin-run.controller";
import { AdminRuntimeController } from "../worker-manager/admin/admin-runtime.controller";
import { SystemController } from "../system/system.controller";
import { AdminUserController } from "../user/admin/admin-user.controller";
import { WorkerCommandController } from "../worker-manager/command.controller";
import { WorkerRunController } from "../worker-manager/worker-run.controller";
import { AdminWorkspaceController } from "../workspace/admin/admin-workspace.controller";
import { WorkspaceController } from "../workspace/workspace.controller";

type ControllerClass = abstract new (...args: never[]) => unknown;
type RouteMethod = "get" | "post";

const METHOD_BY_NAME: Record<RouteMethod, RequestMethod> = {
  get: RequestMethod.GET,
  post: RequestMethod.POST,
};

const METHOD_NAME_BY_VALUE: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
};

const CONTROLLERS = [
  AuthController,
  AdminConfigController,
  ConversationController,
  AgentController,
  AdminModelProviderController,
  ModelProviderController,
  AdminRunController,
  AdminRuntimeController,
  SystemController,
  AdminUserController,
  WorkerCommandController,
  WorkerRunController,
  AdminWorkspaceController,
  WorkspaceController,
] as const satisfies readonly ControllerClass[];

const PUBLIC_ROUTE_ALLOWLIST = new Set([
  "POST auth/login",
  "POST auth/register",
  "POST auth/setup",
  "POST auth/refresh",
  "POST auth/logout",
  "GET auth/config",
  "GET system/about",
]);

const RAW_RESPONSE_ALLOWLIST = ["worker/owners/*", "worker/runs/*"];

const RAW_RES_ROUTE_ALLOWLIST = [
  "POST conversations/agent/run",
  "GET conversations/agent/resume",
];

const PASSTHROUGH_RES_ROUTE_ALLOWLIST = [
  "POST auth/login",
  "POST auth/setup",
  "POST auth/refresh",
  "POST auth/logout",
  "POST auth/update-password",
];

function controllerPath(controller: ControllerClass) {
  return Reflect.getMetadata(PATH_METADATA, controller);
}

function routeHandler(controller: ControllerClass, methodName: string) {
  const prototype = controller.prototype as Record<string, unknown>;
  const handler = prototype[methodName];
  if (typeof handler !== "function") {
    throw new Error(`${controller.name}.${methodName} is not a route handler`);
  }
  return handler;
}

function route(
  controller: ControllerClass,
  methodName: string
): { path: string; method: RequestMethod } {
  const handler = routeHandler(controller, methodName);
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler),
  };
}

function routeMethods(controller: ControllerClass) {
  return Object.getOwnPropertyNames(controller.prototype).filter(
    (methodName) => {
      if (methodName === "constructor") return false;
      const handler = routeHandler(controller, methodName);
      return handler && Reflect.hasMetadata(PATH_METADATA, handler);
    }
  );
}

function expectRoute(
  controller: ControllerClass,
  methodName: string,
  method: RouteMethod,
  path: string
) {
  expect(route(controller, methodName)).toEqual({
    method: METHOD_BY_NAME[method],
    path,
  });
}

function rolesFor(controller: ControllerClass): string[] {
  return Reflect.getMetadata(ROLES_KEY, controller) ?? [];
}

function isPublic(target: object) {
  return Reflect.getMetadata(IS_PUBLIC_KEY, target) === true;
}

function isRawResponse(target: object) {
  return Reflect.getMetadata(RAW_RESPONSE_KEY, target) === true;
}

function routeArgs(controller: ControllerClass, methodName: string) {
  return Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName) as
    | Record<string, unknown>
    | undefined;
}

function hasResponseParam(controller: ControllerClass, methodName: string) {
  const args = routeArgs(controller, methodName);
  if (!args) return false;
  return Object.keys(args).some((key) =>
    key.startsWith(`${RouteParamtypes.RESPONSE}:`)
  );
}

function hasPassthroughResponse(
  controller: ControllerClass,
  methodName: string
) {
  return (
    Reflect.getMetadata(
      RESPONSE_PASSTHROUGH_METADATA,
      controller,
      methodName
    ) === true
  );
}

function routeLabel(controller: ControllerClass, methodName: string) {
  const controllerBasePath = controllerPath(controller);
  const metadata = route(controller, methodName);
  const method = METHOD_NAME_BY_VALUE[metadata.method] ?? metadata.method;
  return `${method} ${controllerBasePath}/${metadata.path}`;
}

describe("external API route convention", () => {
  it("uses RPC action paths for conversations", () => {
    expect(controllerPath(ConversationController)).toBe("conversations");
    expectRoute(ConversationController, "list", "get", "list");
    expectRoute(ConversationController, "findById", "get", "query");
    expectRoute(
      ConversationController,
      "queryStatuses",
      "post",
      "statuses/query"
    );
    expectRoute(ConversationController, "update", "post", "update");
    expectRoute(ConversationController, "archive", "post", "archive");
    expectRoute(ConversationController, "unarchive", "post", "unarchive");
    expectRoute(ConversationController, "remove", "post", "remove");
    expectRoute(ConversationController, "listMessages", "get", "messages/list");
  });

  it("uses RPC action paths for workspaces", () => {
    expect(controllerPath(WorkspaceController)).toBe("workspaces");
    expectRoute(WorkspaceController, "list", "get", "list");
    expectRoute(WorkspaceController, "capabilities", "get", "capabilities");
    expectRoute(WorkspaceController, "create", "post", "create");
    expectRoute(WorkspaceController, "update", "post", "update");
    expectRoute(WorkspaceController, "remove", "post", "remove");
  });

  it("uses the admin prefix for user management", () => {
    expect(controllerPath(AdminUserController)).toBe("admin/users");
    expectRoute(AdminUserController, "list", "get", "list");
    expectRoute(AdminUserController, "create", "post", "create");
    expectRoute(AdminUserController, "approve", "post", "approve");
    expectRoute(AdminUserController, "update", "post", "update");
    expectRoute(
      AdminUserController,
      "updatePassword",
      "post",
      "update-password"
    );
    expectRoute(AdminUserController, "remove", "post", "remove");
  });

  it("uses ping/remove and admin split for model providers", () => {
    expect(controllerPath(ModelProviderController)).toBe("model-providers");
    expectRoute(ModelProviderController, "list", "get", "list");
    expectRoute(ModelProviderController, "systemInfo", "get", "system-info");
    expectRoute(ModelProviderController, "ping", "post", "ping");

    expect(controllerPath(AdminModelProviderController)).toBe(
      "admin/model-providers"
    );
    expectRoute(AdminModelProviderController, "list", "get", "list");
    expectRoute(AdminModelProviderController, "create", "post", "create");
    expectRoute(AdminModelProviderController, "update", "post", "update");
    expectRoute(
      AdminModelProviderController,
      "setEnabled",
      "post",
      "set-enabled"
    );
    expectRoute(AdminModelProviderController, "remove", "post", "remove");
    expectRoute(AdminModelProviderController, "ping", "post", "ping");
  });

  it("uses query/update-password for auth", () => {
    expect(controllerPath(AuthController)).toBe("auth");
    expectRoute(AuthController, "login", "post", "login");
    expectRoute(AuthController, "register", "post", "register");
    expectRoute(AuthController, "setup", "post", "setup");
    expectRoute(AuthController, "me", "get", "query");
    expectRoute(AuthController, "updatePassword", "post", "update-password");
    expectRoute(AuthController, "config", "get", "config");
  });

  it("uses body ids instead of path ids for agent controls", () => {
    expect(controllerPath(AgentController)).toBe("conversations");
    expectRoute(AgentController, "create", "post", "create");
    expectRoute(AgentController, "agentOptions", "get", "agent/options");
    expectRoute(AgentController, "runAgent", "post", "agent/run");
    expectRoute(AgentController, "resumeAgent", "get", "agent/resume");
    expectRoute(AgentController, "replyAgent", "post", "agent/reply");
    expectRoute(AgentController, "stopAgent", "post", "agent/stop");
  });

  it("keeps admin routes under the admin prefix", () => {
    expect(controllerPath(AdminConfigController)).toBe("admin/config");
    expectRoute(AdminConfigController, "list", "get", "list");
    expectRoute(AdminConfigController, "set", "post", "set");
    expectRoute(AdminConfigController, "reset", "post", "reset");

    expect(controllerPath(AdminRunController)).toBe("admin/runs");
    expectRoute(AdminRunController, "listAdmin", "get", "list");
    expectRoute(AdminRunController, "query", "get", "query");
    expectRoute(AdminRunController, "listEvents", "get", "events/list");

    expect(controllerPath(AdminRuntimeController)).toBe("admin/runtime");
    expectRoute(AdminRuntimeController, "getRuntimePolicy", "get", "policy");
    expectRoute(AdminRuntimeController, "getRuntimeStats", "get", "stats");
    expectRoute(AdminRuntimeController, "listResources", "get", "resources");
    expectRoute(
      AdminRuntimeController,
      "stopResource",
      "post",
      "resources/stop"
    );

    expect(controllerPath(AdminWorkspaceController)).toBe("admin/workspaces");
    expectRoute(AdminWorkspaceController, "listAll", "get", "list");
    expectRoute(AdminWorkspaceController, "update", "post", "update");
  });

  it("requires admin role metadata for every admin controller", () => {
    const adminControllers = CONTROLLERS.filter((controller) =>
      controllerPath(controller).startsWith("admin/")
    );

    expect(adminControllers.map(controllerPath)).toEqual(
      expect.arrayContaining([
        "admin/config",
        "admin/model-providers",
        "admin/runs",
        "admin/runtime",
        "admin/users",
        "admin/workspaces",
      ])
    );
    expect(
      adminControllers
        .filter((controller) => !rolesFor(controller).includes("admin"))
        .map(controllerPath)
    ).toEqual([]);
  });

  it("keeps worker callbacks public", () => {
    const workerControllers = CONTROLLERS.filter((controller) =>
      controllerPath(controller).startsWith("worker/")
    );

    expect(workerControllers.map(controllerPath)).toEqual([
      "worker/owners",
      "worker/runs",
    ]);
    expect(
      workerControllers
        .filter((controller) => !isPublic(controller))
        .map(controllerPath)
    ).toEqual([]);
  });

  it("does not mark non-worker controllers public at class level", () => {
    expect(
      CONTROLLERS.filter(
        (controller) =>
          !controllerPath(controller).startsWith("worker/") &&
          isPublic(controller)
      ).map(controllerPath)
    ).toEqual([]);
  });

  it("allows @Public only on explicit public route allowlist", () => {
    const publicRoutes = CONTROLLERS.flatMap((controller) =>
      routeMethods(controller)
        .filter((methodName) => {
          const handler = routeHandler(controller, methodName);
          return isPublic(handler);
        })
        .map((methodName) => routeLabel(controller, methodName))
    );

    expect(publicRoutes).toEqual([...PUBLIC_ROUTE_ALLOWLIST]);
  });

  it("allows @RawResponse only on worker internal controllers", () => {
    const rawResponseTargets = CONTROLLERS.flatMap((controller) => [
      ...(isRawResponse(controller) ? [`${controllerPath(controller)}/*`] : []),
      ...routeMethods(controller)
        .filter((methodName) =>
          isRawResponse(routeHandler(controller, methodName))
        )
        .map((methodName) => routeLabel(controller, methodName)),
    ]);

    expect(rawResponseTargets).toEqual(RAW_RESPONSE_ALLOWLIST);
  });

  it("allows raw @Res only on agent stream routes", () => {
    const rawResponseRoutes = CONTROLLERS.flatMap((controller) =>
      routeMethods(controller)
        .filter(
          (methodName) =>
            hasResponseParam(controller, methodName) &&
            !hasPassthroughResponse(controller, methodName)
        )
        .map((methodName) => routeLabel(controller, methodName))
    );

    expect(rawResponseRoutes).toEqual(RAW_RES_ROUTE_ALLOWLIST);
  });

  it("keeps cookie-writing @Res usage in passthrough mode", () => {
    const passthroughResponseRoutes = CONTROLLERS.flatMap((controller) =>
      routeMethods(controller)
        .filter(
          (methodName) =>
            hasResponseParam(controller, methodName) &&
            hasPassthroughResponse(controller, methodName)
        )
        .map((methodName) => routeLabel(controller, methodName))
    );

    expect(passthroughResponseRoutes).toEqual(PASSTHROUGH_RES_ROUTE_ALLOWLIST);
  });
});
