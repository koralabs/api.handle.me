// Experimental primitive only: one persistent hash field per journal, not wired to repair.
// Every affected writer must cooperate with a stronger ownership/version protocol: a
// postimage comparison cannot detect a change followed by restoration (ABA). Neither
// script provides durability across server data loss or covers readers, other fields,
// indexes, expiry, or multi-command repository transactions. Lua serializes commands,
// but does not roll them back on runtime errors or guarantee crash durability. In
// particular an error after journal creation can leave a journal without the mutation.
// KEYS: repair fence, scanner fence, journal, data hash, reader gate, readers set, gate journal, pending set. All keys must be distinct.
// ARGV apply: repair owner, scanner owner, field, new value.
export const applyField = `
for i = 1, 8 do for j = i + 1, 8 do
  if KEYS[i] == KEYS[j] then return redis.error_reply('overlapping keys') end
end end
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return redis.error_reply('FENCE_LOST') end
if redis.call('GET', KEYS[5]) ~= ARGV[1] or redis.call('EXISTS', KEYS[7]) ~= 1 then return redis.error_reply('GATE_NOT_HELD') end
if redis.call('SCARD', KEYS[6]) ~= 0 then return redis.error_reply('READERS_ACTIVE') end
if redis.call('EXISTS', KEYS[3]) ~= 0 then return redis.error_reply('journal exists') end
local t = redis.call('TYPE', KEYS[4]).ok
if t ~= 'none' and t ~= 'hash' then return redis.error_reply('WRONG_DATA_TYPE') end
if redis.call('PTTL', KEYS[4]) >= 0 then return redis.error_reply('expiring data unsupported') end
local before = redis.call('HGET', KEYS[4], ARGV[3])
redis.call('SADD', KEYS[8], KEYS[3])
redis.call('HSET', KEYS[3], 'field', ARGV[3], 'exists', before and '1' or '0', 'before', before or '', 'after', ARGV[4], 'data', KEYS[4])
redis.call('HSET', KEYS[4], ARGV[3], ARGV[4])
return 1
`;
// ARGV commit: repair owner, scanner owner. A conflict retains the journal unchanged.
export const commitField = `
for i = 1, 8 do for j = i + 1, 8 do
  if KEYS[i] == KEYS[j] then return redis.error_reply('overlapping keys') end
end end
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return redis.error_reply('FENCE_LOST') end
if redis.call('GET', KEYS[5]) ~= ARGV[1] or redis.call('EXISTS', KEYS[7]) ~= 1 then return redis.error_reply('GATE_NOT_HELD') end
if redis.call('SCARD', KEYS[6]) ~= 0 then return redis.error_reply('READERS_ACTIVE') end
if redis.call('TYPE', KEYS[3]).ok ~= 'hash' then return redis.error_reply('journal missing or invalid') end
if redis.call('TYPE', KEYS[8]).ok ~= 'set' or redis.call('SISMEMBER', KEYS[8], KEYS[3]) ~= 1 then return redis.error_reply('invalid pending set') end
local j = redis.call('HMGET', KEYS[3], 'field', 'after', 'data')
if not j[1] or not j[2] or j[3] ~= KEYS[4] then return redis.error_reply('journal invalid') end
if redis.call('TYPE', KEYS[4]).ok ~= 'hash' or redis.call('PTTL', KEYS[4]) >= 0 or redis.call('HGET', KEYS[4], j[1]) ~= j[2] then return redis.error_reply('conflict') end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[8], KEYS[3])
return 1
`;
// ARGV undo: repair owner, scanner owner. A conflict retains the journal unchanged.
export const undoField = `
for i = 1, 8 do for j = i + 1, 8 do
  if KEYS[i] == KEYS[j] then return redis.error_reply('overlapping keys') end
end end
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return redis.error_reply('FENCE_LOST') end
if redis.call('GET', KEYS[5]) ~= ARGV[1] or redis.call('EXISTS', KEYS[7]) ~= 1 then return redis.error_reply('GATE_NOT_HELD') end
if redis.call('SCARD', KEYS[6]) ~= 0 then return redis.error_reply('READERS_ACTIVE') end
if redis.call('TYPE', KEYS[3]).ok ~= 'hash' then return redis.error_reply('journal missing or invalid') end
if redis.call('TYPE', KEYS[8]).ok ~= 'set' or redis.call('SISMEMBER', KEYS[8], KEYS[3]) ~= 1 then return redis.error_reply('invalid pending set') end
local j = redis.call('HMGET', KEYS[3], 'field', 'exists', 'before', 'after', 'data')
if not j[1] or (j[2] ~= '0' and j[2] ~= '1') or not j[3] or not j[4] or j[5] ~= KEYS[4] then return redis.error_reply('journal invalid') end
local t = redis.call('TYPE', KEYS[4]).ok
if t ~= 'hash' then return redis.error_reply('conflict') end
if redis.call('PTTL', KEYS[4]) >= 0 or redis.call('HGET', KEYS[4], j[1]) ~= j[4] then return redis.error_reply('conflict') end
if j[2] == '1' then redis.call('HSET', KEYS[4], j[1], j[3]) else redis.call('HDEL', KEYS[4], j[1]) end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[8], KEYS[3])
return 1
`;
