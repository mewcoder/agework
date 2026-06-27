import { Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";

@Injectable()
export class PasswordHasherService {
  hash(raw: string): Promise<string> {
    return bcrypt.hash(raw, 10);
  }

  compare(raw: string, hash: string): Promise<boolean> {
    return bcrypt.compare(raw, hash);
  }
}
