---
name: check-module
description: >
  用项目后端架构规则与命名规则合规检测某个后端 feature module,输出按优先级分级的违规清单。
  权威依据是 .claude/rules/backend-architecture.md 与 .claude/rules/backend-naming.md。
  当用户输入 "/check-module <模块名>" 或 "检测模块 xxx"、"检查 xxx 模块合规" 时使用。
  只做检测与报告,不修改代码。
---

# Check Module

拿仓库两份后端规则对一个 feature module 做合规检测,输出证据齐全、按优先级分级的违规清单。只读、不改代码;除非用户明确要求修复。

## Ground Rules

- 中文输出(规则文件本身是中文,报告用中文)。
- **权威依据只有两个文件,内容以它们为准,不要复制进本 skill**:
  - 架构边界与组织:`.claude/rules/backend-architecture.md`
  - 命名:`.claude/rules/backend-naming.md`
- 每次检测前**先读这两份规则文件**,把它们的检测项装进脑子,再看代码。规则会演进,以当前文件内容为准,不凭记忆。
- 不用外部 NestJS 通用最佳实践判违规;只对照这两份规则。
- 每条违规必须给出:违规点(具体类/方法/文件)、规则原文(直接引用规则文件里那条的措辞,标注出处 `architecture §<章节>` 或 `naming 第 N 条`)、证据(`file:line` 可点击)、修复方向。不要用自己的话改写规则,让用户能直接回原文核对。
- 找不到证据的不报;推断的标注"推断"。
- 命名检测遵循规则本身的"历史沿用"原则:历史命名不强制 rename,但要在报告中单列为"历史项",重点报新增/明显违规。架构 P0/P1 不享受历史豁免。
- 不自动 build/lint/开浏览器;只在确有必要时跑类型检查。

## Workflow

1. **读规则** — 先读两份规则文件全文,提取检测项(架构 §1 优先级 P0/P1/P2、§7 自检清单;naming 的【强制】/【推荐】/【参考】分级条目)。规则会变,这一步不能省、不能凭记忆。

2. **定位模块** — 后端模块在 `apps/api/src/<feature>/`。**用户必须指定模块名;没指定时不要自行挑模块,先问用户要测哪个**(可列出 `apps/api/src/` 下的 feature 目录供选择)。用户给了领域名后,先 `rg --files apps/api/src | rg <name>` 确认目录与边界,说明所选范围。列出 root 文件 + 各子目录文件,得到模块全貌。

3. **读代码取证**
   - 必读:`*.module.ts`(imports/providers/controllers/exports)、根 `*.service.ts`、`*.controller.ts`(含 `admin/`)、`*.repository.ts`。
   - 按需读:internal provider 子目录、`dto/`、`*.types.ts`、`*.events.ts`、Port 定义文件。
   - 跨模块依赖:看 `imports` 了哪些 module、根 Service 注入了哪些别 module 的 Service、有没有从别 module reach 内部文件。

4. **逐条对照规则检测**
   - 架构项按 P0/P1/P2 分级(沿用 architecture.md §1)。
   - 命名项按【强制】/【推荐】/【参考】分级(沿用 naming.md 体例)。
   - 用步骤 1 提取的检测项作为 checklist,逐条在代码里找证据;命中即记录,不臆测、不补全。
   - 架构 §7 自检清单是天然 checklist,逐项过一遍。
   - 只要能在规则里找到条文依据,就按该条文的级别报,不要自我降级成"设计观察";规则里没有依据的不要报(那是别的 skill 的事)。

5. **输出报告** — 写成 md 文件落盘到**项目根目录的 `reports/` 目录**,文件名 `<feature>.check.md`(如 `reports/model-provider.check.md`);同时在对话里给一句话摘要 + 文件链接。用下方 Report Template。注意:报告在 `reports/` 下,引用 `.claude/rules/*` 用 `../.claude/rules/...`,引用源码用 `apps/api/src/...`(源码链接从项目根算,不加 `../`)。

## Useful Search Patterns

```bash
# 定位模块
rg --files apps/api/src | rg '<module>'

# 架构骨架
rg -n '@(Module|Controller|Get|Post|Put|Patch|Delete)\b|@Injectable|constructor\(' apps/api/src/<module>
rg -n 'exports:\s*\[' apps/api/src/<module>      # 看 export 了什么
rg -n 'PrismaService' apps/api/src/<module>      # 业务层是否直注 Prisma

# 跨模块 reach(是否 import 别 module 的内部文件)
rg -n 'from\s+["\'].*\.\./\.\./<other-module>/' apps/api/src/<module>

# 命名
rg -n 'is[A-Z]' apps/api/src/<module>            # 布尔 is 前缀
rg -n '\b(conv|repo|condi)\b' apps/api/src/<module>
rg -n '@(Put|Patch|Delete)\(' apps/api/src/<module>   # 非 GET/POST
rg -n '/:id' apps/api/src/<module>               # path 传 ID
```

## Report Template

分级标签严格沿用两份 md 自身:架构块用 `P0`/`P1`/`P2`(architecture.md §1),命名块用 `【强制】`/`【推荐】`/`【参考】`(naming.md 体例)。每个标签前加 emoji 表明严重度:`🔴 P0` / `🟠 P1` / `🟡 P2` / `🚫 【强制】` / `💡 【推荐】` / `📖 【参考】`。每条"规则"字段直接抄规则原文措辞 + 出处,不改写。

```text
模块:<feature>  路径:apps/api/src/<feature>/
检测范围:root N 文件 + 子目录 M 文件;跨模块依赖:<list>

## 目录树
用 tree 风格列出模块结构,**列出所有文件,省略 `*.spec.ts`**,末尾标「(已省略 N 个 spec)」。例如:

<feature>/
├── <feature>.module.ts
├── <feature>.service.ts
├── <feature>.controller.ts
├── dto/
│   └── create-<feature>.dto.ts
└── <sub-capability>/
    └── <xxx>.executor.ts
(已省略 N 个 spec)

## 模块概览
- 公开面:export <根 Service>
- root 文件:<list>
- 子目录:<list>
- 跨模块:<imports 了谁 / 被谁依赖>

## 架构违规

### 🔴 P0
1. <Class.method()> — <一句话问题>。
   规则:<抄 architecture.md 原文那条>  (architecture §<章节>)
   证据:apps/api/src/<feature>/x.ts:行
   修复:<具体方向>
(无则写"无")

### 🟠 P1
... 同上

### 🟡 P2
... 同上

## 命名违规

### 🚫 【强制】
1. <符号> — <问题>。
   规则:<抄 naming.md 原文那条>  (naming 第 N 条)
   证据:file:行
   修复:...
历史项(沿用现状,不强制):<list>

### 💡 【推荐】
...

### 📖 【参考】
...

## 结论
- P0 数 / P1 数 / 命名【强制】数。
- 最该先动的 1-3 项。
```

## Quality Bar

- 每条违规可追溯到规则条目 + 代码行,不泛泛而谈"建议改进"。
- P0/P1 与命名【强制】是硬问题,必须列全;【推荐】/【参考】可只报突出的,避免噪音。
- 不混入规则之外的通用建议(性能、可读性等);那是别的 skill 的事。
- 历史命名与新增命名分开,不要把整模块历史命名刷成 P0 噪音。
