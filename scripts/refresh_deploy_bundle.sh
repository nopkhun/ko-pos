#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
zip_path=${1:-"$repo_dir/../deploy-secrets.zip"}
compose_entry="deploy_real/vps-compose-simplified.yaml"
temp_dir=$(mktemp -d /tmp/ko-pos-compose-refresh.XXXXXX)

case "$zip_path" in
    /*) ;;
    *) zip_path=$(CDPATH= cd -- "$(dirname "$zip_path")" && pwd)/$(basename "$zip_path") ;;
esac

cleanup() {
    find "$temp_dir" -depth -delete
}
trap cleanup EXIT HUP INT TERM

unzip -q "$zip_path" -d "$temp_dir"
openssl base64 -A -in "$repo_dir/addons.tar.gz" -out "$temp_dir/addons.tar.gz.b64"

COMPOSE_PATH="$temp_dir/$compose_entry" \
B64_PATH="$temp_dir/addons.tar.gz.b64" \
perl -0777 -i -pe '
    BEGIN {
        open my $fh, "<", $ENV{B64_PATH} or die $!;
        local $/;
        $bundle = <$fh>;
        close $fh;
    }
    s{(cat <<'"'"'TAR_EOF'"'"' \| base64 -d \| tar xzf - -C /mnt/extra-addons\n).*?\n\s*TAR_EOF}{$1        $bundle\n        TAR_EOF}s
        or die "inline tar marker not found\n";
' "$temp_dir/$compose_entry"

source_sha=$(shasum -a 256 "$repo_dir/addons.tar.gz" | awk '{print $1}')
embedded_sha=$(sed -n '40p' "$temp_dir/$compose_entry" | sed 's/^        //' | base64 -d | shasum -a 256 | awk '{print $1}')
if [ "$source_sha" != "$embedded_sha" ]; then
    echo "embedded bundle checksum mismatch" >&2
    exit 1
fi

DB_PASSWORD=validation-only \
TRAEFIK_HOST=validation.invalid \
docker compose -f "$temp_dir/$compose_entry" config -q

(
    cd "$temp_dir"
    zip -q -r "$zip_path" deploy_real
)
unzip -tq "$zip_path" >/dev/null
printf 'deploy bundle refreshed: %s\n' "$source_sha"
