#!/bin/sh
# Run the real control loop with synthetic probe results and harmless actions.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export MOBILE_BACKUP_RUN="$scratch/run" MOBILE_BACKUP_BASE="$scratch/base"
mkdir -p "$MOBILE_BACKUP_BASE"
set -- status
. "$root/mobile-backup.sh" >/dev/null
link_state() { return 0; }
refresh_probes() { :; }
release_wifi() { echo "$round:$1" >> "$scratch/releases"; }
event() { :; }
nft() { return 0; }
dns_mode() { return 0; }
proxy_ok() { return 0; }
find_provider() { echo "provider:$round" >> "$scratch/actions"; return 0; }
normal() { echo normal > "$RUN/mode"; echo "normal:$round" >> "$scratch/actions"; }
activate() { echo bypass > "$RUN/mode"; echo "bypass:$round" >> "$scratch/actions"; }
select_link() { echo "$1" > "$RUN/uplink"; }
probe_link() {
    if [ "$1" = wan ]; then
        if [ "$round" -ge 14 ]; then echo '3 2'; else echo '0 0'; fi
    elif [ "$round" -le 3 ]; then echo '2 2' # One external site fails: stay direct.
    elif [ "$round" -eq 4 ]; then echo '0 2' # One limited round: stay direct.
    elif [ "$round" -eq 5 ]; then echo '3 2' # Reset the limited streak.
    elif [ "$round" -le 8 ]; then echo '0 2' # Third limited round enters bypass.
    elif [ "$round" -le 10 ]; then echo '0 0' # Outage must not count as recovery.
    else echo '3 2'; fi # Fourth open round exits bypass; third WAN round returns WAN.
}
sleep() {
    if [ "$round" -eq 3 ] || [ "$round" -eq 5 ] || [ "$round" -eq 7 ]; then
        [ "$(cat "$RUN/mode")" = normal ] || exit 10
    fi
    if [ "$round" -eq 8 ] || [ "$round" -eq 10 ] || [ "$round" -eq 13 ]; then
        [ "$(cat "$RUN/mode")" = bypass ] || exit 11
    fi
    if [ "$round" -eq 14 ]; then [ "$(cat "$RUN/mode")" = normal ] || exit 12; fi
    if [ "$round" -eq 15 ]; then [ "$(cat "$RUN/uplink")" = wwan ] || exit 13; fi
    if [ "$round" -eq 16 ]; then [ "$(cat "$RUN/uplink")" = wwan ] || exit 14; exit 0; fi
    round=$((round+1))
}
round=1
echo normal > "$RUN/mode"
echo wwan > "$RUN/uplink"
echo wwan > "$BASE/source"
(daemon)
expected=$(printf 'provider:8\nbypass:8\nnormal:14')
[ "$(cat "$scratch/actions")" = "$expected" ]
[ ! -s "$scratch/releases" ]
echo 'controller: 16 rounds passed (quorum, streak reset, entry, outage, recovery, no automatic WAN switch)'

# Manual source and bypass policy are independent, including a missing Wi-Fi link.
: > "$scratch/actions"
round=1
echo normal > "$RUN/mode"
echo wan > "$RUN/uplink"
echo bypass > "$BASE/policy"
echo wan > "$BASE/source"
probe_link() {
    if [ "$1" = wan ]; then echo '3 2'; else echo '0 2'; fi
}
link_state() { if [ "$1" = wwan ] && [ "$round" -eq 6 ]; then return 1; fi; return 0; }
sleep() {
    case "$round" in
        1) [ "$(cat "$RUN/mode")" = normal ] && [ "$(cat "$RUN/uplink")" = wan ] || exit 20
           echo wwan > "$BASE/source";;
        2) [ "$(cat "$RUN/mode")" = bypass ] && [ "$(cat "$RUN/uplink")" = wwan ] || exit 21
           echo direct > "$BASE/policy";;
        3) [ "$(cat "$RUN/mode")" = normal ] && [ "$(cat "$RUN/uplink")" = wwan ] || exit 22
           echo wan > "$BASE/source";;
        4) [ "$(cat "$RUN/uplink")" = wan ] || exit 23
           echo bypass > "$BASE/policy";;
        5) [ "$(cat "$RUN/mode")" = normal ] && [ "$(cat "$RUN/uplink")" = wan ] || exit 24
           echo wwan > "$BASE/source";;
        6) [ "$(cat "$RUN/mode")" = normal ] && [ "$(cat "$RUN/uplink")" = wwan ] || exit 25; exit 0;;
    esac
    round=$((round+1))
}
(daemon)
expected=$(printf 'provider:2\nbypass:2\nnormal:3')
[ "$(cat "$scratch/actions")" = "$expected" ]
[ "$(cat "$scratch/releases")" = "$(printf '1:wired\n4:wired\n5:wired')" ]
echo 'manual source: 6 rounds passed (wired ignores bypass, manual Wi-Fi, direct policy, no fallback)'

# A disconnected manually selected uplink must mask other DHCP defaults.
(
    . "$root/mobile-backup.sh" >/dev/null
    ip() { printf '%s\n' "$*" > "$scratch/ip-command"; }
    rm -f "$RUN/wwan.route"
    select_link wwan
    [ "$(cat "$scratch/ip-command")" = 'route replace blackhole default metric 5' ]
    [ "$(cat "$RUN/link-state")" = disconnected ]
    echo 'manual source: missing link masks other defaults'
)

# A lost phone must release its radio after three rounds without selecting WAN.
round=1
: > "$scratch/releases"
echo wwan > "$BASE/source"
echo auto > "$BASE/policy"
echo normal > "$RUN/mode"
link_state() { [ "$1" = wan ]; }
sleep() {
    [ "$(cat "$RUN/uplink")" = wwan ] || exit 30
    if [ "$round" -eq 3 ]; then exit 0; fi
    round=$((round+1))
}
(daemon)
[ "$(cat "$scratch/releases")" = '3:lost' ]
echo 'radio guard: missing phone releases STA after 3 rounds; source stays Wi-Fi'
