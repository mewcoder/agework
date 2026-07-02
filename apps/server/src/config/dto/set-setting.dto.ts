import { IsNotEmpty, IsString } from "class-validator";

export class SetSettingDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  value!: string;
}
