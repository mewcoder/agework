import { randomInt } from "crypto";

const MAX_RETRIES = 10;

interface UserFindUnique {
  findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
}

interface WorkspaceFindUnique {
  findUnique(args: { where: { id: string }; select: { id: true } }): Promise<{ id: string } | null>;
}

export async function generateUserId(
  prisma: { user: UserFindUnique },
): Promise<string> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const num = randomInt(100000, 1000000);
    const id = `user${num}`;
    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) return id;
  }
  throw new Error("Failed to generate unique user ID after retries");
}

export async function generateWorkspaceId(
  prisma: { workspace: WorkspaceFindUnique },
): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const prefix = `ws${yy}${mm}${dd}${hh}${mi}`;

  for (let i = 0; i < MAX_RETRIES; i++) {
    const suffix = String(randomInt(0, 100)).padStart(2, "0");
    const id = `${prefix}${suffix}`;
    const existing = await prisma.workspace.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) return id;
  }
  throw new Error("Failed to generate unique workspace ID after retries");
}
