import { Injectable } from "@nestjs/common";
import { ContainerRuntimeProvider } from "./container-runtime.provider";
import { ConfigService } from "../../config/config.service";
import { OpenSandboxEngine } from "./opensandbox-engine";

@Injectable()
export class OpenSandboxRuntimeProvider extends ContainerRuntimeProvider {
  readonly type = "opensandbox";
  constructor(configService: ConfigService, engine: OpenSandboxEngine) {
    super(configService, engine);
  }
}
