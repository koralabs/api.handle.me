-- Isolated experiment only. A complete marker is written after every postimage.
local id = ARGV[1]
if redis.call('HGET', KEYS[1], id .. ':before-ready') ~= '1' then return redis.error_reply('UNDO_PREIMAGE_MISSING') end
for i = 2, #KEYS do
    local image = redis.call('DUMP', KEYS[i])
    local kind = redis.call('TYPE', KEYS[i]).ok
    redis.call('HSET', KEYS[1], id .. ':after-type:' .. (i - 1), kind)
    if kind == 'zset' then redis.call('HSET', KEYS[1], id .. ':after-zset:' .. (i - 1), cjson.encode(redis.call('ZRANGE', KEYS[i], 0, -1, 'WITHSCORES'))) end
    if kind == 'set' then redis.call('HSET', KEYS[1], id .. ':after-set:' .. (i - 1), cjson.encode(redis.call('SMEMBERS', KEYS[i]))) end
    if kind == 'hash' then redis.call('HSET', KEYS[1], id .. ':after-hash:' .. (i - 1), cjson.encode(redis.call('HGETALL', KEYS[i]))) end
    redis.call('HSET', KEYS[1], id .. ':after:' .. (i - 1), image or '')
    redis.call('HSET', KEYS[1], id .. ':after-exists:' .. (i - 1), image and '1' or '0')
end
redis.call('HSET', KEYS[1], id .. ':complete', '1')
return id
