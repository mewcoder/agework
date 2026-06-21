import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { SystemService } from "./system.service";

@Controller("system")
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Public()
  @Get("about")
  about() {
    return this.systemService.about();
  }
}
