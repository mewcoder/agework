import { Injectable } from "@nestjs/common";
import { ContainerRuntimeProvider } from "./container-runtime.provider";
import { ConfigService } from "../../config/config.service";
import { DockerSandboxEngine } from "./docker-engine";

@Injectable()
export class DockerRuntimeProvider extends ContainerRuntimeProvider {
  readonly type = "docker";
  constructor(configService: ConfigService, engine: DockerSandboxEngine) {
    super(configService, engine);
  }
}
