-- Isolated local-repair protocol. Persistent reader tokens are never expired: a
-- disconnected process must be proven dead before an orphan can be removed.
local op = ARGV[1]
if op == 'admit' then
    if redis.call('EXISTS', KEYS[1], KEYS[3]) ~= 0 then return 0 end
    return redis.call('SADD', KEYS[2], ARGV[2])
elseif op == 'release' then
    return redis.call('SREM', KEYS[2], ARGV[2])
end
if redis.call('GET', KEYS[4]) ~= ARGV[2] or redis.call('PTTL', KEYS[4]) <= 0 or
   redis.call('GET', KEYS[5]) ~= ARGV[3] or redis.call('PTTL', KEYS[5]) <= 0 then
    return redis.error_reply('FENCE_LOST')
end
if op == 'close' then
    if redis.call('SCARD', KEYS[2]) ~= 0 then return 0 end
    if redis.call('EXISTS', KEYS[1]) ~= 0 and redis.call('EXISTS', KEYS[3]) == 0 then
        return redis.error_reply('ORPHAN_GATE')
    end
    redis.call('SET', KEYS[1], ARGV[2])
    return 1
elseif op == 'open' then
    if redis.call('GET', KEYS[1]) ~= ARGV[2] or redis.call('EXISTS', KEYS[3]) ~= 0 or redis.call('SCARD', KEYS[2]) ~= 0 then return 0 end
    redis.call('DEL', KEYS[1])
    return 1
end
return redis.error_reply('INVALID_OPERATION')
