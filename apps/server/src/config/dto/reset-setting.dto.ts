import { IsNotEmpty, IsString } from "class-validator";

export class ResetSettingDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
