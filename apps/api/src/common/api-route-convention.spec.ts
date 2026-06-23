import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { AgentController } from "../conversations/agent/agent.controller";
import { AuthController } from "../auth/auth.controller";
import { AdminConfigController } from "../config/admin/admin-config.controller";
import { ConversationController } from "../conversations/conversation.controller";
import { AdminModelProviderController } from "../model-providers/admin/admin-model-provider.controller";
import { ModelProviderController } from "../model-providers/model-provider.controller";
import { AdminRunController } from "../runtime/admin/admin-run.controller";
import { AdminRuntimeController } from "../runtime/admin/admin-runtime.controller";
import { AdminUserController } from "../users/admin/admin-user.controller";
import { AdminWorkspaceController } from "../workspaces/admin/admin-workspace.controller";
import { WorkspaceController } from "../workspaces/workspace.controller";

type ControllerClass = abstract new (...args: never[]) => unknown;
type RouteMethod = "get" | "post";

const METHOD_BY_NAME: Record<RouteMethod, RequestMethod> = {
  get: RequestMethod.GET,
  post: RequestMethod.POST,
};

function controllerPath(controller: ControllerClass) {
  return Reflect.getMetadata(PATH_METADATA, controller);
}

function route(
  controller: ControllerClass,
  methodName: string
): { path: string; method: RequestMethod } {
  const handler = controller.prototype[methodName] as (...args: never[]) => unknown;
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler),
  };
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

describe("external API route convention", () => {
  it("uses RPC action paths for conversations", () => {
    expect(controllerPath(ConversationController)).toBe("conversations");
    expectRoute(ConversationController, "list", "get", "list");
    expectRoute(ConversationController, "create", "post", "create");
    expectRoute(ConversationController, "findOne", "get", "query");
    expectRoute(ConversationController, "queryStatuses", "post", "statuses/query");
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
    expectRoute(AdminUserController, "updatePassword", "post", "update-password");
    expectRoute(AdminUserController, "remove", "post", "remove");
  });

  it("uses ping/remove and admin split for model providers", () => {
    expect(controllerPath(ModelProviderController)).toBe("model-providers");
    expectRoute(ModelProviderController, "list", "get", "list");
    expectRoute(ModelProviderController, "systemInfo", "get", "system-info");
    expectRoute(ModelProviderController, "ping", "post", "ping");

    expect(controllerPath(AdminModelProviderController)).toBe("admin/model-providers");
    expectRoute(AdminModelProviderController, "list", "get", "list");
    expectRoute(AdminModelProviderController, "create", "post", "create");
    expectRoute(AdminModelProviderController, "update", "post", "update");
    expectRoute(AdminModelProviderController, "setEnabled", "post", "set-enabled");
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
    expect(controllerPath(AgentController)).toBe("conversations/agent");
    expectRoute(AgentController, "permissionOptions", "get", "permission-options");
    expectRoute(AgentController, "run", "post", "run");
    expectRoute(AgentController, "resumeStream", "get", "resume");
    expectRoute(AgentController, "answerQuestion", "post", "reply");
    expectRoute(AgentController, "stop", "post", "stop");
  });

  it("keeps admin routes under the admin prefix", () => {
    expect(controllerPath(AdminConfigController)).toBe("admin/config");
    expectRoute(AdminConfigController, "list", "get", "list");
    expectRoute(AdminConfigController, "set", "post", "set");
    expectRoute(AdminConfigController, "reset", "post", "reset");

    expect(controllerPath(AdminRunController)).toBe("admin/runs");
    expectRoute(AdminRunController, "listAdmin", "get", "list");
    expectRoute(AdminRunController, "query", "get", "query");

    expect(controllerPath(AdminRuntimeController)).toBe("admin/runtime");
    expectRoute(AdminRuntimeController, "getRuntimePolicy", "get", "policy");
    expectRoute(AdminRuntimeController, "getRuntimeStats", "get", "stats");
    expectRoute(AdminRuntimeController, "listResources", "get", "resources");
    expectRoute(AdminRuntimeController, "stopResource", "post", "resources/stop");

    expect(controllerPath(AdminWorkspaceController)).toBe("admin/workspaces");
    expectRoute(AdminWorkspaceController, "listAll", "get", "all");
    expectRoute(AdminWorkspaceController, "update", "post", "update");
  });
});
