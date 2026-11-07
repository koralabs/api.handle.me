// Isolated experiment only. Every writer must atomically increment the same per-field
// version, including writers outside this process. The current application does not.
// These scripts do not address server durability, Lua runtime errors, or other indexes.
// KEYS: repair owner, scanner owner, journal hash, data hash, version hash.
export const apply = `
for i = 1, 5 do for j = i + 1, 5 do
  if KEYS[i] == KEYS[j] then return redis.error_reply('OVERLAPPING_KEYS') end
end end
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return redis.error_reply('FENCE_LOST') end
if redis.call('EXISTS', KEYS[3]) ~= 0 then return redis.error_reply('journal exists') end
for _, k in ipairs({KEYS[4], KEYS[5]}) do
  local t = redis.call('TYPE', k).ok
  if t ~= 'none' and t ~= 'hash' then return redis.error_reply('wrong type') end
  if redis.call('PTTL', k) >= 0 then return redis.error_reply('expiring key') end
end
local before = redis.call('HGET', KEYS[4], ARGV[3])
local version = redis.call('HGET', KEYS[5], ARGV[3]) or '0'
if not string.match(version, '^%d+$') or tonumber(version) >= 1000000000 then return redis.error_reply('invalid version') end
local nextversion = tostring(tonumber(version) + 1)
redis.call('HSET', KEYS[3], 'field', ARGV[3], 'before', before or '', 'exists', before and '1' or '0', 'version', nextversion)
redis.call('HSET', KEYS[4], ARGV[3], ARGV[4])
redis.call('HSET', KEYS[5], ARGV[3], nextversion)
return 1
`;
export const write = `
if KEYS[1] == KEYS[2] then return redis.error_reply('OVERLAPPING_KEYS') end
local v = redis.call('HGET', KEYS[2], ARGV[1]) or '0'
if not string.match(v, '^%d+$') or tonumber(v) >= 1000000000 then return redis.error_reply('invalid version') end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], tostring(tonumber(v) + 1))
return 1
`;
export const undo = `
for i = 1, 5 do for j = i + 1, 5 do
  if KEYS[i] == KEYS[j] then return redis.error_reply('OVERLAPPING_KEYS') end
end end
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return redis.error_reply('FENCE_LOST') end
local j = redis.call('HMGET', KEYS[3], 'field', 'before', 'exists', 'version')
if not j[1] or not j[2] or (j[3] ~= '0' and j[3] ~= '1') or not j[4] then return redis.error_reply('invalid journal') end
if redis.call('HGET', KEYS[5], j[1]) ~= j[4] then return redis.error_reply('conflict') end
if j[3] == '1' then redis.call('HSET', KEYS[4], j[1], j[2]) else redis.call('HDEL', KEYS[4], j[1]) end
redis.call('HSET', KEYS[5], j[1], tostring(tonumber(j[4]) + 1))
redis.call('DEL', KEYS[3])
return 1
`;
