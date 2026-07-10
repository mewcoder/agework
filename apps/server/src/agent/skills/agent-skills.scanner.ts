import { Injectable, Logger } from "@nestjs/common";
import matter from "gray-matter";
import { join } from "node:path";
import { AGENT_DIR_PREFIX, isAgentType, type AgentType } from "@agework/shared";
import type { SlashCommandItem } from "@agework/shared/api";
import { WorkspaceService } from "../../workspace/workspace.service";
import { RuntimeService } from "../../runtime/runtime.service";

/**
 * 扫描工作空间目录下的 skill SKILL.md 文件，解析 frontmatter 得到
 * SlashCommandItem 列表。不经过 agent，不需要 run。
 *
 * 路径：{AGENT_DIR_PREFIX[agentType]}/skills/<skill-name>/SKILL.md
 * managed native 直读本机硬盘；docker/registered 经隧道 RPC。
 */
@Injectable()
export class AgentSkillsScanner {
  private readonly logger = new Logger(AgentSkillsScanner.name);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly runtimeService: RuntimeService,
  ) {}

  async scan(
    userId: string,
    workspaceId: string,
    agentType: string,
  ): Promise<SlashCommandItem[]> {
    if (!isAgentType(agentType)) return [];
    if (agentType !== "claude") return [];

    const owned = await this.workspaceService.getOwnedId(userId, workspaceId);
    if (!owned) return [];

    const ctx = await this.workspaceService.getRunContext(workspaceId);
    const skillsDir = join(AGENT_DIR_PREFIX[agentType as AgentType], "skills");

    let dirEntries: { name: string; type: string }[];
    try {
      const result = await this.runtimeService.listFiles(
        ctx.runtimeId,
        ctx.workspaceRootPath,
        skillsDir,
      );
      dirEntries = result.list;
    } catch {
      // 目录不存在或 runtime 不可达 → 返回空
      return [];
    }

    const dirNames = dirEntries
      .filter((e) => e.type === "directory")
      .map((e) => e.name);

    const items: SlashCommandItem[] = [];

    await Promise.all(
      dirNames.map(async (dirName) => {
        try {
          const filePath = join(skillsDir, dirName, "SKILL.md");
          const result = await this.runtimeService.readFile(
            ctx.runtimeId,
            ctx.workspaceRootPath,
            filePath,
          );

          if (result.encoding !== "utf8") return;

          const parsed = matter(result.content);
          const name = parsed.data?.name;
          if (typeof name !== "string" || !name.trim()) {
            this.logger.warn(
              `Skill "${dirName}" has invalid frontmatter (missing or empty name), skipping`,
            );
            return;
          }

          const description =
            typeof parsed.data?.description === "string"
              ? parsed.data.description
              : undefined;

          items.push({ name, description });
        } catch (err) {
          this.logger.warn(
            `Failed to read skill "${dirName}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    return items;
  }
}
