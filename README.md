# DSH Mobile

在官方 DSHA（DeepSeek Harness 安卓启动器）基础上做的定制构建：
应用名 DSH Mobile、包名 com.dshmobile.app，并内置局域网会话/任务同步引擎。

- 构建：见 [BUILD-MY-APK.md](BUILD-MY-APK.md)，或直接跑 GitHub Actions Build DSH Mobile APK。
- 同步引擎：`sync/sync.mjs`（桌面 serve + 手机 sync，双向，按 mtime 冲突处理，7/7 自测通过）。
