# Linux 打包后 Harness 验证路径修复

日期：2026-10-22

## 问题与范围

上游 v0.12.1 新增 [`scripts/verify-packaged-harness.cjs`](https://github.com/dataelement/dsh-desktop/blob/v0.12.1/scripts/verify-packaged-harness.cjs)，由 `after-pack.cjs` 在 Office/PPT 验证前调用。它将非 macOS 的可执行文件统一解析为 `${product}.exe`，导致 Linux 打包完成后出现 `spawn .../DSH Desktop.exe ENOENT`。现有 Linux 适配仅处理 Office/PPT 两个钩子。

## 方案与约束

- 在现有 `prepareLinuxOffice` 中增加 Harness 钩子的已知源码替换；根据 `context.electronPlatformName` 判断 Linux，使用 `context.packager.executableName` 获取真实文件名。
- v0.12.0 等旧版没有该文件，允许缺失；文件存在但匹配位置变化、重复或不可读取时必须报错。
- 所有适配点验证成功后才写文件，避免上游变化导致部分适配被落盘。
- 保留上游 Harness、原生模块、终端、依赖闭包、Office/PPT 和会话格式校验；不变更上游锁文件，不关闭验证。
- 不修改构建/发布工作流，不执行发布或耗时的完整依赖下载与打包。

## 任务与验收

1. 增加回归用例，复现新 Harness 钩子在 Linux 选择 `.exe` 的问题。
2. 增加可选的已知钩子适配；验证 Linux 自定义文件名以及 Windows/macOS 路径保持正确，验证参数、环境变量和错误传播不变。
3. 验证旧版缺少新钩子仍可适配，重复执行幂等，上游新钩子变化时在写入前失败。
4. 用真实上游 v0.12.0/v0.12.1 的相关源码验证适配，并运行现有离线回归；不将离线检查描述为完整构建通过。
5. 更新 README 和本地 MEMORY.md，记录根因、兼容边界和验证结果。

## 风险

- 上游钩子仍只正式支持 Windows/macOS，后续修改需要重新核对替换点。
- 路径修复只消除本次 ENOENT；完整 Linux 产物的运行时验证仍由 CI 构建执行并保留失败反馈。

## 验证结果

- 新增用例在修复前复现 Linux 选择 `DSH Desktop.exe`，以及未知 Harness 钩子被忽略的问题；修复后通过。
- `node --test tests/*.test.mjs`：11 项全部通过。
- 使用 GitHub 上真实的 v0.12.0/v0.12.1 相关源码验证适配成功及幂等；上游 `after-pack.cjs` 内容不变。
- 执行真实 v0.12.1 的 afterPack/Harness 钩子，模拟子进程边界：确认选中 Linux `dsh-desktop` 并保留 ASAR → Harness → PPT → Office 调用顺序与验证参数。
- 未执行完整依赖安装、Electron 打包或 CI 发布；完整产物的运行时验证仍需下次 CI 构建确认。
