#!/usr/bin/env bash
#
# build-rpm.sh — 把发行 tar.zst 重打包成 x86_64 RPM
#
# 输入（先跑 build-release.sh 得到，或直接下载 Release 产物）：
#   dist-release/dsh-desktop-<ver>-linux-x64.tar.zst
# 产出：
#   dist-release/dsh-desktop-<ver>-<rel>.x86_64.rpm
#   dist-release/dsh-desktop-<ver>-<rel>.x86_64.rpm.sha256
#
# 用法：
#   ./build-rpm.sh                              # 打包当前 VERSION
#   VERSION=0.9.3 ./build-rpm.sh                # 指定版本
#   RELEASE_NO=2 ./build-rpm.sh                 # 同版本重发（spec 修订号）
#   TARBALL=/path/to/xxx.tar.zst ./build-rpm.sh # 用别处的 tar.zst
#
# 与 build-release.sh 的关系：本地和 CI 调用同一个脚本；
# 本脚本不编译，只做安装布局（见 rpm/dsh-desktop.spec.in）。
set -euo pipefail

VERSION="${VERSION:-0.9.2}"
RELEASE_NO="${RELEASE_NO:-1}"
WORKDIR="${WORKDIR:-$PWD/.build}"
OUTDIR="${OUTDIR:-$PWD/dist-release}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PKG="dsh-desktop-$VERSION-linux-x64"
TARBALL="${TARBALL:-$OUTDIR/$PKG.tar.zst}"
RPM="$OUTDIR/dsh-desktop-$VERSION-$RELEASE_NO.x86_64.rpm"
RPMBUILD_DIR="$WORKDIR/rpmbuild"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

for c in rpmbuild tar zstd sed; do
  command -v "$c" >/dev/null 2>&1 || die "缺少命令：$c"
done

[[ -f "$TARBALL" ]] || die "找不到 $TARBALL —— 先跑 ./build-release.sh（或下载 Release 产物后用 TARBALL= 指定）"

log "准备 rpmbuild 工作树"
rm -rf "$RPMBUILD_DIR"
mkdir -p "$RPMBUILD_DIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
cp "$TARBALL" "$RPMBUILD_DIR/SOURCES/$PKG.tar.zst"

log "渲染 spec（v$VERSION-$RELEASE_NO）"
sed -e "s/@VERSION@/$VERSION/g" \
    -e "s/@RELEASE_NO@/$RELEASE_NO/g" \
    rpm/dsh-desktop.spec.in > "$RPMBUILD_DIR/SPECS/dsh-desktop.spec"

log "rpmbuild -bb"
rpmbuild -bb --define "_topdir $RPMBUILD_DIR" \
  "$RPMBUILD_DIR/SPECS/dsh-desktop.spec"

built="$(find "$RPMBUILD_DIR/RPMS" -name '*.rpm' -print -quit)"
[[ -n "$built" ]] || die "rpmbuild 没有产出 .rpm"

rm -f "$RPM"
cp "$built" "$RPM"

log "计算校验和"
( cd "$OUTDIR" && sha256sum "$(basename "$RPM")" > "$(basename "$RPM").sha256" )

cat <<EOF

完成。

  产物 : $RPM  ($(du -h "$RPM" | cut -f1))
  校验 : $(cat "$RPM.sha256")

安装（Fedora / RHEL）: sudo dnf install ./$(basename "$RPM")
安装（openSUSE）    : sudo zypper install ./$(basename "$RPM")
EOF
