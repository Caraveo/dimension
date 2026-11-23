#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
version=$(cat "$root/VERSION")
output=${1:-"$root/dist"}
mkdir -p "$output"
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
trap 'exit 1' HUP INT TERM
chmod 755 "$build"

install -d "$build/DEBIAN" "$build/usr/bin" "$build/usr/lib/dimension" \
    "$build/usr/share/applications" "$build/usr/share/mime/packages" "$build/usr/share/doc/dimension"
cat > "$build/DEBIAN/control" <<CONTROL
Package: dimension
Version: $version
Section: graphics
Priority: optional
Architecture: all
Maintainer: Caraveo <caraveo@users.noreply.github.com>
Depends: python3, python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1, shared-mime-info, desktop-file-utils
Homepage: https://github.com/caraveo/dimension
Description: Standalone 3D model viewer with studio lighting
 Dimension previews local 3D models in a native GTK window with wireframe,
 studio lighting and bloom. It includes offline decoders for common formats.
CONTROL

install -m 755 "$root/packaging/postinst" "$root/packaging/prerm" "$build/DEBIAN/"
install -m 755 "$root/packaging/dimension" "$build/usr/bin/dimension"
install -m 755 "$root/dimension.py" "$root/packaging/mime-defaults.py" "$build/usr/lib/dimension/"
cp -R "$root/ui" "$build/usr/lib/dimension/"
install -m 644 "$root/packaging/io.github.caraveo.Dimension.desktop" "$build/usr/share/applications/"
install -m 644 "$root/packaging/io.github.caraveo.Dimension.xml" "$build/usr/share/mime/packages/"
install -m 644 "$root/README.md" "$build/usr/share/doc/dimension/"
install -m 644 "$root/ui/vendor/LICENSE" "$build/usr/share/doc/dimension/copyright"

artifact="dimension_${version}_all.deb"
dpkg-deb --root-owner-group --build "$build" "$output/$artifact"
(cd "$output" && sha256sum "$artifact" > "$artifact.sha256")
