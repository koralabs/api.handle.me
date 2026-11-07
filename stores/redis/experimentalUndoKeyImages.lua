-- Isolated experiment only. Sets and zsets are reversed by changed member; other
-- keys use whole-key images. This does not establish ancestry or writer exclusivity.
-- KEYS: undo hash, gate, readers, repair lease, scanner lease, then every data key.
-- ARGV: gate owner, repair lease owner, scanner lease owner.
if redis.call('GET', KEYS[2]) ~= ARGV[1] or redis.call('SCARD', KEYS[3]) ~= 0 or
   redis.call('GET', KEYS[4]) ~= ARGV[2] or redis.call('PTTL', KEYS[4]) <= 0 or
   redis.call('GET', KEYS[5]) ~= ARGV[3] or redis.call('PTTL', KEYS[5]) <= 0 then
    return redis.error_reply('UNDO_FENCE_LOST')
end
local sequence = tonumber(redis.call('HGET', KEYS[1], 'sequence'))
if not sequence or sequence < 1 or sequence ~= math.floor(sequence) then return redis.error_reply('UNDO_LOG_INVALID') end
local allowed, expected, originals, zexpected, sexpected, modes = {}, {}, {}, {}, {}, {}
local function zmap(raw)
    local ok, values = pcall(cjson.decode, raw or '')
    if not ok or type(values) ~= 'table' or #values % 2 ~= 0 then return nil end
    local result = {}
    for i = 1, #values, 2 do
        if type(values[i]) ~= 'string' or type(values[i+1]) ~= 'string' or not tonumber(values[i+1]) or result[values[i]] then return nil end
        result[values[i]] = values[i+1]
    end
    return result
end
local function setmap(raw)
    local ok, values = pcall(cjson.decode, raw or '')
    if not ok or type(values) ~= 'table' then return nil end
    local result = {}
    for _, member in ipairs(values) do
        if type(member) ~= 'string' or result[member] then return nil end
        result[member] = true
    end
    return result
end
for i = 1, #KEYS do
    for j = i + 1, #KEYS do if KEYS[i] == KEYS[j] then return redis.error_reply('UNDO_DUPLICATE_KEY') end end
end
for i = 6, #KEYS do
    if allowed[KEYS[i]] then return redis.error_reply('UNDO_DUPLICATE_KEY') end
    allowed[KEYS[i]] = true
end
for n = sequence, 1, -1 do
    local id = redis.call('HGET', KEYS[1], 'order:' .. n)
    if not id or redis.call('HGET', KEYS[1], id .. ':before-ready') ~= '1' or redis.call('HGET', KEYS[1], id .. ':complete') ~= '1' then
        return redis.error_reply('UNDO_LOG_INCOMPLETE')
    end
    local ok, keys = pcall(cjson.decode, redis.call('HGET', KEYS[1], id .. ':keys') or '')
    if not ok or type(keys) ~= 'table' or #keys == 0 then return redis.error_reply('UNDO_LOG_INVALID') end
    for i, key in ipairs(keys) do
        if not allowed[key] then return redis.error_reply('UNDO_KEY_MISSING') end
        local beforeFlag = redis.call('HGET', KEYS[1], id .. ':before-exists:' .. i)
        local afterFlag = redis.call('HGET', KEYS[1], id .. ':after-exists:' .. i)
        local before = redis.call('HGET', KEYS[1], id .. ':before:' .. i)
        local after = redis.call('HGET', KEYS[1], id .. ':after:' .. i)
        if (beforeFlag ~= '0' and beforeFlag ~= '1') or (afterFlag ~= '0' and afterFlag ~= '1') or before == false or after == false then
            return redis.error_reply('UNDO_LOG_INVALID')
        end
        local beforeType = redis.call('HGET', KEYS[1], id .. ':before-type:' .. i)
        local afterType = redis.call('HGET', KEYS[1], id .. ':after-type:' .. i)
        if not beforeType or not afterType then return redis.error_reply('UNDO_LOG_INVALID') end
        local zgranular = (beforeType == 'zset' or beforeType == 'none') and (afterType == 'zset' or afterType == 'none') and (beforeType == 'zset' or afterType == 'zset')
        local sgranular = (beforeType == 'set' or beforeType == 'none') and (afterType == 'set' or afterType == 'none') and (beforeType == 'set' or afterType == 'set')
        local mode = zgranular and 'zset' or (sgranular and 'set' or 'whole')
        if modes[key] and modes[key] ~= mode then return redis.error_reply('UNDO_UNSUPPORTED_TRANSITION') end
        modes[key] = mode
        local ttl = redis.call('PTTL', key)
        if ttl >= 0 then return redis.error_reply('UNDO_CONFLICT') end
        if zgranular then
            local kind = redis.call('TYPE', key).ok
            if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('UNDO_CONFLICT') end
            local beforeSet = beforeType == 'none' and {} or zmap(redis.call('HGET', KEYS[1], id .. ':before-zset:' .. i))
            local afterSet = afterType == 'none' and {} or zmap(redis.call('HGET', KEYS[1], id .. ':after-zset:' .. i))
            if not beforeSet or not afterSet then return redis.error_reply('UNDO_LOG_INVALID') end
            zexpected[key] = zexpected[key] or {}
            local members = {}
            for member in pairs(beforeSet) do members[member] = true end
            for member in pairs(afterSet) do members[member] = true end
            for member in pairs(members) do
                local old, new = beforeSet[member] or false, afterSet[member] or false
                if old ~= new then
                    if zexpected[key][member] == nil then zexpected[key][member] = redis.call('ZSCORE', key, member) or false end
                    if zexpected[key][member] ~= new then return redis.error_reply('UNDO_CONFLICT') end
                    zexpected[key][member] = old
                end
            end
        elseif sgranular then
            local kind = redis.call('TYPE', key).ok
            if kind ~= 'none' and kind ~= 'set' then return redis.error_reply('UNDO_CONFLICT') end
            local beforeSet = beforeType == 'none' and {} or setmap(redis.call('HGET', KEYS[1], id .. ':before-set:' .. i))
            local afterSet = afterType == 'none' and {} or setmap(redis.call('HGET', KEYS[1], id .. ':after-set:' .. i))
            if not beforeSet or not afterSet then return redis.error_reply('UNDO_LOG_INVALID') end
            sexpected[key] = sexpected[key] or {}
            local members = {}
            for member in pairs(beforeSet) do members[member] = true end
            for member in pairs(afterSet) do members[member] = true end
            for member in pairs(members) do
                local old, new = beforeSet[member] or false, afterSet[member] or false
                if old ~= new then
                    if sexpected[key][member] == nil then sexpected[key][member] = redis.call('SISMEMBER', key, member) == 1 end
                    if sexpected[key][member] ~= new then return redis.error_reply('UNDO_CONFLICT') end
                    sexpected[key][member] = old
                end
            end
        else
            if not expected[key] then
                local current = redis.call('DUMP', key)
                expected[key] = { exists = current and '1' or '0', image = current or '' }
            end
            if expected[key].exists ~= afterFlag or expected[key].image ~= after then return redis.error_reply('UNDO_CONFLICT') end
            expected[key] = { exists = beforeFlag, image = before }
            originals[key] = expected[key]
        end
    end
end
for key, members in pairs(zexpected) do
    for member, score in pairs(members) do
        if score == false then redis.call('ZREM', key, member) else redis.call('ZADD', key, score, member) end
    end
end
for key, members in pairs(sexpected) do
    for member, present in pairs(members) do
        if present then redis.call('SADD', key, member) else redis.call('SREM', key, member) end
    end
end
for key, image in pairs(originals) do
    if image.exists == '0' then redis.call('DEL', key)
    else redis.call('RESTORE', key, 0, image.image, 'REPLACE') end
end
return 1
