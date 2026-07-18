import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import type { RuntimeType } from "@agework/runtime-sdk";
import type { WorkerScope } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";

@Injectable()
export class WorkspaceRuntimePolicy {
  constructor(private readonly config: ConfigService) {}

  capabilities() {
    const allowedRuntimeTypes = this.config.getAllowedRuntimeTypes();
    const allowedScopes = this.config.getAllowedScopes();
    const defaultRuntimeType = this.config.getDefaultRuntimeType();
    const defaultScope = this.config.getDefaultWorkerScope();
    const canSelectLocalDirectory =
      allowedRuntimeTypes.includes("native") ||
      (allowedRuntimeTypes.some((type) => type !== "native") &&
        allowedScopes.includes("workspace"));
    return {
      canSelectLocalDirectory,
      defaultRuntimeType,
      allowedRuntimeTypes,
      defaultScope,
      allowedScopes,
    };
  }

  defaultRuntimeType(): RuntimeType {
    return this.config.getDefaultRuntimeType();
  }

  resolveCreateRuntime(input: {
    runtimeType?: string;
    scope?: string;
    hasCustomRootPath: boolean;
  }): {
    runtimeType: RuntimeType;
    scope: WorkerScope;
  } {
    const runtimeType = this.normalizeRuntimeType(input.runtimeType);
    const scope = this.normalizeWorkerScope(
      runtimeType,
      input.scope,
      input.hasCustomRootPath
    );
    return { runtimeType, scope };
  }

  resolveStoredWorkerScope(scope: string): WorkerScope {
    if (scope === "user" || scope === "workspace") {
      return scope;
    }
    throw new InternalServerErrorException(
      `Workspace has invalid scope: ${scope}`
    );
  }

  supportsCustomRootPath(runtimeType: RuntimeType, scope: WorkerScope) {
    return runtimeType === "native" || scope === "workspace";
  }

  private normalizeRuntimeType(runtimeType?: string): RuntimeType {
    const value = runtimeType?.trim() || this.config.getDefaultRuntimeType();
    if (!this.config.isRuntimeTypeAllowed(value)) {
      throw new BadRequestException(
        `当前部署不支持该工作空间运行环境: ${value}`
      );
    }
    return value;
  }

  private normalizeWorkerScope(
    runtimeType: RuntimeType,
    scope: string | undefined,
    hasCustomRootPath: boolean
  ): WorkerScope {
    const value = scope?.trim();
    if (runtimeType === "native") {
      if (value && value !== "workspace") {
        throw new BadRequestException("native 运行方式只支持 workspace 范围");
      }
      return "workspace";
    }

    if (hasCustomRootPath && !value) {
      if (!this.config.isWorkerScopeAllowed("workspace")) {
        throw new BadRequestException(
          "当前部署不支持沙箱工作空间使用自定义本地目录"
        );
      }
      return "workspace";
    }

    const resolved = value || this.config.getDefaultWorkerScope();
    if (!this.config.isWorkerScopeAllowed(resolved)) {
      throw new BadRequestException(
        `当前部署不支持该沙箱运行范围: ${resolved}`
      );
    }
    if (hasCustomRootPath && resolved !== "workspace") {
      throw new BadRequestException(
        "沙箱工作空间指定本地目录时必须使用工作空间范围"
      );
    }
    return resolved;
  }
}
