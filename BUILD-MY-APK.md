# 用云构建拿 APK（你不用装任何东西）

这个仓库只放「我们的改动 + 构建流程」，**不含**那 710MB 的离线输入。
CI 每次从官方 Release 下载完整源码包（里面已含固定输入），套上改动，编出 APK。

## 一次性操作

1. 在 GitHub 新建一个**私有仓库**（空仓库即可）。
2. 把本 `dsh-app/` 目录推上去（见下）。
3. 仓库 → **Actions** → 左侧 `Build DSH Mobile APK` → **Run workflow** → 直接点绿色按钮
   （默认参数已填好：官方源码包 URL + SHA-256）。
4. 等约 20–50 分钟，进入该次 run，页面底部 **Artifacts** 下载 `DSH-Mobile-debug-apk`，
   里面就是可安装的 `*.apk`。

## 推送命令（在本机执行）
```bash
cd dsh-app
git init
git add -A
git commit -m "feat: DSH Mobile app (rebrand + LAN sync)"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```
> 若提示文件过大，说明误把解压的官方源码放进了本目录；本目录**只应有**：
> `sync/`、`tools/apply-dsh-mobile.py`、`.github/workflows/build-apk.yml`、以及少量文档，
> 不要放 `upstream/`、`*.zip`、`app/`（那是 CI 里现拉现编的）。

## 它做了什么改动
- 应用名 → `DSH Mobile`；包名 → `com.dshmobile.app`（与原版独立，可并存）
- 把 `sync/sync.mjs`（局域网会话/任务双向同步引擎）打进 APK 的 assets
- 用官方源码自带的 `tools/ci-toolchain.py` 对齐 JDK / SDK / NDK 版本，产出 debug 可装包

## 可能踩的坑（如第一次失败，把 Actions 日志发我，我来修）
- CI runner 装不到 `platforms;android-37.0`（若官方 SDK 源暂时没上架 37），
  需要临时把 compileSdk/targetSdk 降到 36——改 `tools/apply-dsh-mobile.py` 加一条替换即可。
- 首次运行 Gradle 要下载 9.3.1 与依赖，网络慢会超时；workflow 已设 180 分钟。
- debug 包是调试签名，日常自用足够；要上架再另外配正式签名(keystore)。
