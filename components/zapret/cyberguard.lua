-- TLS transport guard for zapret2 v1.0.4 (Lua compatibility 6).
-- Keep the configured strategy first, then test segmentation and plain direct.
-- Only metadata is retained; TLS payloads and client addresses are never saved.
local hosts, count = {}, 0
local modes = { 'zapret', 'split', 'direct' }
local pidfile = io.open(writable_file_name('pid'), 'w')
if pidfile then pidfile:write(tostring(getpid())); pidfile:close() end

local function publish(host, h, state)
    h.state, h.updated = state, os.time()
    local path = writable_file_name('health')
    local f = io.open(path .. '.new', 'w')
    if not f then DLOG_ERR('cyberguard: cannot write health status'); return end
    for name, record in pairs(hosts) do
        f:write(string.format('%d %s %s %s %d\n', record.updated or 0,
            name, record.state or 'observing', modes[record.mode], record.failures or 0))
    end
    f:close()
    if not os.rename(path .. '.new', path) then
        DLOG_ERR('cyberguard: cannot replace health status')
    end
end

local function valid_host(host)
    return type(host) == 'string' and #host <= 253 and
        host:match('^[a-z0-9][a-z0-9.-]*[a-z0-9]$') and host:find('.', 1, true) and
        host:find('[a-z]') and not host:find('..', 1, true)
end

local function record(host, now)
    if not hosts[host] then
        -- ponytail: bounded per-host RAM state; cold hosts are forgotten after an hour.
        if count >= 512 then
            for name, h in pairs(hosts) do
                if now - h.seen > 3600 then hosts[name] = nil; count = count - 1 end
            end
        end
        if count >= 512 then return nil end
        hosts[host] = { mode = 1, generation = 1, failures = 0, updated = now }
        count = count + 1
    end
    local h = hosts[host]
    h.seen = now
    if h.retry and now >= h.retry then
        h.mode, h.failures, h.retry = 1, 0, nil
        h.generation = h.generation + 1
        publish(host, h, 'retry')
    end
    return h
end

-- Reuse recent alternatives and unresolved direct trials across daemon reloads. The file is
-- in RAM: a router reboot starts fresh, without per-connection flash writes.
local saved = io.open(writable_file_name('health'), 'r')
if saved then
    for _ = 1, 512 do
        local line = saved:read('*l')
        if not line then break end
        local stamp, host, state, mode = line:match('^(%d+) ([a-z0-9.-]+) (%w+) (%w+) %d+$')
        stamp = tonumber(stamp)
        if valid_host(host) and stamp and os.time() - stamp >= 0 and
            os.time() - stamp < 86400 and
            ((state == 'confirmed' and (mode == 'split' or mode == 'direct')) or
             (state == 'unresolved' and mode == 'direct')) then
            local h = record(host, os.time())
            h.mode, h.state, h.updated = mode == 'split' and 2 or 3, state, stamp
            h.retry = mode == 'direct' and stamp + 86400 or nil
        end
    end
    saved:close()
end

function cyberguard(ctx, desync)
    orchestrate(ctx, desync)
    local track, tcp = desync.track, desync.dis.tcp
    if not track or not tcp then return replay_execution_plan(desync) end
    local host = track.hostname and track.hostname:lower()
    if not valid_host(host) or track.hostname_is_ip then return replay_execution_plan(desync) end
    local now = os.time()
    local fails = math.max(2, tonumber(desync.arg.fails) or 2)
    local window = math.max(10, tonumber(desync.arg.window) or 120)
    local close_after = math.max(3, tonumber(desync.arg.close_after) or 3)
    local c = track.lua_state.cyberguard
    if not c and desync.outgoing and desync.l7payload == 'tls_client_hello' then
        local h = record(host, now)
        if h then
            c = { started = now, mode = h.mode, generation = h.generation }
            track.lua_state.cyberguard = c
        end
    end
    if not c then return replay_execution_plan(desync) end
    local h = hosts[host]
    local payload = desync.dis.payload or ''
    if not desync.outgoing and #payload > 100 and payload:byte(1) == 22 then
        c.server_hello = true
    end
    -- A handshake or a short partial response can still leave a blank page.
    local success = not desync.outgoing and c.server_hello and pos_get(desync, 's') > 32768
    local closed = bitand(tcp.th_flags, TH_FIN + TH_RST) ~= 0
    local failed = not success and (
        (closed and not c.server_hello and now - c.started >= close_after) or
        (not desync.outgoing and bitand(tcp.th_flags, TH_RST) ~= 0) or
        (not desync.outgoing and payload:byte(1) == 21) or
        standard_failure_detector(desync, c))
    if not c.done and (success or failed) then
        c.done = true
        -- Existing connections retain their strategy and cannot settle a newer trial.
        if h and c.generation == h.generation then
            if success then
                h.failures = 0
                if h.state ~= 'confirmed' then
                    -- A working zapret alternative needs no periodic disruption.
                    h.retry = h.mode == 3 and now + 86400 or nil
                    publish(host, h, 'confirmed')
                end
            else
                if now - (h.last_failure or 0) > window then h.failures = 0 end
                h.last_failure, h.failures = now, h.failures + 1
                if h.failures >= fails then
                    h.generation = h.generation + 1
                    if h.mode < 3 then
                        h.mode, h.failures, h.retry = h.mode + 1, 0, now + 300
                        publish(host, h, 'trial')
                    else
                        h.failures, h.retry = 0, now + 86400
                        publish(host, h, 'unresolved')
                    end
                else
                    publish(host, h, 'suspect')
                end
            end
        end
    end
    if c.mode == 1 then return replay_execution_plan(desync) end
    plan_clear(desync)
    if c.mode == 2 and desync.outgoing and desync.l7payload == 'tls_client_hello' then
        desync.arg = { pos = '1,midsld', payload = 'tls_client_hello', dir = 'out' }
        return multisplit(nil, desync)
    end
    return VERDICT_PASS
end
