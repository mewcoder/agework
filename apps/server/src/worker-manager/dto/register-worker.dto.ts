import { IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class RegisterWorkerDto {
  @IsString()
  @IsNotEmpty()
  startToken!: string;

  @IsOptional()
  @IsInt()
  pid?: number;
}
