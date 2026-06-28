import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

export class WorkerRunParamDto {
  @OptionalTrimmedString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  runId!: string;
}
