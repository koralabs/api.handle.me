-- Isolated experiment only. Store binary DUMP preimages before this batch.
local id = ARGV[1]
local sequence = redis.call('HINCRBY', KEYS[1], 'sequence', 1)
redis.call('HSET', KEYS[1], 'order:' .. sequence, id)
local keys = {}
for i = 2, #KEYS do
    keys[#keys + 1] = KEYS[i]
    local image = redis.call('DUMP', KEYS[i])
    local kind = redis.call('TYPE', KEYS[i]).ok
    redis.call('HSET', KEYS[1], id .. ':before-type:' .. (i - 1), kind)
    if kind == 'zset' then redis.call('HSET', KEYS[1], id .. ':before-zset:' .. (i - 1), cjson.encode(redis.call('ZRANGE', KEYS[i], 0, -1, 'WITHSCORES'))) end
    if kind == 'set' then redis.call('HSET', KEYS[1], id .. ':before-set:' .. (i - 1), cjson.encode(redis.call('SMEMBERS', KEYS[i]))) end
    if kind == 'hash' then redis.call('HSET', KEYS[1], id .. ':before-hash:' .. (i - 1), cjson.encode(redis.call('HGETALL', KEYS[i]))) end
    redis.call('HSET', KEYS[1], id .. ':before:' .. (i - 1), image or '')
    redis.call('HSET', KEYS[1], id .. ':before-exists:' .. (i - 1), image and '1' or '0')
end
redis.call('HSET', KEYS[1], id .. ':keys', cjson.encode(keys), id .. ':before-ready', '1')
return id
