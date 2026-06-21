const path = require("node:path");
const { rebuild } = require("@electron/rebuild");

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  const productName = context.packager.appInfo.productFilename;

  // Resolve the api directory path based on the target platform
  const apiDir =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${productName}.app`, "Contents", "Resources", "app", "api")
      : path.join(appOutDir, "resources", "app", "api");

  // electron-builder passes arch as a numeric enum (Arch.ia32=0, x64=1, armv7l=2, arm64=3)
  // "universal" (4) is intentionally omitted — @electron/rebuild has no universal support
  const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64" };
  const rebuildArch = typeof arch === "string" ? arch : (ARCH_NAMES[arch] ?? String(arch));

  const electronVersion =
    context.packager.config.electronVersion ??
    require("electron/package.json").version;

  await rebuild({
    buildPath: apiDir,
    electronVersion,
    arch: rebuildArch,
    onlyModules: ["better-sqlite3"],
  });
};
