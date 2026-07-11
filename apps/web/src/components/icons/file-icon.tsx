import type { ReactElement } from "react";
import {
  BookOpen,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileText,
  Presentation,
  Scale,
  Sheet,
  Terminal,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FILE_TREE_COLORS,
  FILE_TREE_GLYPHS,
  type GlyphData,
} from "./file-tree-glyphs";

/**
 * 文件类型图标组件。
 *
 * 1:1 复刻 ChatGPT 桌面端（v26.707.41301，原 Codex 能力已并入）的文件树图标：
 *   - 映射表(精确名 `bb` 104 项 + 扩展名 `xb` 120 项)来自解包 app.asar
 *   - 真实图标字形来自 app 内联 SVG sprite `<symbol id="file-tree-builtin-*">`
 *     （见 ./file-tree-glyphs.ts，由脚本从 asar 生成，禁止手改）
 *   - 每个字形用 `currentColor` 上色，颜色取源里 --trees-file-icon-color-* 对应品牌色
 *
 * 2026-07-11 重新抓取并校正：此前误用字母方块代替真实字形，现已替换为源码手绘 SVG。
 */

type IconName =
  // 品牌 / 工具（源 50 类别 + nextjs/stylelint/font）
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
  | "image"
  | "database"
  | "text"
  | "default"
  // 语言 / 数据（源类别）
  | "typescript"
  | "javascript"
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
  | "lock";

type IconProps = { size?: number; className?: string };
type IconComponent = (props: IconProps) => ReactElement;

/* ----------------------------- 真实字形渲染 ----------------------------- */
function Glyph({
  name,
  size = 14,
  className,
}: IconProps & { name: string }) {
  const data: GlyphData | undefined = FILE_TREE_GLYPHS[name];
  if (!data) return <FileIcon size={size} className={cn("shrink-0", className)} />;
  const color = FILE_TREE_COLORS[name] ?? "#6B7280";
  return (
    <svg
      width={size}
      height={size}
      viewBox={data.viewBox}
      fill="currentColor"
      style={{ color }}
      className={cn("shrink-0", className)}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: data.inner }}
    />
  );
}

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

/* ----------------------------- 图标渲染 ----------------------------- */
// 源类别：全部用真实手绘 SVG 字形（来自 file-tree-glyphs.ts）
const SOURCE_GLYPH: Partial<Record<IconName, string>> = {
  docker: "docker",
  npm: "npm",
  bun: "bun",
  prettier: "prettier",
  eslint: "eslint",
  babel: "babel",
  biome: "biome",
  claude: "claude",
  git: "git",
  astro: "astro",
  graphql: "graphql",
  vue: "vue",
  tailwind: "tailwind",
  terraform: "terraform",
  react: "react",
  vscode: "vscode",
  bash: "bash",
  browserslist: "browserslist",
  bootstrap: "bootstrap",
  c: "c",
  cpp: "cpp",
  css: "css",
  go: "go",
  html: "html",
  json: "json",
  markdown: "markdown",
  mcp: "mcp",
  oxc: "oxc",
  postcss: "postcss",
  python: "python",
  ruby: "ruby",
  rust: "rust",
  sass: "sass",
  svelte: "svelte",
  svg: "svg",
  svgo: "svgo",
  swift: "swift",
  table: "table",
  vite: "vite",
  wasm: "wasm",
  webpack: "webpack",
  yml: "yml",
  zip: "zip",
  zig: "zig",
  font: "font",
  nextjs: "nextjs",
  stylelint: "stylelint",
  image: "image",
  database: "database",
  text: "text",
  default: "default",
  typescript: "typescript",
  javascript: "javascript",
};

const LUCIDE: Partial<Record<IconName, IconComponent>> = {
  // agework 额外通用兜底（源码无对应字形，用 lucide 通用图标）
  readme: (p) => <BookOpen {...p} />,
  license: (p) => <Scale {...p} />,
  makefile: (p) => <Wrench {...p} />,
  env: (p) => <FileCog {...p} />,
  editorconfig: (p) => <FileCog {...p} />,
  tsconfig: (p) => <FileCog {...p} />,
  archive: (p) => <FileArchive {...p} />,
  java: (p) => <FileCode {...p} />,
  kotlin: (p) => <FileCode {...p} />,
  csharp: (p) => <FileCode {...p} />,
  php: (p) => <FileCode {...p} />,
  xml: (p) => <FileCode {...p} />,
  code: (p) => <FileCode {...p} />,
  word: (p) => <FileText {...p} />,
  csv: (p) => <Sheet {...p} />,
  excel: (p) => <Sheet {...p} />,
  pdf: (p) => <FileText {...p} />,
  sql: (p) => <FileCode {...p} />,
  shell: (p) => <Terminal {...p} />,
  presentation: (p) => <Presentation {...p} />,
  lock: (p) => <FileCog {...p} />,
  image: (p) => <FileImage {...p} />,
  database: (p) => <FileCode {...p} />,
  text: (p) => <FileText {...p} />,
  typescript: (p) => <FileCode {...p} />,
  javascript: (p) => <FileCode {...p} />,
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
  table: (p) => <Sheet {...p} />,
};

export type FileTypeIconProps = {
  /** 文件名（用于匹配精确名 / 扩展名） */
  name: string;
  size?: number;
  className?: string;
};

export function FileTypeIcon({ name, size = 14, className }: FileTypeIconProps) {
  const spec = resolve(name);
  const glyphName = SOURCE_GLYPH[spec];
  if (glyphName) {
    return (
      <Glyph
        name={glyphName}
        size={size}
        className={cn("shrink-0", className)}
      />
    );
  }
  const Generic = LUCIDE[spec] ?? FileIcon;
  return (
    <Generic size={size} className={cn("shrink-0 text-muted-foreground", className)} />
  );
}
