import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import {
  ConfigService,
  type IsolationScope,
  type RuntimeType,
  type SandboxEngineType,
} from "../../config/config.service";

@Injectable()
export class WorkspaceRuntimePolicy {
  constructor(private readonly config: ConfigService) {}

  capabilities() {
    const allowedRuntimeTypes = this.config.getAllowedRuntimeTypes();
    const allowedIsolationScopes = this.config.getAllowedIsolationScopes();
    const runtimeType = this.config.getDefaultRuntimeType();
    const isolationScope = this.config.getDefaultIsolationScope();
    const canSelectLocalDirectory =
      allowedRuntimeTypes.includes("local") ||
      (allowedRuntimeTypes.includes("sandbox") &&
        allowedIsolationScopes.includes("workspace"));
    return {
      canSelectLocalDirectory,
      runtimeType,
      allowedRuntimeTypes,
      sandboxEngine: this.config.getSandboxEngine(),
      isolationScope,
      allowedIsolationScopes,
    };
  }

  defaultRuntimeType(): RuntimeType {
    return this.config.getDefaultRuntimeType();
  }

  resolveCreateRuntime(input: {
    runtimeType?: string;
    sandboxEngine?: string;
    isolationScope?: string;
    hasCustomRootPath: boolean;
  }): {
    runtimeType: RuntimeType;
    sandboxEngine: SandboxEngineType | null;
    isolationScope: IsolationScope | null;
  } {
    const runtimeType = this.normalizeRuntimeType(input.runtimeType);
    const sandboxEngine = this.normalizeSandboxEngine(
      runtimeType,
      input.sandboxEngine
    );
    const isolationScope = this.normalizeIsolationScope(
      runtimeType,
      input.isolationScope,
      input.hasCustomRootPath
    );
    return { runtimeType, sandboxEngine, isolationScope };
  }

  resolveStoredIsolationScope(
    isolationScope: string | null | undefined
  ): IsolationScope {
    if (isolationScope === "user" || isolationScope === "workspace") {
      return isolationScope;
    }
    if (isolationScope) {
      throw new InternalServerErrorException(
        `Workspace has invalid isolationScope: ${isolationScope}`
      );
    }
    return this.config.getDefaultIsolationScope();
  }

  supportsCustomRootPath(
    runtimeType: RuntimeType,
    isolationScope: IsolationScope | null
  ) {
    return (
      runtimeType === "local" ||
      (runtimeType === "sandbox" && isolationScope === "workspace")
    );
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

  private normalizeSandboxEngine(
    runtimeType: RuntimeType,
    sandboxEngine?: string
  ): SandboxEngineType | null {
    const value = sandboxEngine?.trim();
    if (runtimeType !== "sandbox") {
      if (value)
        throw new BadRequestException("本地工作空间不能设置 sandboxEngine");
      return null;
    }
    if (!value) return this.config.getSandboxEngine();
    if (value !== "docker" && value !== "opensandbox") {
      throw new BadRequestException(`不支持的 sandboxEngine: ${value}`);
    }
    return value;
  }

  private normalizeIsolationScope(
    runtimeType: RuntimeType,
    isolationScope: string | undefined,
    hasCustomRootPath: boolean
  ): IsolationScope | null {
    const value = isolationScope?.trim();
    if (runtimeType !== "sandbox") {
      if (value) {
        throw new BadRequestException("本地工作空间不能设置 isolationScope");
      }
      return null;
    }

    if (hasCustomRootPath && !value) {
      if (!this.config.isIsolationScopeAllowed("workspace")) {
        throw new BadRequestException(
          "当前部署不支持沙箱工作空间使用自定义本地目录"
        );
      }
      return "workspace";
    }

    const resolved = value || this.config.getDefaultIsolationScope();
    if (!this.config.isIsolationScopeAllowed(resolved)) {
      throw new BadRequestException(
        `当前部署不支持该沙箱隔离级别: ${resolved}`
      );
    }
    if (hasCustomRootPath && resolved !== "workspace") {
      throw new BadRequestException(
        "沙箱工作空间指定本地目录时必须使用工作空间级隔离"
      );
    }
    return resolved;
  }
}
