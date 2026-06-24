import { generateId } from "@agework/shared";

/**
 * 生成 User 主键。统一使用 UUID v7(与全系统 id 一致)。
 *
 * 历史上用 `userNNNNNN` 短可读前缀 + 查库重试防碰撞;UUID v7 碰撞概率可忽略,
 * 不再需要查库。User.id 用作目录/文件名,UUID 较长但功能无影响。
 */
export async function generateUserId(): Promise<string> {
  return generateId();
}

/**
 * 生成 Workspace 主键。统一使用 UUID v7(与全系统 id 一致)。
 *
 * 历史上用 `wsYYMMDDHHmmNN` 短可读前缀 + 查库重试防碰撞;UUID v7 碰撞概率可忽略,
 * 不再需要查库。Workspace.id 用作目录/文件名,UUID 较长但功能无影响。
 */
export async function generateWorkspaceId(): Promise<string> {
  return generateId();
}
