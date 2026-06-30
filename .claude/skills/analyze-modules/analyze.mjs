#!/usr/bin/env node
/**
 * analyze-modules 的结构提取脚本。
 * 机械扫描 apps/api/src 全部 feature module,输出跨模块关系 JSON,交给 LLM 翻译成 HTML。
 * 用途:保证全量分析不漏模块、调用点有 file:line 证据,而不是靠 LLM 凭记忆。
 *
 * 运行: node .claude/skills/analyze-modules/analyze.mjs [src-dir]
 * 默认 src-dir = apps/api/src
 *
 * 输出 JSON 结构:
 *   modules: [{ name, path, imports:[modName], exports:[provider], rootService, file }]
 *   forwardEdges: [{ from, to, calls:[{callerClass, callerMethod, callee, file, line}] }]
 *   portEdges:    [{ port, definedIn(module/file/line), wiredIn(module/file/line), invokedAt(file/line), implIn(module/file), methods:[] }]
 *   eventEdges:   [{ event, emitter(module/file/line), listeners:[{module,file,line}] }]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, basename, dirname } from "node:path";

const SRC = process.argv[2] || join(process.cwd(), "apps", "api", "src");

const read = (p) => readFileSync(p, "utf8");
const lines = (s) => s.split(/\r?\n/);

// 列出所有 *.module.ts(排除 app.module.ts 这个组合根)
function findModules(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findModules(full));
    } else if (entry.endsWith(".module.ts") && entry !== "app.module.ts") {
      out.push(full);
    }
  }
  return out;
}

// 模块名 = 目录名(feature module 直接放在 src/<feature>/)
function moduleName(file) {
  const rel = relative(SRC, file).split(sep);
  return rel[0]; // feature module 根目录名,子目录文件也归到根模块
}

// 从 module.ts 抽 imports / exports / 根 Service
function parseModule(file) {
  const src = read(file);
  const name = moduleName(file);
  const importNames = [];
  const exportNames = [];

  // import { XxxModule } from "../<mod>/<mod>.module"
  for (const m of src.matchAll(/from\s+["']([^"']+)\.module["']/g)) {
    const ref = m[1];
    const seg = ref.split("/").filter(Boolean).pop();
    if (seg) importNames.push(seg);
  }
  // exports: [ A, B ] —— 抓块内标识符
  const ex = src.match(/exports:\s*\[([\s\S]*?)\]/);
  if (ex) {
    exportNames.push(
      ...ex[1]
        .split(/[\n,]/)
        .map((s) => s.trim().replace(/[{}].*$/, "").trim())
        .filter((s) => /^[A-Z]/.test(s) && s)
    );
  }
  // 根 Service 约定:与模块同名的 service 文件
  const rootService = `${name}.service.ts`;
  return { name, file, imports: dedup(importNames), exports: dedup(exportNames), rootService };
}

function dedup(a) {
  return [...new Set(a)];
}

// 在某个文件里定位调用点:callerClass.method() -> injectedReceiver.<x>(...)
// 注入字段名与类型可不同(private readonly runtimeService: RuntimeService),
// 所以抓「字段名 -> 类型」,再用类型查 export owner,用字段名匹配 this.<field>.method()
function analyzeForward(modules) {
  const exportOwner = new Map(); // ServiceName -> module name
  for (const m of modules) for (const e of m.exports) exportOwner.set(e, m.name);

  const edges = new Map(); // "from->to" -> { from, to, calls:[], seen:Set }
  for (const m of modules) {
    const files = listTs(dirname(m.file));
    // 先扫该模块所有 ts 文件的注入声明(根 Service + 子 provider 构造函数都覆盖)
    const injected = []; // {field, type}
    for (const f of files) {
      const src = read(f);
      for (const m2 of src.matchAll(/(?:private|readonly|protected)\s+(?:readonly\s+)?(\w+)\s*:\s*(\w+Service)/g)) {
        injected.push({ field: m2[1], type: m2[2] });
      }
    }
    // 再扫所有文件里 this.<field>.<method>( 调用
    for (const f of files) {
      const fsrc = read(f);
      const flines = lines(fsrc);
      flines.forEach((ln, i) => {
        for (const inj of injected) {
          const re = new RegExp(`this\\.${inj.field}\\.(\\w+)\\(`, "g");
          let mm;
          while ((mm = re.exec(ln)) !== null) {
            const owner = exportOwner.get(inj.type);
            if (owner && owner !== m.name) {
              const key = `${m.name}->${owner}`;
              if (!edges.has(key))
                edges.set(key, { from: m.name, to: owner, calls: [], seen: new Set() });
              const callee = `${inj.type}.${mm[1]}()`;
              const dedupKey = `${callee}@${rel(f)}:${i + 1}`;
              const e = edges.get(key);
              if (!e.seen.has(dedupKey)) {
                e.seen.add(dedupKey);
                e.calls.push({
                  callerClass: classNameFromFile(f),
                  callerMethod: resolveEnclosingMethod(flines, i),
                  callee,
                  file: rel(f),
                  line: i + 1,
                });
              }
            }
          }
        }
      });
    }
  }
  for (const e of edges.values()) delete e.seen;
  return [...edges.values()];
}

// 从第 lineIdx(0-based)行往上找最近的 method 定义行,返回方法名。
// 脚本只给 callerClass,缺 caller 的具体方法名;HTML 卡片需要 callerClass.method(),
// 故在此反查 enclosing method,避免 LLM 手工逐条 grep。
function resolveEnclosingMethod(flines, lineIdx) {
  const methodRe = /^\s*(?:public|private|protected|static|readonly|abstract|override|async|\s)*\b(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/;
  const classRe = /^\s*(?:export\s+)?(?:abstract\s+)?class\b/;
  // 已知工具函数 / 链式调用,不可能是方法定义
  const NON_METHOD = new Set([
    "swallow", "safeLogJson", "errorLogFields", "generateId", "console",
  ]);
  for (let i = lineIdx; i >= 0; i--) {
    const l = flines[i];
    if (l === undefined) continue;
    if (classRe.test(l)) return "?"; // 已离开任何方法
    if (/^\s*(if|for|while|switch|catch|else|do|return|throw)\b/.test(l)) continue;
    const mm = l.match(methodRe);
    if (!mm) continue;
    const name = mm[1];
    if (["if","for","while","switch","catch","else","do","return","throw"].includes(name)) continue;
    if (NON_METHOD.has(name)) continue;
    // 调用特征排除:名字前有 . (a.b() 调用) 或 this.xxx( 调用,且无方法修饰符
    const hasModifier = /^\s*(?:public|private|protected|static|async|readonly)\b/.test(l);
    if (!hasModifier) {
      if (/\bthis\s*\.\s*\w+\s*\(/.test(l)) continue;
      if (/(?<!\w)\.\s*[a-zA-Z_$]/.test(l)) continue;
    }
    return name;
  }
  return "?";
}

function classNameFromFile(file) {
  const base = basename(file).replace(/\.ts$/, "");
  // kebab -> Pascal
  const pascal = base
    .split(/[-.]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return pascal;
}

// Port:找 XxxPort 接口定义 + setXxxPort 接线 + sink 回调
function analyzePorts(modules) {
  const ports = [];
  const allFiles = modules.flatMap((m) => listTs(dirname(m.file)));
  // 1. 定义:export interface XxxPort
  const defs = new Map(); // portName -> {file,line,module}
  for (const f of allFiles) {
    const src = read(f);
    lines(src).forEach((ln, i) => {
      const m = ln.match(/export\s+interface\s+(\w*Port)\b/);
      if (m) defs.set(m[1], { file: rel(f), line: i + 1, module: moduleName(f) });
    });
  }
  // 2. 接线:setXxxPort( 在任意文件
  for (const [portName, def] of defs) {
    // 接线方法名约定:set<Stem>Port,stem 取自 portName 去 Port
    let wired = null;
    for (const f of allFiles) {
      const src = read(f);
      const idx = src.indexOf(`set${portName}`);
      if (idx >= 0) {
        wired = { file: rel(f), line: src.slice(0, idx).split(/\r?\n/).length, module: moduleName(f) };
        break;
      }
    }
    // 3. 回调:.<method>( 经 sink/receiver —— 抓 portName 类型字段的调用
    const invoked = [];
    for (const f of allFiles) {
      const src = read(f);
      const flines = lines(src);
      flines.forEach((ln, i) => {
        // 形如 this.sink.notifyXxx( 或 receiver.sendXxx( —— 粗抓含 Port 接口方法名的行
        const m = ln.match(/(?:this\.\w+|this\.receiver|this\.sink)\.(\w+)\(/);
        if (m) invoked.push({ file: rel(f), line: i + 1, method: m[1] });
      });
    }
    if (wired) {
      ports.push({
        port: portName,
        definedIn: def,
        wiredIn: wired,
        invokedAt: invoked.slice(0, 6),
      });
    }
  }
  return ports;
}

// 事件:@OnEvent 订阅 + .emit( 发布配对
function analyzeEvents(modules) {
  const allFiles = modules.flatMap((m) => listTs(dirname(m.file)));
  const listeners = []; // {event, module, file, line}
  const emitters = []; // {event, module, file, line}
  for (const f of allFiles) {
    const src = read(f);
    lines(src).forEach((ln, i) => {
      const sub = ln.match(/@OnEvent\(\s*\[?\s*([A-Z_][A-Z0-9_]*)/);
      if (sub) listeners.push({ event: sub[1], module: moduleName(f), file: rel(f), line: i + 1 });
      const em = ln.match(/\.emit(?:Async)?\(\s*([A-Z_][A-Z0-9_]*)/);
      if (em) emitters.push({ event: em[1], module: moduleName(f), file: rel(f), line: i + 1 });
    });
  }
  // 配对:同一 event,emitter module != listener module
  const edges = [];
  for (const em of emitters) {
    for (const l of listeners) {
      if (em.event === l.event && em.module !== l.module) {
        edges.push({ event: em.event, emitter: em, listener: l });
      }
    }
  }
  return edges;
}

function listTs(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const rel = (p) => relative(process.cwd(), p).split(sep).join("/");

const main = () => {
  const modFiles = findModules(SRC);
  const modules = modFiles.map(parseModule);
  const forwardEdges = analyzeForward(modules);
  const portEdges = analyzePorts(modules);
  const eventEdges = analyzeEvents(modules);
  const result = { modules, forwardEdges, portEdges, eventEdges };
  process.stdout.write(JSON.stringify(result, null, 2));
};

main();
