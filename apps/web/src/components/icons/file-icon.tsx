import type { ReactElement } from "react";
import {
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
 * 设计对齐 ChatGPT 桌面端（v26.707.41301，原 Codex 能力已并入）的文件树图标实现：
 *   - 零外部依赖，纯手写内联 SVG + 每品牌专属配色
 *   - 两层解析：精确文件名表 (EXACT) + 扩展名表 (EXT)
 *   - 数据来自解包 app.asar 得到的精确名表 `bb`(104 项) 与扩展名表 `xb`(120 项)
 *   - 图标类别共 50 个（对应源里 --trees-file-icon-color-* 调色板）
 *
 * 2026-07-11 重新抓取：相对旧版，移除 pnpm/yarn/turbo/agents（源码已无），
 * 新增 astro / svelte / graphql / mcp / vscode / vue / wasm / zig / table /
 * svgo / tailwind / terraform / oxc / postcss / sass / bootstrap / browserslist /
 * bash 等类别及完整扩展名映射。
 */

type IconName =
  // 品牌 / 工具（源 50 类别）
  | "docker"
  | "npm"
  | "bun"
  | "prettier"
  | "eslint"
  | "babel"
  | "biome"
  | "claude"
  | "git"
  | "astro"
  | "graphql"
  | "vue"
  | "tailwind"
  | "terraform"
  | "react"
  | "vscode"
  | "bash"
  | "browserslist"
  | "bootstrap"
  | "c"
  | "cpp"
  | "css"
  | "go"
  | "html"
  | "json"
  | "markdown"
  | "mcp"
  | "oxc"
  | "postcss"
  | "python"
  | "ruby"
  | "rust"
  | "sass"
  | "svelte"
  | "svg"
  | "svgo"
  | "swift"
  | "table"
  | "vite"
  | "wasm"
  | "webpack"
  | "yml"
  | "zip"
  | "zig"
  | "font"
  | "nextjs"
  | "stylelint"
  // 语言 / 数据（源类别）
  | "typescript"
  | "javascript"
  | "image"
  | "database"
  | "text"
  // agework 额外通用兜底（源码经语言探测也归为通用图标）
  | "readme"
  | "license"
  | "makefile"
  | "env"
  | "editorconfig"
  | "tsconfig"
  | "java"
  | "kotlin"
  | "csharp"
  | "php"
  | "xml"
  | "code"
  | "word"
  | "csv"
  | "excel"
  | "pdf"
  | "archive"
  | "sql"
  | "shell"
  | "presentation"
  | "lock"
  | "default";

type IconProps = { size?: number; className?: string };
type IconComponent = (props: IconProps) => ReactElement;

/* ----------------------------- SVG 基础 ----------------------------- */
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

/** 单色圆角方块 + 字母徽标，用于绝大多数品牌/工具图标（与源码“每类一个彩色 sprite”一致） */
function Mono({
  size = 14,
  className,
  color,
  label,
}: IconProps & { color: string; label: string }) {
  const fs = label.length >= 3 ? 5 : label.length === 2 ? 6.5 : 8;
  return (
    <Svg size={size} className={className}>
      <rect x="2" y="2" width="20" height="20" rx="4.5" fill={color} />
      <text
        x="12"
        y="12"
        dy="0.35em"
        textAnchor="middle"
        fontFamily="Arial, sans-serif"
        fontWeight="800"
        fontSize={fs}
        fill="#fff"
      >
        {label}
      </text>
    </Svg>
  );
}

/* ----------------------------- 手写品牌 SVG ----------------------------- */
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

const AstroIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 3 L21 19 H3 Z" fill="#BC52EE" />
    <path d="M12 9 L16.5 17 H7.5 Z" fill="#fff" />
  </Svg>
);

const GraphqlIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <path
      d="M12 2.5 L19.5 6.75 V15.25 L12 19.5 L4.5 15.25 V6.75 Z"
      fill="none"
      stroke="#E10098"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="11" r="2.2" fill="#E10098" />
  </Svg>
);

const VueIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <path d="M3 4 H8.5 L12 11 L15.5 4 H21 L12 20 Z" fill="#42B883" />
    <path d="M7 4 H9.2 L12 9.5 L14.8 4 H17 L12 13 Z" fill="#35495E" />
  </Svg>
);

const TailwindIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <rect x="2" y="2" width="20" height="20" rx="4.5" fill="#38BDF8" />
    <path
      d="M7 9c1.2-2 2.5-2 3.5 0s2.3 2 3.5 0 2.5-2 3.5 0"
      fill="none"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
    <path
      d="M7 14c1.2-2 2.5-2 3.5 0s2.3 2 3.5 0 2.5-2 3.5 0"
      fill="none"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </Svg>
);

const TerraformIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <g fill="#7B42BC">
      <path d="M4 5 L8 3 V14 L4 16 Z" />
      <path d="M10 8 L14 6 V17 L10 19 Z" />
      <path d="M16 5 L20 3 V14 L16 16 Z" />
    </g>
  </Svg>
);

const ReactIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="1.8" fill="#61DAFB" />
    <g fill="none" stroke="#61DAFB" strokeWidth="1.2">
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    </g>
  </Svg>
);

const VscodeIcon: IconComponent = ({ size, className }) => (
  <Svg size={size} className={className}>
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="#007ACC" />
    <path
      d="M16.5 8 L11 12 L16.5 16 L18.5 14 V10 Z"
      fill="#fff"
    />
    <path d="M11 12 L7.5 9.5 L6 12 L7.5 14.5 Z" fill="#fff" opacity="0.85" />
  </Svg>
);

/* ----------------------------- 精确文件名表 ----------------------------- */
// 大小写不敏感匹配（lower 后查表）。来源：ChatGPT 桌面端 `bb` 精确名表 (104 项) + agework 自有补充。
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
  "docker-compose.override.yml": "docker",
  "compose.yaml": "docker",
  "compose.yml": "docker",
  // npm
  ".npmrc": "npm",
  ".npmignore": "npm",
  "package.json": "npm",
  "package-lock.json": "npm",
  // bun
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "bunfig.toml": "bun",
  // prettier
  ".prettierrc": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.mjs": "prettier",
  ".prettierrc.toml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".prettierrc.yml": "prettier",
  ".prettierignore": "prettier",
  "prettier.config.cjs": "prettier",
  "prettier.config.js": "prettier",
  "prettier.config.mjs": "prettier",
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
  "eslint.config.cjs": "eslint",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  "eslint.config.mts": "eslint",
  "eslint.config.ts": "eslint",
  // babel
  ".babelrc": "babel",
  ".babelrc.json": "babel",
  "babel.config.js": "babel",
  "babel.config.json": "babel",
  "babel.config.cjs": "babel",
  "babel.config.mjs": "babel",
  // biome
  "biome.json": "biome",
  "biome.jsonc": "biome",
  // claude
  ".claude": "claude",
  "claude.md": "claude",
  // 构建工具（新源）
  "next.config.js": "nextjs",
  "next.config.mjs": "nextjs",
  "next.config.mts": "nextjs",
  "next.config.ts": "nextjs",
  "vite.config.js": "vite",
  "vite.config.mjs": "vite",
  "vite.config.mts": "vite",
  "vite.config.ts": "vite",
  "webpack.config.js": "webpack",
  "webpack.config.cjs": "webpack",
  "webpack.config.mjs": "webpack",
  "webpack.config.ts": "webpack",
  "webpack.config.babel.js": "webpack",
  "tailwind.config.cjs": "tailwind",
  "tailwind.config.js": "tailwind",
  "tailwind.config.mjs": "tailwind",
  "tailwind.config.ts": "tailwind",
  "postcss.config.cjs": "postcss",
  "postcss.config.js": "postcss",
  "postcss.config.mjs": "postcss",
  "postcss.config.ts": "postcss",
  "svgo.config.cjs": "svgo",
  "svgo.config.js": "svgo",
  "svgo.config.mjs": "svgo",
  "svgo.config.ts": "svgo",
  ".terraform.lock.hcl": "terraform",
  // stylelint
  ".stylelintrc": "stylelint",
  ".stylelintrc.cjs": "stylelint",
  ".stylelintrc.js": "stylelint",
  ".stylelintrc.json": "stylelint",
  ".stylelintrc.mjs": "stylelint",
  ".stylelintrc.yaml": "stylelint",
  ".stylelintrc.yml": "stylelint",
  ".stylelintignore": "stylelint",
  "stylelint.config.cjs": "stylelint",
  "stylelint.config.js": "stylelint",
  "stylelint.config.mjs": "stylelint",
  // oxc
  ".oxlintrc.json": "oxc",
  // browserslist
  ".browserslistrc": "browserslist",
  // bash / zsh
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "bash",
  ".zprofile": "bash",
  ".zshenv": "bash",
  // bootstrap
  "bootstrap.js": "bootstrap",
  "bootstrap.min.js": "bootstrap",
  "bootstrap.css": "bootstrap",
  "bootstrap.min.css": "bootstrap",
  "bootstrap.bundle.js": "bootstrap",
  "bootstrap.bundle.min.js": "bootstrap",
  // ruby
  gemfile: "ruby",
  rakefile: "ruby",
  // readme / license
  readme: "readme",
  "readme.md": "markdown",
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
// 来源：ChatGPT 桌面端 `xb` 扩展名表 (120 项，按末段扩展名解析) + agework 自有补充。
const EXT: Record<string, IconName> = {
  ts: "typescript",
  tsx: "typescript",
  cts: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  pyw: "python",
  pyx: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  inl: "cpp",
  mm: "cpp",
  cs: "csharp",
  rb: "ruby",
  erb: "ruby",
  gemspec: "ruby",
  rake: "ruby",
  php: "php",
  swift: "swift",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  yml: "yml",
  yaml: "yml",
  toml: "yaml",
  xml: "code",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  postcss: "css",
  styl: "css",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "text",
  text: "text",
  log: "text",
  rst: "text",
  ini: "text",
  cfg: "text",
  conf: "text",
  editorconfig: "text",
  authors: "text",
  changelog: "text",
  contributors: "text",
  env: "text",
  "env.development": "text",
  "env.local": "text",
  "env.production": "text",
  csv: "csv",
  tsv: "table",
  xls: "excel",
  xlsx: "excel",
  ods: "table",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "svg",
  webp: "image",
  ico: "image",
  icns: "image",
  bmp: "image",
  avif: "image",
  tif: "image",
  tiff: "image",
  zip: "zip",
  "7z": "zip",
  tar: "zip",
  gz: "zip",
  bz2: "zip",
  tgz: "zip",
  xz: "zip",
  jar: "zip",
  war: "zip",
  rar: "zip",
  sql: "database",
  db: "database",
  sqlite: "database",
  sqlite3: "database",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  csh: "shell",
  ksh: "shell",
  ppt: "presentation",
  pptx: "presentation",
  doc: "word",
  docx: "word",
  lock: "lock",
  // 新源扩展名
  astro: "astro",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  gql: "graphql",
  wasm: "wasm",
  wast: "wasm",
  wat: "wasm",
  zig: "zig",
  tf: "terraform",
  tfstate: "terraform",
  tfvars: "terraform",
  mcp: "mcp",
  "code-workspace": "vscode",
  eot: "font",
  otf: "font",
  ttf: "font",
  woff: "font",
  woff2: "font",
};

function resolve(name: string): IconName {
  const lower = name.toLowerCase();
  if (EXACT[lower]) return EXACT[lower];
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (ext && EXT[ext]) return EXT[ext];
  return "default";
}

/* ----------------------------- 品牌 / 类别渲染 ----------------------------- */
const BRAND: Partial<Record<IconName, IconComponent>> = {
  // 手写 SVG
  docker: DockerIcon,
  npm: NpmIcon,
  bun: BunIcon,
  prettier: PrettierIcon,
  eslint: EslintIcon,
  babel: BabelIcon,
  biome: BiomeIcon,
  claude: ClaudeIcon,
  astro: AstroIcon,
  graphql: GraphqlIcon,
  vue: VueIcon,
  tailwind: TailwindIcon,
  terraform: TerraformIcon,
  react: ReactIcon,
  vscode: VscodeIcon,
  git: (p) => <GitBranch {...p} className={cn(p.className, "text-[#F14E32]")} />,
  // 字母徽标（单色方块 + 品牌色）
  bash: (p) => <Mono {...p} color="#4EAA25" label="$" />,
  browserslist: (p) => <Mono {...p} color="#4B6BF5" label="BL" />,
  bootstrap: (p) => <Mono {...p} color="#7952B3" label="B" />,
  c: (p) => <Mono {...p} color="#A8B9CC" label="C" />,
  cpp: (p) => <Mono {...p} color="#00599C" label="C++" />,
  css: (p) => <Mono {...p} color="#1572B6" label="#" />,
  go: (p) => <Mono {...p} color="#00ADD8" label="Go" />,
  html: (p) => <Mono {...p} color="#E34F26" label="{}" />,
  json: (p) => <Mono {...p} color="#C9B458" label="{}" />,
  markdown: (p) => <Mono {...p} color="#083FA1" label="M" />,
  mcp: (p) => <Mono {...p} color="#7C3AED" label="M" />,
  nextjs: (p) => <Mono {...p} color="#111827" label="N" />,
  oxc: (p) => <Mono {...p} color="#FBE212" label="O" />,
  postcss: (p) => <Mono {...p} color="#DD3A0A" label="P" />,
  python: (p) => <Mono {...p} color="#3776AB" label="Py" />,
  ruby: (p) => <Mono {...p} color="#CC342D" label="◆" />,
  rust: (p) => <Mono {...p} color="#CE422B" label="R" />,
  sass: (p) => <Mono {...p} color="#CC6699" label="S" />,
  stylelint: (p) => <Mono {...p} color="#263238" label="S" />,
  svgo: (p) => <Mono {...p} color="#FF6633" label="S" />,
  swift: (p) => <Mono {...p} color="#F05138" label="S" />,
  svg: (p) => <Mono {...p} color="#FFB13B" label="SVG" />,
  svelte: (p) => <Mono {...p} color="#FF3E00" label="S" />,
  table: (p) => <Sheet {...p} />,
  typescript: (p) => <Mono {...p} color="#3178C6" label="TS" />,
  javascript: (p) => <Mono {...p} color="#F7DF1E" label="JS" />,
  vite: (p) => <Mono {...p} color="#646CFF" label="V" />,
  wasm: (p) => <Mono {...p} color="#654FF0" label="W" />,
  webpack: (p) => <Mono {...p} color="#8DD6F9" label="W" />,
  yml: (p) => <Mono {...p} color="#CB171E" label="Y" />,
  zig: (p) => <Mono {...p} color="#F7A41D" label="Z" />,
  zip: (p) => <Mono {...p} color="#B8860B" label="ZIP" />,
  font: (p) => <Mono {...p} color="#6B7280" label="F" />,
  image: (p) => <FileImage {...p} />,
  database: (p) => <Database {...p} />,
  text: (p) => <FileText {...p} />,
  // agework 额外通用兜底
  readme: (p) => <BookOpen {...p} />,
  license: (p) => <Scale {...p} />,
  makefile: (p) => <Wrench {...p} />,
  env: (p) => <FileCog {...p} />,
  editorconfig: (p) => <FileCog {...p} />,
  tsconfig: (p) => <FileCog {...p} />,
  archive: (p) => <FileArchive {...p} />,
};

const LUCIDE: Partial<Record<IconName, IconComponent>> = {
  // 语言 / 通用类型兜底
  typescript: (p) => <FileCode {...p} />,
  javascript: (p) => <FileCode {...p} />,
  react: (p) => <FileCode {...p} />,
  python: (p) => <FileCode {...p} />,
  rust: (p) => <FileCode {...p} />,
  go: (p) => <FileCode {...p} />,
  c: (p) => <FileCode {...p} />,
  cpp: (p) => <FileCode {...p} />,
  ruby: (p) => <FileCode {...p} />,
  swift: (p) => <FileCode {...p} />,
  html: (p) => <FileCode {...p} />,
  css: (p) => <FileCode {...p} />,
  json: (p) => <FileJson {...p} />,
  yml: (p) => <FileJson {...p} />,
  markdown: (p) => <FileText {...p} />,
  text: (p) => <FileText {...p} />,
  word: (p) => <FileText {...p} />,
  pdf: (p) => <FileText {...p} />,
  image: (p) => <FileImage {...p} />,
  database: (p) => <Database {...p} />,
  sql: (p) => <Database {...p} />,
  csv: (p) => <Sheet {...p} />,
  excel: (p) => <Sheet {...p} />,
  table: (p) => <Sheet {...p} />,
  shell: (p) => <Terminal {...p} />,
  presentation: (p) => <Presentation {...p} />,
  lock: (p) => <FileCog {...p} />,
  java: (p) => <FileCode {...p} />,
  kotlin: (p) => <FileCode {...p} />,
  csharp: (p) => <FileCode {...p} />,
  php: (p) => <FileCode {...p} />,
  xml: (p) => <FileCode {...p} />,
  code: (p) => <FileCode {...p} />,
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
