-- Execute the actual gate script against an in-memory Valkey command boundary.
-- Invariant: closing admission excludes new readers and remains closed until every
-- admitted reader releases; removing either admission check or SCARD fails this test.
local values = {}
redis = {}
function redis.error_reply(message) error(message) end
function redis.call(command, key, value)
    if command == 'EXISTS' then return values[key] and 1 or 0 end
    if command == 'GET' then return values[key] or false end
    if command == 'SET' then values[key] = value; return 'OK' end
    if command == 'DEL' then
        local removed = values[key] and 1 or 0
        if values[value] then removed = removed + 1 end
        values[key] = nil; values[value] = nil
        return removed
    end
    if command == 'SADD' then
        values[key] = values[key] or {}
        if values[key][value] then return 0 end
        values[key][value] = true
        return 1
    end
    if command == 'SREM' then
        if not values[key] or not values[key][value] then return 0 end
        values[key][value] = nil
        return 1
    end
    if command == 'SCARD' then
        local count = 0
        for _ in pairs(values[key] or {}) do count = count + 1 end
        return count
    end
    error('unexpected command ' .. command)
end
KEYS = { '{api:preview}:gate', '{api:preview}:readers', '{api:preview}:journal', '{api:preview}:pending', '{api:preview}:repair', '{api:preview}:scanner' }
values[KEYS[5]] = 'writer'; values[KEYS[6]] = 'scanner'
local script = assert(loadfile('stores/redis/experimentalReaderGate.lua'))
local function call(operation, token, journal)
    ARGV = { operation, token, journal, 'scanner' }
    return script()
end
assert(call('admit', 'reader-a') == 1)
assert(call('admit', 'reader-b') == 1)
assert(call('close', 'writer', 'repair journal') == 1)
assert(call('admit', 'late-reader') == 0)
assert(not pcall(call, 'close', 'other-writer', 'other journal'))
assert(call('drained', 'writer') == 0)
assert(call('release', 'reader-a') == 1)
assert(call('drained', 'writer') == 0)
assert(not pcall(call, 'drained', 'other-writer'))
assert(call('release', 'reader-b') == 1)
assert(call('drained', 'writer') == 1)
assert(call('admit', 'still-closed') == 0)
assert(values[KEYS[3]] == 'repair journal')
redis.call('SADD', KEYS[4], 'unfinished')
assert(call('open', 'writer', 'repair journal') == 0)
redis.call('SREM', KEYS[4], 'unfinished')
assert(call('open', 'writer', 'repair journal') == 1)
assert(call('admit', 'fresh-reader') == 1)
assert(not pcall(call, 'admit', ''))
print('experimental reader gate: passed')
