#!/usr/bin/env python3
"""把「DSH Mobile」自定义套到官方 DSHA 源码包上（CI 用）。
   argv[1] = 解压后的官方源码根目录
   argv[2] = 本仓库里的 sync.mjs 路径（可选）
"""
import sys, io, pathlib

src = pathlib.Path(sys.argv[1])
sync = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
changed = []

# 1) 应用名
strings = src / "app/src/main/res/values/strings.xml"
if strings.is_file():
    t = strings.read_text(encoding="utf-8")
    t2 = t.replace('name="app_name" translatable="false">DSHA<',
                   'name="app_name" translatable="false">DSH Mobile<')
    if t2 != t:
        strings.write_text(t2, encoding="utf-8")
        changed.append("app_name -> DSH Mobile")

# 2) 包名（独立 App 身份）
bg = src / "app/build.gradle"
if bg.is_file():
    t = bg.read_text(encoding="utf-8")
    t2 = t.replace('applicationId "dsh.android.client"', 'applicationId "com.dshmobile.app"')
    if t2 != t:
        bg.write_text(t2, encoding="utf-8")
        changed.append("applicationId -> com.dshmobile.app")

# 3) 内置同步引擎到 APK assets
if sync and sync.is_file():
    dst_dir = src / "app/src/main/assets/dsh-sync"
    dst_dir.mkdir(parents=True, exist_ok=True)
    (dst_dir / "sync.mjs").write_bytes(sync.read_bytes())
    changed.append("bundled assets/dsh-sync/sync.mjs")

if not strings.is_file() or not bg.is_file():
    print(f"::error::工程根不正确：{src} 下找不到 app/src/main/res/values/strings.xml 或 app/build.gradle")
    sys.exit(2)
if "app_name -> DSH Mobile" not in changed:
    print("::error::app_name 未改成功（strings.xml 里没匹配到 DSHA）")
    sys.exit(3)
if "applicationId -> com.dshmobile.app" not in changed:
    print("::error::applicationId 未改成功（build.gradle 里没匹配到 dsh.android.client）")
    sys.exit(4)

print("APPLIED:", changed)
