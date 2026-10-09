-- lua components/zapret/test_guard.lua; native NFQUEUE behavior is checked separately.
local now, calls, reports = 1000, {}, {}
os.time = function() return now end
getpid = function() return 1 end
os.rename = function() return true end
io.open = function(_, mode)
    if mode == 'r' then
        local lines = { '900 restored.example confirmed split 0',
            '901 unresolved.example unresolved direct 0' }
        return { read = function() return table.remove(lines, 1) end, close = function() end }
    end
    return { write = function(_, row) reports[#reports+1] = row end, close = function() end }
end
TH_FIN, TH_RST, VERDICT_PASS = 1, 4, 0
bitand = function(a, b) return a & b end
writable_file_name = function(name) return name end
DLOG_ERR = error
orchestrate = function() end
plan_clear = function() end
standard_failure_detector = function(d) return d.retransmission end
pos_get = function(d) return d.seq or 0 end
replay_execution_plan = function() calls[#calls+1] = 'zapret'; return 0 end
multisplit = function() calls[#calls+1] = 'split'; return 0 end
dofile('components/zapret/cyberguard.lua')

local function packet(c, outgoing, payload, kind, flags, seq)
    cyberguard(nil, { track = c, outgoing = outgoing, l7payload = kind or 'unknown',
        dis = { tcp = { th_flags = flags or 16 }, payload = payload or '' }, arg = {}, seq = seq })
end
local function start(host)
    local c = { hostname = host, lua_state = {} }
    packet(c, true, string.char(22)..'hello', 'tls_client_hello')
    return c
end
local function fail(c)
    now = now + 5
    packet(c, true, '', 'unknown', TH_FIN)
end
local function succeed(c)
    local before = #reports
    packet(c, false, string.char(22)..string.rep('x', 150), 'tls_server_hello')
    packet(c, true, string.char(23)..'encrypted')
    assert(#reports == before, 'handshake alone is not success')
    packet(c, false, string.char(23)..'encrypted', 'unknown', nil, 32769)
end
assert(start('restored.example').lua_state.cyberguard.mode == 2, 'confirmed alternative survives daemon reload')
assert(start('unresolved.example').lua_state.cyberguard.mode == 3, 'unresolved direct trial survives daemon reload')
local c = start('example.com'); fail(c); fail(c)
assert(start('example.com').lua_state.cyberguard.mode == 1, 'one flow counted once')
succeed(start('example.com'))
fail(start('example.com')); fail(start('example.com'))
assert(start('example.com').lua_state.cyberguard.mode == 2)
assert(c.lua_state.cyberguard.mode == 1, 'old flow is pinned')
c = start('example.com'); succeed(c)
assert(table.concat(reports):find('example.com confirmed split'))
fail(start('example.com')); fail(start('example.com'))
c = start('example.com'); assert(c.lua_state.cyberguard.mode == 3); succeed(c)
assert(table.concat(reports):find('example.com confirmed direct'))
fail(start('example.com')); fail(start('example.com'))
assert(table.concat(reports):find('example.com unresolved direct'))
now = now + 301
assert(start('example.com').lua_state.cyberguard.mode == 3, 'unresolved host stays direct for VPN verification')
now = now + 86400
assert(start('example.com').lua_state.cyberguard.mode == 1, 'daily zapret retry remains enabled')
c = start('healthy.example'); succeed(c); now = now + 10; fail(c)
assert(not table.concat(reports):find('healthy.example suspect'))
c = start('cancel.example'); packet(c, true, '', 'unknown', TH_FIN)
assert(not table.concat(reports):find('cancel.example suspect'), 'quick cancellation is inconclusive')
c = start('../bad.example'); assert(not c.lua_state.cyberguard)
c = start('stale.example'); fail(c); now = now + 121; fail(start('stale.example'))
assert(start('stale.example').lua_state.cyberguard.mode == 1, 'failure window expires')
print('PASS TLS guard: pinned flows, distinct failures, mixed clients, split/direct trials, confirmed recovery, unresolved warning, expiry and invalid names')
