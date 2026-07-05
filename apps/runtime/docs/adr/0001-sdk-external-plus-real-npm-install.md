# Claude/Codex SDK 保持 external,靠真实 npm install 提供二进制,不靠 bundle inline

`@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` 是壳子——真正的 `claude`/`codex`
可执行文件通过平台专属的 `optionalDependencies`(如 `@anthropic-ai/claude-agent-sdk-darwin-arm64`)
分发,SDK 自己的代码在运行时用 `createRequire(import.meta.url)` 去找这个平台包,锚点是
**它自己代码实际执行时的文件位置**。

commit `e50634f5` 曾经把这两个 SDK 从 `--external` 改成 `--bundle`(inline 进产物),原因是
`--external` 下被 fork 的 worker 进程解析不到裸 ESM specifier、直接 `ERR_MODULE_NOT_FOUND`——
但那次改动只是把"裸 specifier 解析不到"这个症状盖住了:inline 之后,SDK 内部
`createRequire(import.meta.url)` 的锚点变成了打包产物自己的文件位置,而不是 SDK 在 pnpm
store 里的原始位置,导致内嵌进 server 的产物(`apps/server/dist/agework-runtime/main.mjs`)
和独立 `apps/runtime/dist/main.js` 都解析不到平台二进制包——用真实文件路径做
`createRequire(...).resolve(...)` 复现过,两处都会失败,inline 之前也一样有这个问题只是没人
在这条路径上真正跑过 agent。

Docker 镜像从来没有这个问题,因为它压根不依赖 bundle 里 `import.meta.url` 那套技巧:
`package.docker.json` 单独声明这两个 SDK,镜像构建时在容器里跑一次真实 `npm install`,flat
安装出的平台二进制包和主包是平级兄弟,从 `dist/main.js` 往上一层就能找到。这条路径被验证过是
可靠的。

决定:改回 `--external`,不再 inline 这两个 SDK;`apps/server/scripts/embed-runtime.mjs` 复制
`main.mjs`/`runner.mjs` 之后,额外复用 `apps/runtime/package.docker.json` 这份清单,在内嵌目录
里跑一次真实 `npm install --omit=dev`——和 Docker 镜像构建时做的事完全一致,只是发生在 server
构建这台机器上(Managed-local 本来就要求 server/worker 同机,构建机器与运行机器一致)。

## Consequences

- `dist/main.js`/`dist/runner.js` 体积从 inline 时的 5.3MB/3.6MB 降到 4.3MB/2.5MB。
- server 构建多一步真实 `npm install`(~15s),`apps/server/dist/agework-runtime/` 下多一个
  `node_modules`。
- 独立跑 `apps/runtime/dist/main.js`(不经 Docker、不经 server embed 这两条已经处理过的路径)
  仍然解析不到这两个 SDK——这条路径本来就是已知缺口(`docs/todo/runtime-worker-module-refactor.md`
  里的 "Registered+local" 缺口),没有被这次修复覆盖,后续需要时应该复用同一个模式
  (`package.docker.json` + 真实 npm install)。
