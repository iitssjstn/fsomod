-- Test van de mod-logica buiten de game, met een nagebootste FS25-omgeving.
-- Uitvoeren:  lua5.1 mod/tests/mod_test.lua   (vanuit de root van de repo)

local failures = 0
local function check(cond, msg)
    if cond then print("  ok   " .. msg) else print("  FAIL " .. msg); failures = failures + 1 end
end

-- ---------- Nep XML-API (in geheugen) ----------
local files, handles, nextHandle = {}, {}, 1
function fileExists(p) return files[p] ~= nil end
function createFolder(p) end
function getUserProfileAppPath() return "/profile/" end
function loadXMLFile(name, path)
    if not files[path] then return 0 end
    local h = nextHandle; nextHandle = nextHandle + 1
    handles[h] = { path = path, props = {} }
    for k, v in pairs(files[path]) do handles[h].props[k] = v end
    return h
end
function createXMLFile(name, path, root)
    local h = nextHandle; nextHandle = nextHandle + 1
    handles[h] = { path = path, props = {} }
    return h
end
function hasXMLProperty(h, key)
    for k in pairs(handles[h].props) do
        if k:sub(1, #key + 1) == key .. "#" or k:sub(1, #key + 1) == key .. "." then return true end
    end
    return false
end
function getXMLString(h, key) return handles[h].props[key] end
function getXMLInt(h, key) local v = handles[h].props[key]; return v and math.floor(tonumber(v)) or nil end
function setXMLString(h, key, v) handles[h].props[key] = tostring(v) end
function setXMLInt(h, key, v) handles[h].props[key] = tostring(v) end
function saveXMLFile(h) files[handles[h].path] = handles[h].props end
function delete(h) handles[h] = nil end

-- ---------- Nep game ----------
g_time = 0
g_currentModName = "FS25_TwitchSabotage"
ToolType = { UNDEFINED = 0 }
MoneyType = { OTHER = 1 }
Drivable = { CRUISECONTROL_STATE_OFF = 0, CRUISECONTROL_STATE_ACTIVE = 1, CRUISECONTROL_STATE_FULL = 2 }
Lights = { TURNLIGHT_OFF = 0, TURNLIGHT_LEFT = 1, TURNLIGHT_RIGHT = 2, TURNLIGHT_HAZARD = 3 }
FSBaseMission = { INGAME_NOTIFICATION_INFO = 1 }
g_fillTypeManager = { getFillTypeIndexByName = function(_, n) return ({ DIESEL = 10, WHEAT = 20 })[n] end }

local notifications = {}
local money = 100000
g_currentMission = {
    paused = false,
    missionInfo = { timeScale = 5 },
    timeScale = 5,
    getIsServer = function() return true end,
    getFarmId = function() return 1 end,
    showBlinkingWarning = function(_, text) table.insert(notifications, text) end,
    addIngameNotification = function() end,
    addMoney = function(_, amount, farmId) money = money + amount; farmMoney[farmId] = (farmMoney[farmId] or 0) + amount end,
    setTimeScale = function(self, s) self.timeScale = s end,
}

local function newFillVehicle(units)
    local v = { spec_fillUnit = { fillUnits = {} }, levels = {}, caps = {}, types = {} }
    for i, u in ipairs(units) do v.spec_fillUnit.fillUnits[i] = {}; v.levels[i] = u.level; v.caps[i] = u.cap; v.types[i] = u.type end
    function v:getFillUnitFillLevel(i) return self.levels[i] end
    function v:getFillUnitCapacity(i) return self.caps[i] end
    function v:getFillUnitFillType(i) return self.types[i] end
    function v:getOwnerFarmId() return 1 end
    function v:addFillUnitFillLevel(farm, i, delta)
        local old = self.levels[i]
        self.levels[i] = math.max(0, math.min(self.caps[i], old + delta))
        return self.levels[i] - old
    end
    return v
end

local mower = newFillVehicle({})
mower.turnedOn = true; mower.damage = 0; mower.dirt = 0; mower.foldDir = 1; mower.folded = 0
mower.spec_foldable = { foldingParts = { {} } }
function mower:getName() return "Maaier" end
function mower:getIsTurnedOn() return self.turnedOn end
function mower:setIsTurnedOn(v) self.turnedOn = v end
function mower:addDamageAmount(a) self.damage = self.damage + a end
function mower:addDirtAmount(a) self.dirt = self.dirt + a end
function mower:getToggledFoldDirection() return -self.foldDir end
function mower:getIsFoldAllowed() return true end
function mower:setFoldState(d) self.foldDir = d; self.folded = self.folded + 1 end

local trailer = newFillVehicle({ { level = 10000, cap = 20000, type = 20 } })

local tractor = newFillVehicle({ { level = 300, cap = 400, type = 10 } })
tractor.spec_motorized = { consumersByFillTypeName = { DIESEL = { fillUnitIndex = 1 } } }
tractor.spec_drivable = { cruiseControl = { maxSpeed = 50 } }
tractor.motor = true; tractor.cc = 0; tractor.ccSpeed = 10; tractor.damage = 0; tractor.dirt = 0
tractor.lights = 3; tractor.beacon = false; tractor.turn = 0; tractor.honking = false
tractor.jointDown = { [1] = true, [2] = true }
tractor.implements = { { object = mower, jointDescIndex = 1 }, { object = trailer, jointDescIndex = 2 } }
function tractor:getRootVehicle() return self end
function tractor:getChildVehicles() return { self } end
function tractor:getAttachedImplements() return self.implements end
function tractor:detachImplementByObject(o)
    for i, impl in ipairs(self.implements) do if impl.object == o then table.remove(self.implements, i); return end end
end
function tractor:getJointMoveDown(i) return self.jointDown[i] end
function tractor:setJointMoveDown(i, d) self.jointDown[i] = d end
function tractor:getIsMotorStarted() return self.motor end
function tractor:stopMotor() self.motor = false end
function tractor:startMotor() self.motor = true end
function tractor:getConsumerFillUnitIndex(ft) if ft == 10 then return 1 end end
function tractor:setCruiseControlMaxSpeed(s) self.ccSpeed = s end
function tractor:setCruiseControlState(s) self.cc = s end
function tractor:addDamageAmount(a) self.damage = self.damage + a end
function tractor:addDirtAmount(a) self.dirt = self.dirt + a end
function tractor:getLightsTypesMask() return self.lights end
function tractor:setLightsTypesMask(m) self.lights = m end
function tractor:getBeaconLightsVisibility() return self.beacon end
function tractor:setBeaconLightsVisibility(v) self.beacon = v end
function tractor:getTurnLightState() return self.turn end
function tractor:setTurnLightState(s) self.turn = s end
function tractor:playHonk(v) self.honking = v end

local inVehicle = tractor
g_localPlayer = {
    getCurrentVehicle = function() return inVehicle end,
    leaveVehicle = function() inVehicle = nil end,
}

function addModEventListener(l) end

-- Netwerk-mocks
local broadcasts, sentToConn = {}, {}
function Class(t, base) return { __index = t } end
Event = { new = function(mt) return setmetatable({}, mt) end }
function InitEventClass() end
g_server = { broadcastEvent = function(_, ev) table.insert(broadcasts, ev) end }
g_currentMission.vehicleSystem = { vehicles = {} }
g_currentMission.playerUserId = 1
g_currentMission.userManager = {
    users = { { id = 1, nick = "Streamer" } },
    getUserByUserId = function(self, id) for _, u in ipairs(self.users) do if u.id == id then return { getNickname = function() return u.nick end, getId = function() return u.id end } end end end,
    getUsers = function(self) local out = {} for _, u in ipairs(self.users) do table.insert(out, { getNickname = function() return u.nick end, getId = function() return u.id end }) end return out end,
}
local farmMoney = { [1] = 100000, [2] = 50000 }
g_farmManager = {
    getFarmByUserId = function(_, userId) return ({ [1] = { farmId = 1 }, [10] = { farmId = 1 }, [11] = { farmId = 2 } })[userId] end,
    getFarmById = function(_, id) return { changeBalance = function(_, a) farmMoney[id] = farmMoney[id] + a end } end,
}

-- ---------- Mod laden ----------
local modDir = (arg and arg[1]) or "mod/FS25_TwitchSabotage/scripts/"
dofile(modDir .. "TwitchSabotageEvent.lua")
dofile(modDir .. "TwitchSabotage.lua")
local TS = TwitchSabotage
TS:loadMap("test")

local INBOX = "/profile/modSettings/FS25_TwitchSabotage/inbox.xml"
local OUTBOX = "/profile/modSettings/FS25_TwitchSabotage/outbox.xml"
local cmdList = {}

local function send(id, action, param, extra)
    local i = #cmdList
    cmdList[#cmdList + 1] = true
    local p = files[INBOX] or { ["inbox#epoch"] = "abc" }
    local k = string.format("inbox.cmd(%d)", i)
    p[k .. "#id"] = tostring(id); p[k .. "#action"] = action; p[k .. "#param"] = param or ""
    p[k .. "#viewer"] = "Kijker"; p[k .. "#source"] = "bits"; p[k .. "#amount"] = "100"; p[k .. "#label"] = action
    p[k .. "#text"] = extra or ""
    files[INBOX] = p
    TS:update(TS.POLL_INTERVAL) -- triggert poll
end

local function result(id)
    local out = files[OUTBOX]
    for i = 0, 100 do
        local k = string.format("outbox.result(%d)", i)
        if out[k .. "#id"] == nil then break end
        if out[k .. "#id"] == tostring(id) then return out[k .. "#status"], out[k .. "#msg"] end
    end
end

print("Acties:")
send(1, "engine_off");      check(tractor.motor == false and result(1) == "ok", "engine_off zet motor uit")
send(2, "engine_off");      check(result(2) == "failed", "engine_off mislukt als motor al uit is (punten terug)")
send(3, "cruise_max");      check(tractor.motor and tractor.cc == 1 and tractor.ccSpeed == 50, "cruise_max start motor + topsnelheid")
send(4, "cruise_slow", "3"); check(tractor.ccSpeed == 3, "cruise_slow zet 3 km/u")
send(5, "fuel_leak", "25"); check(tractor.levels[1] == 225, "fuel_leak haalt 25% weg (300 → 225)")
send(6, "implement_off");   check(mower.turnedOn == false, "implement_off zet maaier uit")
send(7, "implement_lift");  check(tractor.jointDown[1] == false and tractor.jointDown[2] == false, "implement_lift heft alles op")
send(8, "fold_toggle");     check(mower.folded == 1, "fold_toggle klapt maaier")
send(9, "cargo_loss", "50"); check(trailer.levels[1] == 5000 and tractor.levels[1] == 225, "cargo_loss: aanhanger -50%, diesel onaangeroerd")
send(10, "damage", "20");   check(math.abs(tractor.damage - 0.2) < 1e-9 and math.abs(mower.damage - 0.2) < 1e-9, "damage op trekker en maaier")
send(11, "dirt");           check(tractor.dirt == 1 and mower.dirt == 1, "dirt maakt alles vies")
send(12, "lights_off");     check(tractor.lights == 0, "lights_off")
send(13, "money_loss", "5000"); check(money == 95000, "money_loss -5000")
send(14, "honk", "2");      check(tractor.honking == true, "honk start")
TS:update(2500);            check(tractor.honking == false, "honk stopt na 2 s")
send(15, "disco", "2");     check(tractor.beacon == true and tractor.turn == 3, "disco: zwaailicht + alarmlichten")
TS:update(2500);            check(tractor.beacon == false and tractor.turn == 0 and tractor.lights == 0, "disco: lichten hersteld")
send(16, "time_warp", "2"); check(g_currentMission.timeScale == 120, "time_warp → 120x")
TS:update(2500);            check(g_currentMission.timeScale == 5, "time_warp hersteld naar 5x")
tractor.motor = true
send(17, "engine_lock", "2"); check(tractor.motor == false, "engine_lock zet motor uit")
tractor.motor = true; TS:update(100); check(tractor.motor == false, "engine_lock houdt motor uit")
TS:update(2500); tractor.motor = true; TS:update(100); check(tractor.motor == true, "engine_lock voorbij")
send(18, "message", nil, "Hallo boer!"); check(notifications[#notifications]:find("Hallo boer!") ~= nil, "message toont tekst")
send(19, "detach_one");     check(#tractor.implements == 1, "detach_one ontkoppelt één werktuig")
send(20, "detach_all");     check(#tractor.implements == 0, "detach_all ontkoppelt de rest")
send(21, "detach_all");     check(result(21) == "failed", "detach_all mislukt als er niets hangt")
send(22, "bestaat_niet");   check(result(22) == "failed", "onbekende actie → failed")
send(23, "kick_out");       check(inVehicle == nil and result(23) == "ok", "kick_out")
send(24, "engine_off");     check(result(24) == "failed", "niet in voertuig → failed")

print("Protocol:")
local before = #notifications
TS:update(TS.POLL_INTERVAL)
check(#notifications == before, "commando's worden niet dubbel uitgevoerd")
check(files[OUTBOX]["outbox#lastId"] == "24", "outbox lastId = 24")
check(files[OUTBOX]["outbox#epoch"] == "abc", "outbox epoch echo")
files[INBOX] = { ["inbox#epoch"] = "nieuw" }; cmdList = {}
inVehicle = tractor; tractor.motor = true
send(1, "engine_off")
check(tractor.motor == false and result(1) == "ok", "nieuwe epoch: id-teller reset")

print("Multiplayer (dedicated server):")
g_dedicatedServer = {}
g_localPlayer = nil
local function mpTractor(nick, userId)
    local t = newFillVehicle({ { level = 400, cap = 400, type = 10 } })
    t.spec_motorized = { consumersByFillTypeName = { DIESEL = { fillUnitIndex = 1 } } }
    t.spec_enterable = { controllerUserId = userId }
    t.motor = true; t.honking = false; t.implements = {}
    t.conn = { sent = {}, sendEvent = function(c, ev) table.insert(c.sent, ev) end }
    function t:getRootVehicle() return self end
    function t:getIsControlled() return true end
    function t:getControllerName() return nick end
    function t:getOwnerConnection() return self.conn end
    function t:getIsMotorStarted() return self.motor end
    function t:stopMotor() self.motor = false end
    function t:getConsumerFillUnitIndex(ft) if ft == 10 then return 1 end end
    function t:getAttachedImplements() return self.implements end
    function t:playHonk(v) self.honking = v end
    return t
end
local papa, jan = mpTractor("Papa", 10), mpTractor("Jan", 11)
local parked = mpTractor("Niemand", 0); function parked:getIsControlled() return false end
g_currentMission.vehicleSystem.vehicles = { papa, jan, parked }
table.insert(g_currentMission.userManager.users, { id = 10, nick = "Papa" })
table.insert(g_currentMission.userManager.users, { id = 11, nick = "Jan" })

files[INBOX] = { ["inbox#epoch"] = "mp" }; cmdList = {}
local function sendT(id, action, target, player, param)
    local i = #cmdList; cmdList[#cmdList + 1] = true
    local p = files[INBOX]; local k = string.format("inbox.cmd(%d)", i)
    p[k .. "#id"] = tostring(id); p[k .. "#action"] = action; p[k .. "#param"] = param or ""
    p[k .. "#viewer"] = "Kijker"; p[k .. "#source"] = "points"; p[k .. "#amount"] = "1000"; p[k .. "#label"] = action
    p[k .. "#text"] = ""; p[k .. "#target"] = target or ""; p[k .. "#player"] = player or ""
    TS:update(TS.POLL_INTERVAL)
end

local b0 = #broadcasts
sendT(1, "engine_off", "streamer", "papa")
check(papa.motor == false and jan.motor == true, "streamer-doelwit: alleen Papa (hoofdletterongevoelig)")
check(#broadcasts == b0 + 1 and broadcasts[#broadcasts].text:find("Papa") ~= nil, "melding naar alle spelers, met naam slachtoffer")
check(result(1) == "ok", "resultaat ok")
sendT(2, "engine_off", "streamer", "Onbekend")
check(result(2) == "failed", "onbekende speler → failed (punten terug)")
papa.motor = true
sendT(3, "engine_off", "all")
check(papa.motor == false and jan.motor == false, "doelwit iedereen: beide trekkers")
check(parked.motor == true, "geparkeerde trekker zonder bestuurder blijft met rust")
papa.motor = true; jan.motor = true
sendT(4, "engine_off", "random")
check((papa.motor == false) ~= (jan.motor == false), "willekeurig: precies één speler")
sendT(5, "fuel_leak", "streamer", "Jan", "50")
check(jan.levels[1] == 200 and papa.levels[1] == 400, "brandstoflek op de server voor speler Jan")
sendT(6, "kick_out", "streamer", "Jan")
check(#jan.conn.sent == 1 and jan.conn.sent[1].kind == "kick" and #papa.conn.sent == 0, "eruit gooien: kick-bericht alleen naar Jan")
local before2 = farmMoney[2]
sendT(7, "money_loss", "streamer", "Jan", "1000")
check(farmMoney[2] == before2 - 1000, "boete gaat van de boerderij van Jan af")
sendT(8, "message", "streamer", "Papa")
check(broadcasts[#broadcasts].kind == "notify", "bericht op scherm naar iedereen")
sendT(9, "honk", "streamer", "Papa", "1")
TS:update(1500)
check(papa.honking == false, "toeteren stopt weer (timer per voertuig)")

print("Netwerkbericht:")
local shown = {}
local oldShow = TwitchSabotage.showLocal
TwitchSabotage.showLocal = function(t) table.insert(shown, t) end
local ev = TwitchSabotageEvent.new("notify", "Hoi", 1000)
ev:run({ getIsServer = function() return false end })
check(#shown == 0, "bericht van een speler (niet de server) wordt genegeerd")
ev:run({ getIsServer = function() return true end })
check(shown[1] == "Hoi", "bericht van de server wordt getoond")
TwitchSabotage.showLocal = oldShow

print(failures == 0 and "\nALLES GESLAAGD" or ("\n" .. failures .. " TEST(S) MISLUKT"))
if failures > 0 then os.exit(1) end
