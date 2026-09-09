#!/bin/sh
# OpenWrt manual uplink and automatic mobile bypass. Only the secondary proxy and its own nft table change.
set -u
BASE=${MOBILE_BACKUP_BASE:-/etc/mobile-backup}
RUN=${MOBILE_BACKUP_RUN:-/var/run/mobile-backup}
mkdir -p "$RUN"
chmod 700 "$RUN"

# ponytail: endpoint quorum is a heuristic, not proof of the operator's policy.
# Require independent services and consecutive rounds; add endpoints if needed.
classify() {
    if [ "$1" -ge 2 ]; then echo open
    elif [ "$1" -le 1 ] && [ "$2" -ge 1 ]; then echo limited
    elif [ "$1" -eq 0 ] && [ "$2" -eq 0 ]; then echo offline
    else echo uncertain; fi
}

refresh_probes() {
    local now last gateway dev group host path expected addresses fresh
    now=$(date +%s)
    last=$(cat "$RUN/probes-refreshed" 2>/dev/null || echo 0)
    [ $((now-last)) -ge 3600 ] || return 0
    if [ -s "$RUN/wwan.route" ]; then read -r dev gateway < "$RUN/wwan.route"
    elif [ -s "$RUN/wan.route" ]; then read -r dev gateway < "$RUN/wan.route"
    else return 0; fi
    : > "$RUN/probes.new"
    while read -r group host path expected addresses; do
        fresh=$(nslookup -type=A "$host" "$gateway" 2>/dev/null | awk '
            /^Name:/ { answer=1 }
            answer && $1 == "Address:" && $2 ~ /^[0-9.]+$/ {
                n=split($2,a,"."); ok=(n==4)
                for(i=1;i<=n;i++) if(a[i]<0 || a[i]>255) ok=0
                if(ok && count<2) { printf "%s%s", count ? "," : "", $2; count++ }
            }')
        printf '%s %s %s %s %s\n' "$group" "$host" "$path" "$expected" "${fresh:-$addresses}" >> "$RUN/probes.new"
    done < "$BASE/probes.txt"
    if [ -s "$RUN/probes.new" ]; then
        cp "$RUN/probes.new" "$BASE/probes.txt.new" && mv "$BASE/probes.txt.new" "$BASE/probes.txt"
    fi
    echo "$now" > "$RUN/probes-refreshed"
}

event() {
    logger -t mobile-backup -- "$*"
    printf '%s %s\n' "$(date +%s)" "$*" >> "$RUN/events"
    tail -n 80 "$RUN/events" > "$RUN/events.new" && mv "$RUN/events.new" "$RUN/events"
}
policy() { cat "$BASE/policy" 2>/dev/null || echo auto; }
source_link() { cat "$BASE/source" 2>/dev/null || echo wan; }
release_wifi() {
    # Share the UI lock: never interrupt a user-initiated join or reload twice.
    (
        exec 8>"$RUN/ui.lock"
        flock -n 8 || exit 0
        /usr/bin/ucode /usr/libexec/mobile-backup-wifi.uc release "$1" >/dev/null 2>&1
    )
}

authorize_vk() {
    local now last
    if ubus call service list '{"name":"mobile-vk-auth"}' | jsonfilter -e '@["mobile-vk-auth"].instances.*.running' | grep -q true; then return 0; fi
    now=$(date +%s)
    last=$(cat "$RUN/auth-requested" 2>/dev/null || echo 0)
    if [ "${1:-manual}" = automatic ] && [ $((now-last)) -lt 600 ]; then return 1; fi
    /etc/init.d/mobile-vk-auth start >/dev/null 2>&1 || return 1
    echo "$now" > "$RUN/auth-requested"
}
field() { jsonfilter -i "$RUN/$1.json" -e "$2" 2>/dev/null; }

link_state() {
    local link="$1" table="$2" pref="$3" dev addr gateway old
    ubus call "network.interface.$link" status > "$RUN/$link.json" 2>/dev/null || return 1
    [ "$(field "$link" '@.up')" = true ] || return 1
    dev=$(field "$link" '@.l3_device')
    addr=$(field "$link" '@["ipv4-address"][0].address')
    gateway=$(field "$link" '@.route[@.target="0.0.0.0"].nexthop' | head -n 1)
    case "$dev" in ''|*[!a-zA-Z0-9_.-]*) return 1;; esac
    case "$addr:$gateway" in *[!0-9.:]*|:|*:) return 1;; esac
    ip route replace "$gateway/32" dev "$dev" scope link table "$table" || return 1
    ip route replace default via "$gateway" dev "$dev" table "$table" || return 1
    old=$(cat "$RUN/$link.source" 2>/dev/null || true)
    if [ "$old" != "$addr" ] || ! ip rule show | grep -q "^$pref:"; then
        while ip rule del pref "$pref" 2>/dev/null; do :; done
        ip rule add pref "$pref" from "$addr/32" lookup "$table" || return 1
        echo "$addr" > "$RUN/$link.source"
    fi
    echo "$dev $gateway" > "$RUN/$link.route"
}

probe_link() {
    local link="$1" dev group host path expected addresses code count=0 allowed=0
    if [ ! -s "$RUN/$link.route" ]; then
        while read -r group host _ _ _; do echo 0 > "$RUN/$link.$host.result"; done < "$BASE/probes.txt"
        echo '0 0'; return
    fi
    read -r dev _ < "$RUN/$link.route"
    while read -r group host path expected addresses; do
        [ -n "$group" ] || continue
        (
            code=$(curl -q --noproxy '*' -4 -s --interface "$dev" \
                --resolve "$host:443:$addresses" --connect-timeout 4 --max-time 7 \
                -I -o /dev/null -w '%{http_code}' "https://$host$path") || code=000
            case "$expected:$code" in
                204:204|reachable:[234][0-9][0-9]) echo 1;;
                *) echo 0;;
            esac > "$RUN/$link.$host.result"
        ) &
    done < "$BASE/probes.txt"
    wait
    while read -r group host _ _ _; do
        code=$(cat "$RUN/$link.$host.result" 2>/dev/null || echo 0)
        if [ "$group" = external ]; then count=$((count + code))
        else allowed=$((allowed + code)); fi
    done < "$BASE/probes.txt"
    echo "$count $allowed"
}

select_link() {
    local link="$1" dev gateway
    if [ -s "$RUN/$link.route" ]; then
        read -r dev gateway < "$RUN/$link.route"
        ip route replace default via "$gateway" dev "$dev" metric 5 || return 1
        echo ready > "$RUN/link-state"
    else
        # Do not silently fall back to the other DHCP default route.
        ip route replace blackhole default metric 5 || return 1
        echo disconnected > "$RUN/link-state"
    fi
    if [ "$(cat "$RUN/uplink" 2>/dev/null || true)" != "$link" ]; then
        echo "$link" > "$RUN/uplink"
        event "uplink=$link"
    fi
}

dns_mode() {
    local target current server attempt=0
    if [ "$1" = bypass ]; then target='127.0.0.1#1053'
    else target=$(cat "$BASE/normal-dns"); fi
    current=$(uci -q get 'dhcp.@dnsmasq[0].server' || true)
    [ "$current" = "$target" ] && return 0
    uci -q delete 'dhcp.@dnsmasq[0].server' || true
    for server in $target; do uci add_list "dhcp.@dnsmasq[0].server=$server"; done
    uci commit dhcp
    /etc/init.d/dnsmasq reload >/dev/null 2>&1 || return 1
    sleep 1
    while [ "$attempt" -lt 10 ]; do
        nslookup localhost 127.0.0.1 >/dev/null 2>&1 && return 0
        sleep 1
        attempt=$((attempt+1))
    done
    return 1
}

proxy_ok() {
    if curl -q --noproxy '' --socks5-hostname 127.0.0.1:10980 -4 -fsS \
        --connect-timeout 5 --max-time 9 -o /dev/null \
        https://www.google.com/generate_204; then
        echo ready > "$RUN/proxy-state"
        return 0
    fi
    echo failed > "$RUN/proxy-state"
    return 1
}

provider_start() {
    local provider="$1" dev gateway
    case "$provider" in telemost|wbstream|vk) ;; *) return 2;; esac
    if [ "$provider" = vk ] && [ ! -s "$BASE/vk/vk-auth.json" ]; then
        authorize_vk automatic
        event 'vk_auth_required'
        return 1
    fi
    read -r dev gateway < "$RUN/wwan.route"
    echo "$provider" > "$RUN/provider"
    printf '%s\n' "$dev" > "$RUN/interface"
    printf '%s:53\n' "$gateway" > "$RUN/bootstrap-dns"
    /etc/init.d/mobile-joiner restart >/dev/null 2>&1
    event "provider_start=$provider"
}

find_provider() {
    local provider attempt wanted
    wanted=$(policy)
    for provider in $(cat "$BASE/providers"); do
        provider_start "$provider" || continue
        attempt=0
        while [ "$attempt" -lt 5 ]; do
            sleep 3
            [ "$(policy)" = "$wanted" ] && [ "$(source_link)" = wwan ] || return 1
            if proxy_ok >/dev/null 2>&1 && /usr/local/bin/router-joiner --probe-socks 127.0.0.1:10980 >/dev/null 2>&1; then
                [ "$(policy)" = "$wanted" ] && [ "$(source_link)" = wwan ] || return 1
                echo "$(date +%s) ready" > "$RUN/$provider.health"
                event "provider_ready=$provider"
                return 0
            fi
            attempt=$((attempt + 1))
        done
        echo "$(date +%s) failed" > "$RUN/$provider.health"
        event "provider_failed=$provider"
        if [ "$provider" = vk ]; then authorize_vk automatic && event 'vk_auth_required'; fi
    done
    return 1
}

activate() {
    nft list table inet mobile_bypass >/dev/null 2>&1 || nft -f "$BASE/bypass.nft" || return 1
    dns_mode bypass || { normal; return 1; }
    echo bypass > "$RUN/mode"
    event "mode=bypass"
}

normal() {
    nft delete table inet mobile_bypass 2>/dev/null || true
    dns_mode normal
    /etc/init.d/mobile-joiner stop >/dev/null 2>&1 || true
    rm -f "$RUN/provider" "$RUN/interface" "$RUN/bootstrap-dns" "$RUN/proxy-state"
    echo normal > "$RUN/mode"
    event "mode=normal"
}

status() {
    printf 'uplink=%s\nmode=%s\nprovider=%s\n' \
        "$(cat "$RUN/uplink" 2>/dev/null || echo unknown)" \
        "$(cat "$RUN/mode" 2>/dev/null || echo unknown)" \
        "$(cat "$RUN/provider" 2>/dev/null || echo none)"
    cat "$RUN/checks" 2>/dev/null || true
    if [ -s "$BASE/vk/captcha-port" ]; then echo vk_captcha=required; fi
}

daemon() {
    exec 9>"$RUN/controller.lock"
    flock -n 9 || exit 0
    local limited=0 recovered=0 tunnel_bad=0 wifi_lost=0 mode class requested selected previous=""
    local wan_ready mobile_ready wan_external wan_allowed mobile_external mobile_allowed
    [ -s "$RUN/mode" ] || normal
    while true; do
        wan_ready=0; mobile_ready=0
        if link_state wan 201 10021; then wan_ready=1; else rm -f "$RUN/wan.route"; fi
        if link_state wwan 202 10022; then mobile_ready=1; else rm -f "$RUN/wwan.route"; fi
        refresh_probes
        probe_link wan > "$RUN/wan.counts" &
        probe_link wwan > "$RUN/wwan.counts" &
        wait
        read -r wan_external wan_allowed < "$RUN/wan.counts"
        read -r mobile_external mobile_allowed < "$RUN/wwan.counts"
        class=$(classify "$mobile_external" "$mobile_allowed")
        printf 'wan_external=%s\nmobile_external=%s\nmobile_allowed=%s\nmobile_state=%s\n' \
            "$wan_external" "$mobile_external" "$mobile_allowed" "$class" > "$RUN/checks"
        date +%s > "$RUN/checked-at"
        requested=$(policy)
        mode=$(cat "$RUN/mode")
        if [ -f "$RUN/reconnect" ]; then
            rm -f "$RUN/reconnect"
            normal; mode=normal; limited=3
        fi
        selected=$(source_link)
        if [ "$selected" != "$previous" ]; then limited=0; recovered=0; tunnel_bad=0; previous=$selected; fi
        select_link "$selected"
        if [ "$selected" = wan ]; then wifi_lost=0; release_wifi wired
        elif [ "$mobile_ready" -eq 0 ]; then
            wifi_lost=$((wifi_lost+1))
            [ "$wifi_lost" -lt 3 ] || release_wifi lost
        else wifi_lost=0; fi
        if [ "$selected" = wan ] || [ "$mobile_ready" -eq 0 ] || [ "$requested" = direct ]; then
            if [ "$mode" = bypass ] || [ -s "$RUN/provider" ]; then normal; fi
            limited=0; recovered=0; tunnel_bad=0
            sleep 15
            continue
        fi
        case "$class" in
            limited) limited=$((limited+1)); recovered=0;;
            open) recovered=$((recovered+1)); limited=0;;
            *) limited=0; recovered=0;;
        esac
        if [ "$mode" = bypass ]; then
            nft list table inet mobile_bypass >/dev/null 2>&1 || nft -f "$BASE/bypass.nft"
            dns_mode bypass || event 'dns_not_ready'
            if [ "$requested" = auto ] && [ "$recovered" -ge 4 ]; then
                normal; tunnel_bad=0
            elif proxy_ok >/dev/null 2>&1; then tunnel_bad=0
            else
                tunnel_bad=$((tunnel_bad+1))
                if [ "$tunnel_bad" -ge 3 ]; then
                    find_provider || event 'all_providers_failed'
                    tunnel_bad=0
                fi
            fi
        elif [ "$requested" = bypass ] || [ "$limited" -ge 3 ]; then
            if find_provider; then activate; else event 'all_providers_failed'; fi
            limited=0
        fi
        sleep 15
    done
}

case "${1:-status}" in
    status) status;;
    run) daemon;;
    normal) normal;;
    classify) classify "$2" "$3";;
    probe)
        link_state wan 201 10021 || true
        link_state wwan 202 10022 || true
        printf 'wan '; probe_link wan
        printf 'wwan '; probe_link wwan
        ;;
    test-provider)
        link_state wwan 202 10022 && select_link wwan && provider_start "$2"
        ;;
    authorize-vk) authorize_vk;;
    test-bypass) proxy_ok && activate;;
    *) echo 'Usage: mobile-backup status|probe|normal|test-provider NAME|test-bypass' >&2; exit 2;;
esac
