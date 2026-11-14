#!/usr/bin/env python3
"""把「DSH Mobile」自定义套到官方 DSHA 源码包上（CI 用）。
   argv[1] = 解压后的官方源码根目录
   argv[2] = 本仓库里的 sync.mjs 路径（可选）
   环境变量 FORCE_SDK=36 时，把 compileSdk/targetSdk 从 37 降到 36（公开 SDK 源暂缺 37 时兜底）
"""
import sys, os, pathlib

src = pathlib.Path(sys.argv[1])
sync = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None
force_sdk = os.environ.get("FORCE_SDK")

strings = src / "app/src/main/res/values/strings.xml"
bg = src / "app/build.gradle"

if not strings.is_file() or not bg.is_file():
    print(f"::error::工程根不正确：{src} 下找不到 strings.xml 或 app/build.gradle")
    sys.exit(2)

changed = []

# 1) 应用名
t = strings.read_text(encoding="utf-8")
t2 = t.replace('name="app_name" translatable="false">DSHA<',
               'name="app_name" translatable="false">DSH Mobile<')
if t2 != t:
    strings.write_text(t2, encoding="utf-8"); changed.append("app_name")

# 2) 包名 + 可选 SDK 降级
g = bg.read_text(encoding="utf-8")
g2 = g.replace('applicationId "dsh.android.client"', 'applicationId "com.dshmobile.app"')
if g2 != g:
    changed.append("applicationId")
g = g2
if force_sdk:
    before = g
    g = g.replace("release(37)", f"release({force_sdk})").replace("targetSdk 37", f"targetSdk {force_sdk}")
    if g != before:
        changed.append(f"sdk->{force_sdk}")
bg.write_text(g, encoding="utf-8")

# 2b) 关闭自动更新（默认不检查 + 启动不主动检查）
cs = src / "app/src/main/java/com/deepseekharness/app/core/ConfigStore.java"
if cs.is_file():
    t = cs.read_text(encoding="utf-8")
    t2 = t.replace("return flag(Constants.KEY_CHECK_UPDATE, true);",
                   "return flag(Constants.KEY_CHECK_UPDATE, false);")
    if t2 != t:
        cs.write_text(t2, encoding="utf-8"); changed.append("autoUpdate-check-off")
ma = src / "app/src/main/java/com/deepseekharness/app/ui/MainActivity.java"
if ma.is_file():
    t = ma.read_text(encoding="utf-8")
    t2 = t.replace("startupUpdates.checkOnStartup(config.isCheckUpdate());",
                   "startupUpdates.checkOnStartup(false);")
    if t2 != t:
        ma.write_text(t2, encoding="utf-8"); changed.append("autoUpdate-startup-off")

# 3) 内置同步引擎（默认不放进 assets，避免触发运行时资产清单校验失败）
#    需要随包时设 BUNDLE_SYNC=1
if os.environ.get("BUNDLE_SYNC") == "1" and sync and sync.is_file():
    dst = src / "app/src/main/assets/dsh-sync"
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "sync.mjs").write_bytes(sync.read_bytes())
    changed.append("sync.mjs")

# 4) 校验最终状态（幂等；二次运行也通过）
final_strings = strings.read_text(encoding="utf-8")
final_bg = bg.read_text(encoding="utf-8")
if ">DSH Mobile<" not in final_strings:
    print("::error::app_name 未变为 DSH Mobile"); sys.exit(3)
if 'applicationId "com.dshmobile.app"' not in final_bg:
    print("::error::applicationId 未变为 com.dshmobile.app"); sys.exit(4)
if force_sdk and (f"release({force_sdk})" not in final_bg or f"targetSdk {force_sdk}" not in final_bg):
    print(f"::error::SDK 未降级到 {force_sdk}"); sys.exit(5)

# 5) 替换启动图标（若提供 ICONS_DIR）
icons = os.environ.get("ICONS_DIR")
if icons:
    import shutil
    res = src / "app/src/main/res"
    src_icons = pathlib.Path(icons)
    n = 0
    for f in src_icons.rglob("*"):
        if f.is_file():
            dst = res / f.relative_to(src_icons)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(f.read_bytes()); n += 1
    # 旧的 vector 前景会和新的 png 前景同名冲突，删掉
    old_fg = res / "drawable/dsha_launcher_foreground.xml"
    if old_fg.is_file():
        old_fg.unlink()
    if not (res / "mipmap-xxxhdpi/ic_launcher.png").is_file():
        print("::error::图标未安装成功"); sys.exit(6)
    changed.append(f"icons({n})")

print("APPLIED:", changed, "| FORCE_SDK=", force_sdk or "(none)")
