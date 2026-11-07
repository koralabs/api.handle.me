// ISOLATED EXPERIMENT ONLY; not connected to application readers or writers.
// All keys must share a cluster slot and all participants must use this protocol.
// Unique lease tokens must never be reused. Direct writers and change-then-restore
// (ABA) are not detected. Lua does not roll back commands after a runtime error;
// an incomplete mutation deliberately leaves the gate closed for manual recovery.
// No claim is made about durability, replication, failover or server data loss.
// Keys: repair lease, scanner lease, gate, reader tokens, journal, hash, holder set,
// address set, payment set, UTxO-slot sorted set, pending-journal set, scanner metrics hash.
// Every key must be distinct.
// A reader holds its unique token until it can no longer emit response bytes.

const common = `
if #KEYS ~= 12 then return redis.error_reply('KEY_COUNT') end
for i = 1, 12 do for j = i + 1, 12 do
  if KEYS[i] == KEYS[j] then return redis.error_reply('OVERLAPPING_KEYS') end
end end
local function typeis(k, expected)
  local t = redis.call('TYPE', k).ok
  return t == 'none' or t == expected
end
local function persistent(k) return redis.call('PTTL', k) == -1 or redis.call('PTTL', k) == -2 end
local function fences()
  return ARGV[1] and ARGV[1] ~= '' and ARGV[2] and ARGV[2] ~= '' and
    redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('PTTL', KEYS[1]) > 0 and
    redis.call('GET', KEYS[2]) == ARGV[2] and redis.call('PTTL', KEYS[2]) > 0
end
local function controls()
  return typeis(KEYS[3], 'string') and persistent(KEYS[3]) and
    typeis(KEYS[4], 'set') and persistent(KEYS[4]) and
    typeis(KEYS[5], 'string') and persistent(KEYS[5]) and
    typeis(KEYS[11], 'set') and persistent(KEYS[11])
end
local function fencedGate()
  if not fences() then return 'FENCE_LOST' end
  if not controls() then return 'INVALID_CONTROL' end
  if not ARGV[3] or ARGV[3] == '' or redis.call('GET', KEYS[3]) ~= ARGV[3] then return 'GATE_NOT_HELD' end
  if redis.call('SCARD', KEYS[4]) ~= 0 then return 'READERS_ACTIVE' end
end
`;

// Reader admission is atomic with gate closure; release is required even if a
// lease expires. Gate closure and reopening both require current live leases.
// ARGV for admit/release: reader token. For close/open: repair, scanner, gate id.
export const readerGate = common + `
local op = ARGV[1]
if op == 'admit' or op == 'release' then
  if not controls() or not ARGV[2] or ARGV[2] == '' then return redis.error_reply('INVALID_CONTROL') end
  if op == 'release' then return redis.call('SREM', KEYS[4], ARGV[2]) end
  if redis.call('EXISTS', KEYS[3], KEYS[5]) ~= 0 or redis.call('SCARD', KEYS[11]) ~= 0 then return 0 end
  return redis.call('SADD', KEYS[4], ARGV[2])
end
if op ~= 'close' and op ~= 'open' then return redis.error_reply('INVALID_OPERATION') end
-- Adapt the shared lease/gate checks to the operation-prefixed arguments.
table.remove(ARGV, 1)
if not fences() then return redis.error_reply('FENCE_LOST') end
if not controls() or not ARGV[3] or ARGV[3] == '' then return redis.error_reply('INVALID_CONTROL') end
if op == 'close' then
  if redis.call('EXISTS', KEYS[3], KEYS[5]) ~= 0 then return 0 end
  redis.call('SET', KEYS[3], ARGV[3]); return 1
end
if redis.call('GET', KEYS[3]) ~= ARGV[3] or redis.call('SCARD', KEYS[4]) ~= 0 or redis.call('EXISTS', KEYS[5]) ~= 0 or redis.call('SCARD', KEYS[11]) ~= 0 then return 0 end
redis.call('DEL', KEYS[3]); return 1
`;

// apply arguments: leases, gate id, hash field/value, then three pairs of
// set member/presence (0 or 1), then sorted-set member/score (or 'absent').
export const apply = common + `
local e = fencedGate(); if e then return redis.error_reply(e) end
if redis.call('EXISTS', KEYS[5]) ~= 0 then return redis.error_reply('JOURNAL_EXISTS') end
if #ARGV ~= 13 then return redis.error_reply('ARG_COUNT') end
if not typeis(KEYS[12], 'hash') or not persistent(KEYS[12]) then return redis.error_reply('INVALID_CURSOR') end
local cursorSlot = redis.call('HGET', KEYS[12], 'currentSlot')
local cursorBlock = redis.call('HGET', KEYS[12], 'currentBlockHash')
if not cursorSlot or not cursorBlock then return redis.error_reply('CURSOR_MISSING') end
for i = 6, 10 do
  local expected = i == 6 and 'hash' or (i == 10 and 'zset' or 'set')
  if not typeis(KEYS[i], expected) or not persistent(KEYS[i]) then return redis.error_reply('INVALID_DATA') end
end
for _, i in ipairs({7, 9, 11}) do if ARGV[i] ~= '0' and ARGV[i] ~= '1' then return redis.error_reply('INVALID_PRESENCE') end end
if ARGV[13] ~= 'absent' then
  local n = tonumber(ARGV[13]); if not n or n ~= n or n == math.huge or n == -math.huge then return redis.error_reply('INVALID_SCORE') end
end
local before = {redis.call('HGET', KEYS[6], ARGV[4]) or false,
  redis.call('SISMEMBER', KEYS[7], ARGV[6]), redis.call('SISMEMBER', KEYS[8], ARGV[8]),
  redis.call('SISMEMBER', KEYS[9], ARGV[10]), redis.call('ZSCORE', KEYS[10], ARGV[12]) or false}
local journal = cjson.encode({keys = {KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10]},
  gate = ARGV[3], cursorKey = KEYS[12], cursorSlot = cursorSlot, cursorBlock = cursorBlock,
  field = ARGV[4], value = ARGV[5], members = {ARGV[6], ARGV[8], ARGV[10], ARGV[12]},
  present = {ARGV[7], ARGV[9], ARGV[11]}, score = ARGV[13], before = before})
redis.call('SADD', KEYS[11], KEYS[5])
redis.call('SET', KEYS[5], journal)
redis.call('HSET', KEYS[6], ARGV[4], ARGV[5])
for i = 1, 3 do
  local member = ARGV[4 + i * 2]
  if ARGV[5 + i * 2] == '1' then redis.call('SADD', KEYS[6+i], member) else redis.call('SREM', KEYS[6+i], member) end
end
if ARGV[13] == 'absent' then redis.call('ZREM', KEYS[10], ARGV[12]) else redis.call('ZADD', KEYS[10], ARGV[13], ARGV[12]) end
return 1
`;

// Recovery validates every postimage before touching any index; conflicts retain
// the journal and closed gate. An explicit partial mode also accepts the recorded
// preimage for each entry, but is unsafe without a proven exclusive writer fence:
// a concurrent writer can create an indistinguishable value. It is experiment only.
// A successor must know the original gate id and pass the exact original data keys.
export const undo = common + `
local e = fencedGate(); if e then return redis.error_reply(e) end
local raw = redis.call('GET', KEYS[5]); if not raw or redis.call('SISMEMBER', KEYS[11], KEYS[5]) ~= 1 then return redis.error_reply('JOURNAL_MISSING') end
local ok, j = pcall(cjson.decode, raw)
if not ok or type(j) ~= 'table' or type(j.keys) ~= 'table' or type(j.members) ~= 'table' or type(j.present) ~= 'table' or type(j.before) ~= 'table' or j.gate ~= ARGV[3] then return redis.error_reply('INVALID_JOURNAL') end
if j.cursorKey ~= KEYS[12] or type(j.cursorSlot) ~= 'string' or type(j.cursorBlock) ~= 'string' then return redis.error_reply('INVALID_JOURNAL') end
if not typeis(KEYS[12], 'hash') or not persistent(KEYS[12]) or redis.call('HGET', KEYS[12], 'currentSlot') ~= j.cursorSlot or redis.call('HGET', KEYS[12], 'currentBlockHash') ~= j.cursorBlock then return redis.error_reply('CURSOR_CONFLICT') end
for i = 1, 5 do
  if j.keys[i] ~= KEYS[i+5] then return redis.error_reply('INVALID_JOURNAL') end
  local expected = i == 1 and 'hash' or (i == 5 and 'zset' or 'set')
  if not typeis(KEYS[i+5], expected) or not persistent(KEYS[i+5]) then return redis.error_reply('CONFLICT') end
end
if type(j.field) ~= 'string' or type(j.value) ~= 'string' or type(j.score) ~= 'string' then return redis.error_reply('INVALID_JOURNAL') end
for i = 1, 4 do if type(j.members[i]) ~= 'string' then return redis.error_reply('INVALID_JOURNAL') end end
for i = 1, 3 do
  if (j.present[i] ~= '0' and j.present[i] ~= '1') or (j.before[i+1] ~= 0 and j.before[i+1] ~= 1) then return redis.error_reply('INVALID_JOURNAL') end
end
if j.before[1] ~= false and type(j.before[1]) ~= 'string' then return redis.error_reply('INVALID_JOURNAL') end
if j.before[5] ~= false and (type(j.before[5]) ~= 'string' or not tonumber(j.before[5])) then return redis.error_reply('INVALID_JOURNAL') end
if j.score ~= 'absent' and not tonumber(j.score) then return redis.error_reply('INVALID_JOURNAL') end
if ARGV[4] and ARGV[4] ~= 'partial' then return redis.error_reply('INVALID_MODE') end
local partial = ARGV[4] == 'partial'
local current = redis.call('HGET', KEYS[6], j.field) or false
if current ~= j.value and not (partial and current == j.before[1]) then return redis.error_reply('CONFLICT') end
for i = 1, 3 do
  local member = redis.call('SISMEMBER', KEYS[6+i], j.members[i])
  if member ~= tonumber(j.present[i]) and not (partial and member == j.before[i+1]) then return redis.error_reply('CONFLICT') end
end
local score = redis.call('ZSCORE', KEYS[10], j.members[4])
local function sameScore(actual, expected)
  if expected == false or expected == 'absent' then return not actual end
  return actual and tonumber(actual) == tonumber(expected)
end
if not sameScore(score, j.score) and not (partial and sameScore(score, j.before[5])) then return redis.error_reply('CONFLICT') end
if j.before[1] == false then redis.call('HDEL', KEYS[6], j.field) else redis.call('HSET', KEYS[6], j.field, j.before[1]) end
for i = 1, 3 do if j.before[i+1] == 1 then redis.call('SADD', KEYS[6+i], j.members[i]) else redis.call('SREM', KEYS[6+i], j.members[i]) end end
if j.before[5] == false then redis.call('ZREM', KEYS[10], j.members[4]) else redis.call('ZADD', KEYS[10], j.before[5], j.members[4]) end
redis.call('DEL', KEYS[5]); redis.call('SREM', KEYS[11], KEYS[5]); return 1
`;
