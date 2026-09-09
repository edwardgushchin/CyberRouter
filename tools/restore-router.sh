#!/bin/sh
# Установка только на заменяемый чистый роутер; текущие службы не перезапускаются.
set -eu
umask 077
cd "$(dirname "$0")"
stage="$PWD"
sha256sum -c SHA256SUMS >/dev/null
. ./board.env
[ "${1:-}" = '--apply' ] || { echo 'Use --apply after reviewing the recovery plan'; exit 2; }
[ "$(jsonfilter -s "$(ubus call system board)" -e '@.board_name')" = "$EXPECTED_BOARD" ]
[ "$(jsonfilter -s "$(ubus call system board)" -e '@.release.version')" = "$EXPECTED_VERSION" ]
[ "$(jsonfilter -s "$(ubus call system board)" -e '@.release.revision')" = "$EXPECTED_REVISION" ]
[ "$(uname -r)" = "$EXPECTED_KERNEL" ]
[ ! -e /etc/xray/config.json ] && [ ! -e /etc/mobile-backup ] || {
 echo 'Refusing to overwrite an already configured router'; exit 1;
}
required_kb="$(gzip -dc restore.tar.gz | wc -c)"
required_kb="$((required_kb / 1024 + 32768))"
available_kb="$(df -k /overlay | awk 'END {print $4}')"
[ "$available_kb" -gt "$required_kb" ] || { echo 'Insufficient overlay space'; exit 1; }
sysupgrade -b ./before-restore.tar.gz >./before-restore.log 2>&1

# Имена получены из различия исходного /rom и живой ФС, а не из произвольного списка.
while IFS= read -r name; do
 case "$name" in ''|/*|..|../*|*/../*|*/..) echo 'Invalid deletion path'; exit 1;; esac
 case "$name" in etc/*|usr/*|lib/*|bin/*|sbin/*|opt/*|www/*|root/*|srv/*) ;;
  *) echo 'Unexpected deletion scope'; exit 1;; esac
done <deleted.txt
while IFS= read -r name; do rm -rf "/$name"; done <deleted.txt
tar -xzf restore.tar.gz -C /
(cd / && sha256sum -c "$stage/files.sha256" >/dev/null)
for config in /etc/xray/profiles/*.json; do
 /usr/bin/xray run -test -c "$config" >./xray-validation.log 2>&1
done
/usr/bin/xray run -test -c /etc/xray/config.json >>./xray-validation.log 2>&1
sync
echo 'Overlay, packages, service links and settings restored; file hashes and Xray configurations verified.'
echo 'Network activation requires an explicit reboot of this replacement router.'
