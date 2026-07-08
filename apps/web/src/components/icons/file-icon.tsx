import type { ReactElement } from "react";
import {
  Bot,
  BookOpen,
  Database,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileText,
  GitBranch,
  Presentation,
  Scale,
  Sheet,
  Terminal,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 文件类型图标组件。
 *
 * 设计参考 Codex 桌面端的实现（自研、非外部库）：
 *   - 精确文件名表 (EXACT) 与扩展名表 (EXT) 两层映射
 *   - 品牌级图标手写内联 SVG（docker / npm / pnpm / yarn / prettier / turbo ...）
 *   - 通用类型用 lucide 图标兜底
 *   - 每个品牌图标带专属配色
 */

type IconName =
  // 品牌
  | "docker"
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "prettier"
  | "turbo"
  | "eslint"
  | "babel"
  | "biome"
  | "claude"
  | "agents"
  | "git"
  | "readme"
  | "license"
  | "makefile"
  | "env"
  | "editorconfig"
  | "tsconfig"
  // 通用类别
  | "typescript"
  | "javascript"
  | "react"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "kotlin"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "json"
  | "yaml"
  | "toml"
  | "html"
  | "css"
  | "xml"
  | "code"
  | "markdown"
  | "text"
  | "word"
  | "csv"
  | "excel"
  | "pdf"
  | "image"
  | "archive"
  | "database"
  | "sql"
  | "shell"
  | "presentation"
  | "lock"
  | "default";

type IconProps = { size?: number; className?: string };
type IconComponent = (props: IconProps) => ReactElement;

/* ----------------------------- 精确文件名表 ----------------------------- */
// 大小写不敏感匹配（lower 后查表）
const EXACT: Record<string, IconName> = {
  // git
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  // docker
  ".dockerignore": "docker",
  dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  // npm
  ".npmrc": "npm",
  ".npmignore": "npm",
  "package.json": "npm",
  "package-lock.json": "npm",
  // pnpm
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  // yarn
  "yarn.lock": "yarn",
  // bun
  "bun.lock": "bun",
  "bun.lockb": "bun",
  // prettier
  ".prettierrc": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.mjs": "prettier",
  ".prettierrc.toml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".prettierignore": "prettier",
  // tsconfig
  "tsconfig.json": "tsconfig",
  // eslint
  ".eslintrc": "eslint",
  ".eslintrc.js": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.cjs": "eslint",
  ".eslintrc.yaml": "eslint",
  ".eslintrc.yml": "eslint",
  ".eslintignore": "eslint",
  // babel
  ".babelrc": "babel",
  "babel.config.js": "babel",
  "babel.config.json": "babel",
  // biome
  "biome.json": "biome",
  "biome.jsonc": "biome",
  // turbo
  "turbo.json": "turbo",
  // claude / agents
  ".claude": "claude",
  "claude.md": "claude",
  ".agents": "agents",
  "agents.md": "agents",
  // readme / license
  readme: "readme",
  "readme.md": "readme",
  license: "license",
  "license.md": "license",
  // makefile / env / editorconfig
  makefile: "makefile",
  "makefile.am": "makefile",
  ".env": "env",
  ".env.example": "env",
  ".env.local": "env",
  ".editorconfig": "editorconfig",
  // rust / go / python
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "go.mod": "go",
  "go.sum": "go",
  "requirements.txt": "python",
  "pyproject.toml": "python",
};

/* ----------------------------- 扩展名表 ----------------------------- */
const EXT: Record<string, IconName> = {
  ts: "typescript",
  tsx: "react",
  js: "javascript",
  jsx: "react",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "code",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "text",
  log: "text",
  csv: "csv",
  tsv: "csv",
  xls: "excel",
  xlsx: "excel",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  rar: "archive",
  "7z": "archive",
  sql: "database",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ppt: "presentation",
  pptx: "presentation",
  doc: "word",
  docx: "word",
  lock: "lock",
};

function resolve(name: string): IconName {
  const lower = name.toLowerCase();
  if (EXACT[lower]) return EXACT[lower];
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (ext && EXT[ext]) return EXT[ext];
  return "default";
}

/* ----------------------------- 品牌内联 SVG ----------------------------- */
function Svg({
  size = 14,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const DockerIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <g fill="#2496ED">
      <rect x="3.5" y="11" width="2.6" height="2.6" rx="0.3" />
      <rect x="6.6" y="11" width="2.6" height="2.6" rx="0.3" />
      <rect x="9.7" y="11" width="2.6" height="2.6" rx="0.3" />
      <path d="M2.5 14.2h16.2c1.6 0 2.8 1.1 2.8 2.6 0 .5-.1.9-.4 1.3-.3 2.1-2.1 3.9-4.7 3.9h-2.1l-.9 1.6-.7-1.6H9.3c-2.6 0-4.4-1.8-4.7-3.9-.3-.4-.4-.8-.4-1.3 0-.3 0-.6.1-.9z" />
    </g>
  </Svg>
);

const NpmIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <rect x="2" y="6.5" width="20" height="11" rx="2" fill="#CB3837" />
    <text
      x="12"
      y="14.4"
      textAnchor="middle"
      fontFamily="Arial, sans-serif"
      fontWeight="700"
      fontSize="6.5"
      fill="#fff"
    >
      npm
    </text>
  </Svg>
);

const PnpmIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="9" fill="#F9AD00" />
    <text
      x="12"
      y="15.4"
      textAnchor="middle"
      fontFamily="Arial, sans-serif"
      fontWeight="800"
      fontSize="11"
      fill="#fff"
    >
      p
    </text>
  </Svg>
);

const YarnIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="8.5" fill="#2C8EBB" />
    <g stroke="#fff" strokeWidth="1" fill="none" opacity="0.9">
      <path d="M5.5 9 Q12 12 18.5 9" />
      <path d="M5.5 15 Q12 12 18.5 15" />
      <path d="M9 5 Q12 12 9 19" />
      <path d="M15 5 Q12 12 15 19" />
    </g>
  </Svg>
);

const BunIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="9" fill="#F47216" />
    <text
      x="12"
      y="15.6"
      textAnchor="middle"
      fontFamily="Arial, sans-serif"
      fontWeight="800"
      fontSize="11"
      fill="#fff"
    >
      b
    </text>
  </Svg>
);

const PrettierIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <path
      d="M5 4.5c5-1 11 .5 14 4.5-4-1-8-1-11 1.5 2.5-1 5-.5 7 1-3 1-6 2.5-8 5 4-2.5 8-3 11-2-2.5 2-5 4.5-6 8-2.5-4-6-9-7-15z"
      fill="#764ABC"
    />
  </Svg>
);

const TurboIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <path d="M13 3 L6.5 13 H11 l-1.5 8 9.5 -12 H11.5 z" fill="#EF4444" />
  </Svg>
);

const EslintIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <path
      d="M12 2.5l7.5 2.7v5.3c0 4.6-3.2 7.6-7.5 8.9-4.3-1.3-7.5-4.3-7.5-8.9V5.2z"
      fill="#4B32C3"
    />
    <text
      x="12"
      y="14.6"
      textAnchor="middle"
      fontFamily="Arial, sans-serif"
      fontWeight="800"
      fontSize="8"
      fill="#fff"
    >
      E
    </text>
  </Svg>
);

const BabelIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="#F5DA55" />
    <text
      x="12"
      y="15.6"
      textAnchor="middle"
      fontFamily="Arial, sans-serif"
      fontWeight="800"
      fontSize="10"
      fill="#323330"
    >
      B
    </text>
  </Svg>
);

const BiomeIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="9" fill="#4DC0B4" />
    <path
      d="M8 8c3 0 5 2 5 5M16 16c-3 0-5-2-5-5"
      stroke="#fff"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
    />
  </Svg>
);

const ClaudeIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <path
      d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312"
      fill="#D97757"
      fillRule="nonzero"
    />
  </Svg>
);

const BRAND: Partial<Record<IconName, IconComponent>> = {
  docker: DockerIcon,
  npm: NpmIcon,
  pnpm: PnpmIcon,
  yarn: YarnIcon,
  bun: BunIcon,
  prettier: PrettierIcon,
  turbo: TurboIcon,
  eslint: EslintIcon,
  babel: BabelIcon,
  biome: BiomeIcon,
  claude: ClaudeIcon,
  agents: (p) => <Bot {...p} />,
  git: (p) => <GitBranch {...p} className={cn(p.className, "text-[#F14E32]")} />,
  readme: (p) => <BookOpen {...p} />,
  license: (p) => <Scale {...p} />,
  makefile: (p) => <Wrench {...p} />,
  env: (p) => <FileCog {...p} />,
  editorconfig: (p) => <FileCog {...p} />,
  tsconfig: (p) => <FileCog {...p} />,
};

const LUCIDE: Partial<Record<IconName, IconComponent>> = {
  typescript: (p) => <FileCode {...p} />,
  javascript: (p) => <FileCode {...p} />,
  react: (p) => <FileCode {...p} />,
  python: (p) => <FileCode {...p} />,
  rust: (p) => <FileCode {...p} />,
  go: (p) => <FileCode {...p} />,
  java: (p) => <FileCode {...p} />,
  kotlin: (p) => <FileCode {...p} />,
  c: (p) => <FileCode {...p} />,
  cpp: (p) => <FileCode {...p} />,
  csharp: (p) => <FileCode {...p} />,
  ruby: (p) => <FileCode {...p} />,
  php: (p) => <FileCode {...p} />,
  swift: (p) => <FileCode {...p} />,
  json: (p) => <FileJson {...p} />,
  yaml: (p) => <FileJson {...p} />,
  toml: (p) => <FileJson {...p} />,
  html: (p) => <FileCode {...p} />,
  css: (p) => <FileCode {...p} />,
  xml: (p) => <FileCode {...p} />,
  code: (p) => <FileCode {...p} />,
  markdown: (p) => <FileText {...p} />,
  text: (p) => <FileText {...p} />,
  word: (p) => <FileText {...p} />,
  csv: (p) => <Sheet {...p} />,
  excel: (p) => <Sheet {...p} />,
  pdf: (p) => <FileText {...p} />,
  image: (p) => <FileImage {...p} />,
  archive: (p) => <FileArchive {...p} />,
  database: (p) => <Database {...p} />,
  sql: (p) => <Database {...p} />,
  shell: (p) => <Terminal {...p} />,
  presentation: (p) => <Presentation {...p} />,
  lock: (p) => <FileCog {...p} />,
};

export type FileTypeIconProps = {
  /** 文件名（用于匹配精确名 / 扩展名） */
  name: string;
  size?: number;
  className?: string;
};

export function FileTypeIcon({ name, size = 14, className }: FileTypeIconProps) {
  const spec = resolve(name);
  const brand = BRAND[spec];
  if (brand) {
    return brand({ size, className: cn("shrink-0", className) });
  }
  const Generic = LUCIDE[spec] ?? FileIcon;
  return (
    <Generic size={size} className={cn("shrink-0 text-muted-foreground", className)} />
  );
}
