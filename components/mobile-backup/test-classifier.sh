#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export MOBILE_BACKUP_RUN="$scratch"
for scenario in '3 2 open' '2 0 open' '0 2 limited' '0 1 limited' '0 0 offline' '1 2 limited' '1 0 uncertain'; do
    set -- $scenario
    actual=$(sh "$root/mobile-backup.sh" classify "$1" "$2")
    [ "$actual" = "$3" ] || { echo "wrong classification: $scenario" >&2; exit 1; }
done
echo 'classifier: 7 scenarios passed'
