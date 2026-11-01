#!/usr/bin/env bash
#
# 京韵大富翁 · 胡同漫游记 —— 触屏终端安装包构建脚本
#
# 手工调用 Android SDK 工具链完成构建，不依赖 Gradle / Kotlin / AndroidX，
# 也不向系统目录写入任何文件。所有中间产物都在临时目录里，可随时删除。
#
# 用法:
#   ./tools/build_android_webview.sh            仅构建 APK
#   ./tools/build_android_webview.sh --install  构建后通过无线 ADB 安装到终端
#                                               （Tailscale 链路优先，局域网 MAC 兜底，均不依赖 IP）
#   ./tools/build_android_webview.sh --tailnet [--fix]
#                                               自检 Mac↔终端的 Tailscale 链路；
#                                               加 --fix 则自动修复可自动化的部分
#                                               （拉起 App / 设为常开 VPN / 安装缺失的 Tailscale）
# 环境变量:
#   JYM_DEVICE=ip:5555          手动指定终端地址（跳过自动定位）
#   JYM_TAILNET_IP / _HOST      终端在 tailnet 里的地址 / 设备名
#   JYM_TAILSCALE_APK=/path.apk 配合 --tailnet --fix：终端缺失 Tailscale 时用它安装
# 断链修复流程与授权码生成，见《触屏终端Tailscale接入手册》:
#   /Users/sevensimle/Documents/@西北人的成长/10-Projects/个人项目/童领计划/京韵大富翁_胡同漫游记/10_技术运维/触屏终端Tailscale接入手册.md
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
SRC_DIR="$ANDROID_DIR/app/src/main"
MANIFEST="$SRC_DIR/AndroidManifest.xml"
JAVA_SRC="$SRC_DIR/java"
RES_DIR="$SRC_DIR/res"

BUILD_ROOT="${JYM_BUILD_ROOT:-/tmp/jym-build}"
JDK_HOME="${JAVA_HOME:-$BUILD_ROOT/jdk-17.0.21+9/Contents/Home}"
SDK_ROOT="${ANDROID_SDK_ROOT:-$BUILD_ROOT/android-sdk}"
BUILD_TOOLS="$SDK_ROOT/build-tools/33.0.2"
PLATFORM_JAR="$SDK_ROOT/platforms/android-33/android.jar"

# d8 / apksigner 本身是 Java 启动脚本，内部会调用 PATH 里的 java
export JAVA_HOME="$JDK_HOME"
export PATH="$JDK_HOME/bin:$PATH"

OUT_DIR="$ANDROID_DIR/build"
APK_NAME="jingyun-monopoly-debug.apk"

# 应用版本号：三处必须一致 —— 这里、AndroidManifest.xml、public/src/ui/theme.js 的 APP_VERSION。
APP_VERSION="${JYM_APP_VERSION:-1.0.0}"
APP_VERSION_CODE="${JYM_APP_VERSION_CODE:-11}"

# ---- 触屏终端链路（Tailscale 优先，局域网 MAC 兜底）--------------------------
# 终端换网络会换 IP，所以不认 IP、认身份：
#   ① 首选 Tailscale：只要终端在 tailnet 里在线，就直接连它的 100.x 地址，跨网段/换路由都不受影响；
#   ② 兜底局域网：同网段时按 MAC 从 ARP 表反查 IP；
#   ③ 最后可 JYM_DEVICE=ip:5555 手动指定。
# 命中后一律用序列号校验确实是这台机器。以下都可用环境变量覆盖。
DEVICE_MAC="${JYM_DEVICE_MAC:-00:0a:f5:d4:85:56}"   # 终端 wlan0 硬件地址
DEVICE_SERIAL="${JYM_DEVICE_SERIAL:-972a704d}"       # 终端 ro.serialno
ADB_PORT="${JYM_ADB_PORT:-5555}"
TAILNET_HOST="${JYM_TAILNET_HOST:-dc-jav-flip}"      # 终端在 tailnet 里的设备名
TAILNET_IP="${JYM_TAILNET_IP:-100.112.156.93}"       # 终端在 tailnet 里的 100.x 地址
TAILSCALE_PKG="com.tailscale.ipn"

local_ip() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null
}

# macOS 没有 timeout 命令，用「后台跑 + 到点 kill」实现简易超时，避免 adb 卡死整个脚本。
with_timeout() {
  local t="$1"; shift
  local out; out="$(mktemp)"
  "$@" >"$out" 2>/dev/null &
  local pid=$! watcher rc=0
  ( sleep "$t"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  cat "$out"; rm -f "$out"
  return $rc
}

# 找到 Mac 上的 tailscale CLI（官方安装包放在 /usr/local/bin）
tailscale_cli() {
  if [[ -x /usr/local/bin/tailscale ]]; then echo /usr/local/bin/tailscale
  elif command -v tailscale >/dev/null 2>&1; then command -v tailscale
  else return 1; fi
}

# 终端是否在 tailnet 里在线（在线才值得走 100.x 链路；离线时该链路必然不通）
tailnet_online() {
  local ts line
  ts="$(tailscale_cli)" || return 1
  line="$("$ts" status 2>/dev/null | awk -v h="$TAILNET_HOST" '$2 == h')"
  [[ -n "$line" && "$line" != *offline* ]]
}

# ARP 表里的 MAC 不带前导零（0:a:f5:…），把目标 MAC 归一化后再匹配。
mac_pattern() {
  echo "$DEVICE_MAC" | awk -F: '{
    for (i = 1; i <= NF; i++) { sub(/^0+/, "", $i); if ($i == "") $i = "0"
      printf "%s%s", (i > 1 ? ":" : ""), $i }
  }'
}

# 在 ARP 表里按 MAC 反查 IP（最省事；ARP 条目是「IP ↔ 硬件地址」的对应）。
arp_lookup() {
  local pat hit
  pat="$(mac_pattern)"
  hit="$(arp -an | grep -i " at $pat " | head -1 | sed -E 's/.*\(([0-9.]+)\).*/\1/')"
  [[ -n "$hit" ]] && { echo "$hit:$ADB_PORT"; return 0; }
  return 1
}

# 泛洪 ping 一遍本网段（约数秒），触发二层 ARP 解析把设备写进 ARP 表。
# 设备是否屏蔽 ICMP 不影响 —— ARP 在二层应答，ping 不回包也能拿到 MAC。
sweep_arp() {
  local ip net
  ip="$(local_ip)" || return 1
  [[ -n "$ip" ]] || return 1
  net="${ip%.*}"
  for i in $(seq 1 254); do ping -c1 -W 300 "$net.$i" >/dev/null 2>&1 & done
  wait
}

# 按硬件身份找终端：先查 ARP 表，miss 就泛洪一遍再查。
find_by_mac() {
  arp_lookup && return 0
  sweep_arp || return 1
  arp_lookup
}

# 用序列号确认候选地址就是这台终端（先探活端口，再把 adb 操作限时，避免卡死）。
verify_device() {
  local addr="$1" host="${1%:*}" port="${1##*:}" sn
  nc -z -w 2 "$host" "$port" 2>/dev/null || return 1
  with_timeout 10 adb connect "$addr" >/dev/null 2>&1 || true
  sn="$(with_timeout 10 adb -s "$addr" shell getprop ro.serialno 2>/dev/null | tr -d '\r')"
  [[ "$sn" == "$DEVICE_SERIAL" ]]
}

# 选地址：显式 JYM_DEVICE 优先 → Tailscale 链路 → 局域网 MAC 自动发现。
resolve_device() {
  if [[ -n "${JYM_DEVICE:-}" ]]; then echo "$JYM_DEVICE"; return 0; fi
  # 先重置一次 adb 服务：本机偶发「服务刚起时首次 connect 失败」，重置后即恢复。
  with_timeout 10 adb kill-server >/dev/null 2>&1 || true
  with_timeout 10 adb start-server >/dev/null 2>&1 || true
  # ① Tailscale：跨网段也能用，是首选链路。
  if tailnet_online && verify_device "$TAILNET_IP:$ADB_PORT"; then
    echo "$TAILNET_IP:$ADB_PORT"; return 0
  fi
  # ② 兜底：同局域网时按 MAC 从 ARP 表反查。
  local cand
  cand="$(find_by_mac || true)"
  [[ -n "$cand" ]] && verify_device "$cand" && { echo "$cand"; return 0; }
  return 1
}

# ---- Tailscale 链路自检 / 修复 ----------------------------------------------
# --tailnet        只诊断，不改设备任何东西
# --tailnet --fix  诊断并自动修复可自动化的部分（拉起 App / 设常开 VPN / 装 Tailscale）
# 登录授权这一步必须人工给一次授权码：设备无浏览器、也不走 Google 账号。
print_authkey_guide() {
  cat <<'EOF'
  ── 重新授权（当 tailnet 里看不到终端时做这一步）────────────────────────────
   1. 电脑浏览器打开：https://login.tailscale.com/admin/settings/keys
   2. 点「Generate auth key…」→ 勾 Reusable（可反复用）→ 有效期按需（默认 90 天）
      · 页面上没有「Pre-approved」选项是正常的：它只在 tailnet 开了「设备审批」
        时才出现，没开时新设备本就自动批准。
   3. 复制生成的 tskey-auth-… 字串（只显示一次，务必先存好）。
   4. 到终端上把它填进去（终端无浏览器，走这条免浏览器路径）：
        终端「设置 ⚙」→「Accounts」→ 右上角「⋮」→「Use an auth key」→ 粘贴 → 「Add account」
   5. 回到电脑执行：  ./tools/build_android_webview.sh --tailnet
      看到 tailnet 里 dc-jav-flip 在线、且有接口持有 100.112.156.93 即为修好
      （接口名不固定，可能是 tun0 也可能是 tun1，认地址不认名字）。
  ────────────────────────────────────────────────────────────────────────
EOF
}

# 找持有 tailnet 地址的 VPN 接口名 —— 接口名不固定（实测有过 tun1，也有过 tun0），
# 所以按「哪个接口持有 100.x」来判，而不是写死名字。
# 注意字段是「地址/前缀长」形式（如 100.112.156.93/32），所以用前缀匹配而不是等值匹配。
dev_tun_if() {
  with_timeout 10 adb -s "$1" shell "ip -o -4 addr show" 2>/dev/null \
    | tr -d '\r' | awk -v ip="${TAILNET_IP}/" 'index($4, ip) == 1 { print $2 }' | head -1 || true
}

tailnet_doctor() {
  local fix="${1:-}" dev
  echo "== ① Mac 侧 =="
  local ts
  if ts="$(tailscale_cli)"; then
    echo "  CLI   : $ts"
    if "$ts" status >/dev/null 2>&1; then echo "  登录  : 已登录 tailnet"
    else echo "  登录  : 未登录 → 先执行  $ts up"; fi
  else
    echo "  CLI   : 未找到（应在 /usr/local/bin/tailscale）→ 先安装 Tailscale for macOS"
  fi
  if tailnet_online; then echo "  tailnet: ${TAILNET_HOST} 在线（${TAILNET_IP}）"
  else echo "  tailnet: 未见 $TAILNET_HOST 在线"; fi

  echo "== ② 设备链 =="
  if ! dev="$(resolve_device)"; then
    echo "  未连通。常见原因：Tailscale 授权过期/未登录 | 终端休眠或掉网 | 跨网段且 tailnet 掉线"
    echo "  已知地址时可直接指定： JYM_DEVICE=ip:5555 $0 --tailnet"
    print_authkey_guide
    return 1
  fi
  echo "  已连通: $dev"
  echo "  序列号: $(with_timeout 10 adb -s "$dev" shell getprop ro.serialno 2>/dev/null | tr -d '\r')"

  echo "== ③ 设备侧 Tailscale =="
  local installed running tun_if aovpn
  installed="$(with_timeout 10 adb -s "$dev" shell "pm list packages $TAILSCALE_PKG" 2>/dev/null | grep -c "$TAILSCALE_PKG" || true)"
  # 判「服务在跑」用 pidof：早先按 dumpsys … grep 'isForeground=true' 判，
  # 但 Android 13 的 dumpsys 里没有这个字段 —— 隧道明明正常也会误报「否」
  # （2026-11-01 加固后重启复验时发现，已订正）。
  running="$(with_timeout 10 adb -s "$dev" shell "pidof $TAILSCALE_PKG" 2>/dev/null | tr -d '\r')"
  tun_if="$(dev_tun_if "$dev")"
  aovpn="$(with_timeout 10 adb -s "$dev" shell "settings get secure always_on_vpn_app" 2>/dev/null | tr -d '\r')"
  echo "  App 已装 : $([[ "$installed" -gt 0 ]] && echo 是 || echo 否)"
  echo "  服务运行 : $([[ -n "$running" ]] && echo 是 || echo 否)"
  echo "  隧道接口 : ${tun_if:-无}（应为 ${TAILNET_IP}）"
  echo "  常开VPN  : ${aovpn:-null}"

  if [[ -n "$tun_if" ]]; then
    echo "== 结论：链路健康 =="
    return 0
  fi

  echo "== 结论：链路未就绪 =="
  if [[ "$fix" != "--fix" ]]; then
    echo "  加 --fix 可自动修复（安装/拉起 App、设为常开 VPN）；授权过期需人工码，见下方指引。"
    print_authkey_guide
    return 1
  fi
  echo "-- 自动修复中 --"
  if [[ "${installed:-0}" -eq 0 ]]; then
    if [[ -n "${JYM_TAILSCALE_APK:-}" && -f "${JYM_TAILSCALE_APK}" ]]; then
      echo "  安装 Tailscale: $JYM_TAILSCALE_APK"
      adb -s "$dev" install -r -d "$JYM_TAILSCALE_APK" || true
    else
      echo "  终端未装 Tailscale。请设 JYM_TAILSCALE_APK=/path/com.tailscale.ipn.apk 后重跑。"
    fi
  fi
  # 注意：重启后 Tailscale 不会自启（实测），必须靠「常开 VPN」让系统在开机时把它拉起。
  echo "  设为常开 VPN（这是重启后能自动建隧道的关键）"
  with_timeout 10 adb -s "$dev" shell "settings put secure always_on_vpn_app $TAILSCALE_PKG" >/dev/null 2>&1 || true
  with_timeout 10 adb -s "$dev" shell "settings put secure always_on_vpn_lockdown 0" >/dev/null 2>&1 || true
  with_timeout 10 adb -s "$dev" shell "dumpsys deviceidle whitelist +$TAILSCALE_PKG" >/dev/null 2>&1 || true
  echo "  拉起 Tailscale App"
  with_timeout 15 adb -s "$dev" shell monkey -p "$TAILSCALE_PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  sleep 5
  tun_if="$(dev_tun_if "$dev")"
  if [[ -n "$tun_if" ]]; then echo "== 修复完成：隧道 $tun_if = $TAILNET_IP =="; return 0; fi
  echo "== 仍未建立隧道 —— 多半是授权过期，按下面走一次授权：=="
  print_authkey_guide
  return 1
}

if [[ "${1:-}" == "--tailnet" ]]; then
  tailnet_doctor "${2:-}"
  exit $?
fi

# ---- 构建 APK（--tailnet 纯链路操作，不会走到这里）---------------------------
for tool in \
  "$JDK_HOME/bin/javac" "$JDK_HOME/bin/jar" "$JDK_HOME/bin/keytool" \
  "$BUILD_TOOLS/aapt2" "$BUILD_TOOLS/d8" "$BUILD_TOOLS/zipalign" "$BUILD_TOOLS/apksigner" \
  "$PLATFORM_JAR"; do
  if [[ ! -e "$tool" ]]; then
    echo "缺少构建组件: $tool" >&2
    exit 1
  fi
done

WORK="$BUILD_ROOT/work"
rm -rf "$WORK"
mkdir -p "$WORK/classes" "$WORK/dex" "$WORK/assets" "$OUT_DIR"

echo "==> 1/6 同步前端产物到 assets"
cp -R "$ROOT/public/." "$WORK/assets/"
find "$WORK/assets" -name '.DS_Store' -delete

echo "==> 2/6 编译 Java 源码"
find "$JAVA_SRC" -name '*.java' > "$WORK/sources.txt"
"$JDK_HOME/bin/javac" -encoding UTF-8 -nowarn -source 11 -target 11 \
  -classpath "$PLATFORM_JAR" -d "$WORK/classes" @"$WORK/sources.txt"

echo "==> 3/6 生成 classes.dex"
( cd "$WORK/classes" && "$JDK_HOME/bin/jar" cf "$WORK/classes.jar" . )
"$BUILD_TOOLS/d8" --min-api 24 --lib "$PLATFORM_JAR" \
  --output "$WORK/dex" "$WORK/classes.jar"

echo "==> 4/6 打包清单、资源与 assets"
# 图标等 res/ 资源先编译成 .flat 包，再交给 link 打进 APK
"$BUILD_TOOLS/aapt2" compile --dir "$RES_DIR" -o "$WORK/res.zip"
"$BUILD_TOOLS/aapt2" link -o "$WORK/base.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$MANIFEST" \
  -A "$WORK/assets" \
  "$WORK/res.zip" \
  --min-sdk-version 24 --target-sdk-version 33 \
  --version-code "$APP_VERSION_CODE" --version-name "$APP_VERSION"

( cd "$WORK/dex" && zip -q -X "$WORK/base.apk" classes.dex )

echo "==> 5/6 对齐并签名"
"$BUILD_TOOLS/zipalign" -f -p 4 "$WORK/base.apk" "$WORK/aligned.apk"
# keystore 固化在工程目录，保证每次构建签名一致，设备上可增量覆盖安装。
KEYSTORE="$ANDROID_DIR/debug.keystore"
if [[ ! -e "$KEYSTORE" ]]; then
  "$JDK_HOME/bin/keytool" -genkeypair -keystore "$KEYSTORE" -alias jym \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass android -keypass android \
    -dname "CN=JingYunMonopoly, OU=Dev, O=SevenSmile, L=Beijing, C=CN" >/dev/null 2>&1
fi
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" \
  --ks-pass pass:android --key-pass pass:android --ks-key-alias jym \
  --out "$OUT_DIR/$APK_NAME" "$WORK/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --print-certs "$OUT_DIR/$APK_NAME" >/dev/null

echo "==> 6/6 构建完成: $OUT_DIR/$APK_NAME"
ls -lh "$OUT_DIR/$APK_NAME"

if [[ "${1:-}" == "--install" ]]; then
  PKG="com.sevensmile.jingyunmonopoly"
  echo "==> 定位触屏终端（Tailscale ${TAILNET_IP} / MAC ${DEVICE_MAC} / S-N ${DEVICE_SERIAL}）"
  if ! DEVICE="$(resolve_device)"; then
    echo "未找到终端：请确认 ① 终端已唤醒（休眠会关掉无线调试端口）② Tailscale 链路正常。" >&2
    echo "  排查/修复： ./tools/build_android_webview.sh --tailnet [--fix]" >&2
    echo "  或手动指定： JYM_DEVICE=ip:5555 ./tools/build_android_webview.sh --install" >&2
    exit 1
  fi
  echo "==> 命中终端 ${DEVICE}，开始安装"
  # 首次安装或历史上用过不同签名时，先卸载旧包再装，避免签名冲突。
  if ! adb -s "$DEVICE" install -r "$OUT_DIR/$APK_NAME"; then
    echo "==> 签名冲突，卸载旧包后重装"
    adb -s "$DEVICE" uninstall "$PKG" >/dev/null 2>&1 || true
    adb -s "$DEVICE" install "$OUT_DIR/$APK_NAME"
  fi
fi
