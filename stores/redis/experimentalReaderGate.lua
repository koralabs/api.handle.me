-- Experimental only: all keys must share the same Valkey cluster hash slot.
-- Tokens and the closed gate deliberately have no expiry. Orphan cleanup requires
-- independent proof that the corresponding process can no longer emit bytes.
local operation = ARGV[1]
local token = ARGV[2]
if not token or token == '' then return redis.error_reply('token required') end
local function ownsLeases()
    return ARGV[4] and ARGV[4] ~= '' and redis.call('GET', KEYS[5]) == token and redis.call('GET', KEYS[6]) == ARGV[4]
end

if operation == 'admit' then
    if redis.call('EXISTS', KEYS[1]) ~= 0 or redis.call('EXISTS', KEYS[3]) ~= 0 then return 0 end
    return redis.call('SADD', KEYS[2], token)
elseif operation == 'release' then
    return redis.call('SREM', KEYS[2], token)
elseif operation == 'close' then
    if not ownsLeases() then return redis.error_reply('FENCE_LOST') end
    if not ARGV[3] or ARGV[3] == '' then return redis.error_reply('journal required') end
    if redis.call('EXISTS', KEYS[1]) ~= 0 or redis.call('EXISTS', KEYS[3]) ~= 0 then return 0 end
    redis.call('SET', KEYS[1], token)
    redis.call('SET', KEYS[3], ARGV[3])
    return 1
elseif operation == 'drained' then
    if not ownsLeases() then return redis.error_reply('FENCE_LOST') end
    if redis.call('GET', KEYS[1]) ~= token or redis.call('EXISTS', KEYS[3]) == 0 then return 0 end
    if redis.call('SCARD', KEYS[2]) ~= 0 then return 0 end
    return 1
elseif operation == 'open' then
    if not ownsLeases() then return redis.error_reply('FENCE_LOST') end
    if not ARGV[3] or ARGV[3] == '' then return redis.error_reply('journal required') end
    if redis.call('GET', KEYS[1]) ~= token or redis.call('GET', KEYS[3]) ~= ARGV[3] then return 0 end
    if redis.call('SCARD', KEYS[2]) ~= 0 or redis.call('SCARD', KEYS[4]) ~= 0 then return 0 end
    redis.call('DEL', KEYS[1], KEYS[3])
    return 1
end
return redis.error_reply('unknown operation')
