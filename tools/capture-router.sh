#!/bin/sh
# Только чтение постоянного состояния. Временные файлы находятся в закрытом /tmp.
set -eu
umask 077
stage="$(mktemp -d /tmp/cyberrouter-capture.XXXXXX)"
trap 'rm -rf "$stage"' HUP INT TERM
ubus call system board >"$stage/board.json"
apk info -v >"$stage/packages.txt" 2>"$stage/package-warnings.txt"
apk info >"$stage/package-names.txt" 2>/dev/null
cp /etc/apk/world "$stage/world.txt"
date -Iseconds >"$stage/captured-at.txt"
ls -l /etc/rc.d >"$stage/autostart.txt"
ubus call service list >"$stage/services.json"
ip address show >"$stage/addresses.txt"
ip route show table all >"$stage/routes.txt"
nft list ruleset >"$stage/firewall-runtime.txt"
cat /proc/mounts >"$stage/mounts.txt"
sysupgrade -b "$stage/sysupgrade.tar.gz" >"$stage/sysupgrade.log" 2>&1
tar -czf "$stage/rom.tar.gz" -C /rom . 2>"$stage/rom-tar.log"

# Общая блокировка исключает смешивание основного и резервных Xray-профилей.
exec 9>/var/lock/xray-profile.lock
flock -x 9
for item in /* /.[!.]*; do
 [ -e "$item" ] || [ -L "$item" ] || continue
 case "$item" in /dev|/proc|/sys|/tmp|/run|/overlay|/rom|/mnt) continue;; esac
 printf '%s\n' "${item#/}" >>"$stage/root-items.txt"
done
tar -czf "$stage/rootfs.tar.gz" -C / -T "$stage/root-items.txt" 2>"$stage/rootfs-tar.log"
tar -czf "$stage/upper.tar.gz" -C /overlay/upper . 2>"$stage/upper-tar.log"
flock -u 9
exec 9>&-
printf '%s\n' "$stage"
