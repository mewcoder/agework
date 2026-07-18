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

决定:改回 `--external`,不再 inline 这两个 SDK。二进制的真实安装由 **apps/runtime 自己
拥有和管理**——`apps/runtime` 的 build 脚本在 esbuild 之后跑 `scripts/install-sdk-deps.mjs`,
复用 `package.docker.json` 清单做一次真实 `npm install`,产出自成一体的
`apps/runtime/dist/node_modules`(含平台二进制,~460MB)。这份 dist 因此不只是 dev 回退用的
产物,而是"平台二进制唯一真实安装点"。

`apps/server/scripts/embed-runtime.mjs` 不再自己管理依赖、不重复装:只把
`apps/server/dist/agework-runtime/node_modules` **符链接**到 `apps/runtime/dist/node_modules`
(Managed-local 本来就要求 server/worker 同机部署,repo 目录结构随之同在)。Node 解析符链接
透明,效果等同真装一份,但零重复磁盘占用、也不需要额外去猜平台二进制的具体文件路径。

Docker 镜像不适用这个"符链接复用"模式——它跑在容器里,平台(通常是 Linux)与构建这台机器
(常是 macOS)不同,`apps/runtime/dist/node_modules` 里装的是构建机器自己的平台二进制,没法直接
搬进容器用。Docker 镜像继续维持自己单独 `npm install`(`package.docker.json` + Dockerfile 里已有
的那步),这是全平台通用、真正必要的重复,不是这次要消灭的对象。

## 怎么用

不需要手动装任何东西,正常跑构建命令即可,这一步会自动触发:

- 日常开发:`pnpm dev` / `pnpm dev:server`——turbo 的 `^build` 会先构建
  `@agework/runtime-host`,内含这次真实 `npm install`,装一次留在
  `apps/runtime/dist/node_modules`(首次约 15s、~460MB 磁盘,只发生这一处)。
- 构建 server:`pnpm build` / `pnpm --filter server build`——`embed-runtime.mjs`
  只建符链接,不重复装。
- Docker 镜像:`pnpm worker:build`——跟以前一样自己在容器里单独装,不受影响。

## Consequences

- `dist/main.js`/`dist/runner.js` 体积从 inline 时的 5.3MB/3.6MB 降到 4.3MB/2.5MB。
- `apps/runtime` 的 build 多一步真实 `npm install`(~15s,首次约 460MB 磁盘);
  `apps/server` 的 build 不再自己装依赖,只建一个符链接,server 侧零额外磁盘占用。
- 独立跑 `apps/runtime/dist/main.js`(不经 Docker、不经 server embed)本身就有完整的
  `dist/node_modules`,可以直接工作——这条路径(dev 回退、未来 Registered+local)现在也被
  这次修复覆盖了,不再是缺口。
