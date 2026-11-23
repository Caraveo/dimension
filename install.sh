#!/bin/sh
set -eu

# Run as your desktop user. Elevation is only required for the package install.
version=0.0.3
artifact="dimension_${version}_all.deb"
base="https://github.com/caraveo/dimension/releases/download/v$version"

if ! command -v apt-get >/dev/null 2>&1; then
    printf '%s\n' 'Dimension requires Ubuntu or a compatible Debian-based Linux system.' >&2
    exit 1
fi

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
curl --fail --silent --show-error --location --retry 3 "$base/$artifact" -o "$temporary/$artifact"
curl --fail --silent --show-error --location --retry 3 "$base/$artifact.sha256" -o "$temporary/$artifact.sha256"
(cd "$temporary" && sha256sum --check --strict "$artifact.sha256")
chmod 755 "$temporary"

if [ "$(id -u)" = 0 ]; then
    apt-get install -y "$temporary/$artifact"
else
    sudo apt-get install -y "$temporary/$artifact"
fi

# User defaults take precedence over system defaults in Linux desktop environments.
# Run this after installation as the person who launched the installer.
if [ "$(id -u)" != 0 ]; then
    types=$(sed -n 's/^MimeType=//p' /usr/share/applications/io.github.caraveo.Dimension.desktop | tr ';' ' ')
    # The desktop entry supplies whitespace-free MIME identifiers.
    # shellcheck disable=SC2086
    xdg-mime default io.github.caraveo.Dimension.desktop $types
fi

printf '%s\n' 'Dimension is installed. Launch it from Applications or double-click a supported model.'
