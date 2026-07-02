import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

export class RunIdDto {
  @OptionalTrimmedString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  id!: string;
}
