-- FS25 Twitch Sabotage
-- Leest opdrachten uit modSettings/FS25_TwitchSabotage/inbox.xml en schrijft resultaten + hartslag
-- naar outbox.xml. Die bestanden worden beheerd door:
--   * het Windows-programma (singleplayer / zelf hosten), of
--   * de website via FTP (gehuurde server, bijv. G-Portal).
--
-- De mod voert opdrachten alleen uit op de server (dedicated server, host of singleplayer).
-- Spelers krijgen meldingen via TwitchSabotageEvent.
--
-- Elke actie geeft `true` (gelukt) of `false, "reden"` terug. Bij mislukken krijgt de kijker
-- zijn channel points automatisch terug.

TwitchSabotage = {}
TwitchSabotage.VERSION = "1.1.0"
TwitchSabotage.MOD_NAME = g_currentModName or "FS25_TwitchSabotage"
TwitchSabotage.POLL_INTERVAL = 500        -- ms
TwitchSabotage.HEARTBEAT_INTERVAL = 2000  -- ms
TwitchSabotage.MAX_RESULTS = 50

local LOG_PREFIX = "[TwitchSabotage] "
local function log(fmt, ...) print(LOG_PREFIX .. string.format(fmt, ...)) end

-- ---------------------------------------------------------------------------
-- Spelers en voertuigen
-- ---------------------------------------------------------------------------

local function rootOf(v)
    if v ~= nil and v.getRootVehicle ~= nil then return v:getRootVehicle() or v end
    return v
end

local function userById(userId)
    if userId == nil or g_currentMission.userManager == nil then return nil end
    local ok, user = pcall(function() return g_currentMission.userManager:getUserByUserId(userId) end)
    return ok and user or nil
end

local function nicknameOf(userId)
    local user = userById(userId)
    if user ~= nil and user.getNickname ~= nil then return user:getNickname() end
    return nil
end

-- Alle bestuurde voertuigen: { vehicle, name, userId, isLocal }
local function getDrivers()
    local list, seen = {}, {}
    local function add(v, name, userId, isLocal)
        v = rootOf(v)
        if v == nil or seen[v] then return end
        seen[v] = true
        table.insert(list, { vehicle = v, name = name or "", userId = userId, isLocal = isLocal })
    end

    -- Eigen speler (singleplayer of host)
    if g_localPlayer ~= nil and g_localPlayer.getCurrentVehicle ~= nil then
        local v = g_localPlayer:getCurrentVehicle()
        if v ~= nil then
            local userId = g_currentMission.playerUserId
            add(v, nicknameOf(userId) or (v.getControllerName ~= nil and v:getControllerName()) or "", userId, true)
        end
    end

    -- Andere spelers (multiplayer)
    local vs = g_currentMission.vehicleSystem
    if vs ~= nil and vs.vehicles ~= nil then
        for _, v in pairs(vs.vehicles) do
            if v.getIsControlled ~= nil and v:getIsControlled() and rootOf(v) == v then
                local spec = v.spec_enterable
                add(v, v.getControllerName ~= nil and v:getControllerName() or "", spec and spec.controllerUserId, false)
            end
        end
    end
    return list
end

-- Doelwitten van een opdracht. cmd.target: "streamer" | "random" | "all"; cmd.player: spelernaam streamer.
function TwitchSabotage.getTargets(cmd)
    local drivers = getDrivers()
    local mode = cmd.target ~= "" and cmd.target or "streamer"
    if mode == "all" then return drivers end
    if mode == "random" then
        if #drivers == 0 then return {} end
        return { drivers[math.random(#drivers)] }
    end
    -- streamer
    local wanted = string.lower(cmd.player or "")
    if wanted ~= "" then
        for _, d in ipairs(drivers) do
            if string.lower(d.name) == wanted then return { d } end
        end
        return {}
    end
    for _, d in ipairs(drivers) do
        if d.isLocal then return { d } end
    end
    if #drivers == 1 then return drivers end
    return {}
end

-- Boerderijen van de doelwitten (voor geld). Werkt ook als de streamer niet in een voertuig zit.
local function farmIdsFor(cmd, targets)
    local ids, seen = {}, {}
    local function add(id) if id ~= nil and id ~= 0 and not seen[id] then seen[id] = true; table.insert(ids, id) end end
    local function addUser(userId)
        if userId == nil or g_farmManager == nil then return end
        local farm = g_farmManager:getFarmByUserId(userId)
        if farm ~= nil then add(farm.farmId) end
    end
    for _, t in ipairs(targets) do
        addUser(t.userId)
        if #ids == 0 and t.vehicle.getOwnerFarmId ~= nil then add(t.vehicle:getOwnerFarmId()) end
    end
    if #ids == 0 and (cmd.player or "") ~= "" and g_currentMission.userManager ~= nil then
        for _, user in pairs(g_currentMission.userManager:getUsers() or {}) do
            if user.getNickname ~= nil and string.lower(user:getNickname()) == string.lower(cmd.player) then addUser(user:getId()) end
        end
    end
    if #ids == 0 and g_currentMission.getFarmId ~= nil and g_dedicatedServer == nil then add(g_currentMission:getFarmId()) end
    return ids
end

-- Root + alle gekoppelde werktuigen/aanhangers (zonder dubbelingen).
local function getVehicleChain(root)
    local list, seen = {}, {}
    local function add(v)
        if v ~= nil and not seen[v] then
            seen[v] = true
            table.insert(list, v)
        end
    end
    add(root)
    if root.getChildVehicles ~= nil then
        for _, v in ipairs(root:getChildVehicles() or {}) do add(v) end
    end
    local i = 1
    while i <= #list do
        local v = list[i]
        if v.getAttachedImplements ~= nil then
            for _, impl in ipairs(v:getAttachedImplements()) do add(impl.object) end
        end
        i = i + 1
    end
    return list
end

local function getAttachments(root)
    local out = {}
    for _, v in ipairs(getVehicleChain(root)) do
        if v.getAttachedImplements ~= nil then
            for _, impl in ipairs(v:getAttachedImplements()) do
                if impl.object ~= nil then
                    table.insert(out, { attacher = v, object = impl.object, jointDescIndex = impl.jointDescIndex })
                end
            end
        end
    end
    return out
end

local FUEL_TYPES = { "DIESEL", "ELECTRICCHARGE", "METHANE" }

local function getFuelUnit(vehicle)
    if vehicle.getConsumerFillUnitIndex == nil then return nil end
    for _, name in ipairs(FUEL_TYPES) do
        local fillType = g_fillTypeManager:getFillTypeIndexByName(name)
        if fillType ~= nil then
            local idx = vehicle:getConsumerFillUnitIndex(fillType)
            if idx ~= nil then return idx, fillType end
        end
    end
    return nil
end

local function changeFill(vehicle, fillUnitIndex, delta, fillType)
    fillType = fillType or vehicle:getFillUnitFillType(fillUnitIndex)
    local farmId = vehicle.getOwnerFarmId ~= nil and vehicle:getOwnerFarmId() or 1
    return vehicle:addFillUnitFillLevel(farmId, fillUnitIndex, delta, fillType, ToolType.UNDEFINED, nil)
end

local function consumerUnits(vehicle)
    local set = {}
    local spec = vehicle.spec_motorized
    if spec ~= nil and spec.consumersByFillTypeName ~= nil then
        for _, consumer in pairs(spec.consumersByFillTypeName) do
            if consumer.fillUnitIndex ~= nil then set[consumer.fillUnitIndex] = true end
        end
    end
    return set
end

local function addMoney(amount, farmId)
    local ok = pcall(function()
        g_currentMission:addMoney(amount, farmId, MoneyType.OTHER, true, true)
    end)
    if not ok then
        local farm = g_farmManager:getFarmById(farmId)
        if farm == nil then return false end
        farm:changeBalance(amount, MoneyType.OTHER)
    end
    return true
end

-- ---------------------------------------------------------------------------
-- Voertuig-acties: function(self, cmd, root, target) -> ok, msg
-- ---------------------------------------------------------------------------

local A = {}

A.engine_off = function(self, cmd, root)
    if root.stopMotor == nil then return false, "geen motor" end
    if root.getIsMotorStarted ~= nil and not root:getIsMotorStarted() then return false, "motor stond al uit" end
    root:stopMotor()
    return true
end

A.engine_lock = function(self, cmd, root)
    if root.stopMotor == nil then return false, "geen motor" end
    local seconds = math.max(1, tonumber(cmd.param) or 20)
    root:stopMotor()
    self:addTimer("engine_lock", root, seconds * 1000, function()
        if root.getIsMotorStarted ~= nil and root:getIsMotorStarted() then root:stopMotor() end
    end)
    return true, string.format("%d s", seconds)
end

local function cruise(root, speed)
    if root.setCruiseControlState == nil then return false, "geen cruise control" end
    if root.getIsMotorStarted ~= nil and not root:getIsMotorStarted() and root.startMotor ~= nil then
        root:startMotor()
    end
    local cc = root.spec_drivable and root.spec_drivable.cruiseControl
    if speed == nil and cc ~= nil then speed = cc.maxSpeed end
    root:setCruiseControlMaxSpeed(speed)
    root:setCruiseControlState(Drivable.CRUISECONTROL_STATE_ACTIVE)
    return true
end

A.cruise_max = function(self, cmd, root) return cruise(root, nil) end
A.cruise_slow = function(self, cmd, root) return cruise(root, math.max(1, tonumber(cmd.param) or 3)) end

A.kick_out = function(self, cmd, root, target)
    if target.isLocal then
        if g_localPlayer ~= nil and g_localPlayer.leaveVehicle ~= nil then
            g_localPlayer:leaveVehicle()
            return true
        end
        return false, "uitstappen niet mogelijk"
    end
    local conn = root.getOwnerConnection ~= nil and root:getOwnerConnection() or nil
    if conn == nil then return false, "speler niet gevonden" end
    conn:sendEvent(TwitchSabotageEvent.new("kick", "", 0))
    return true
end

A.fuel_leak = function(self, cmd, root)
    local idx, fillType = getFuelUnit(root)
    if idx == nil then return false, "geen brandstoftank" end
    local pct = math.min(100, math.max(1, tonumber(cmd.param) or 25)) / 100
    local level = root:getFillUnitFillLevel(idx)
    if level <= 0 then return false, "tank is al leeg" end
    changeFill(root, idx, -level * pct, fillType)
    return true, string.format("-%d liter", math.floor(level * pct))
end

A.fuel_empty = function(self, cmd, root)
    local idx, fillType = getFuelUnit(root)
    if idx == nil then return false, "geen brandstoftank" end
    local target = root:getFillUnitCapacity(idx) * 0.05
    local level = root:getFillUnitFillLevel(idx)
    if level <= target then return false, "tank is al (bijna) leeg" end
    changeFill(root, idx, target - level, fillType)
    return true
end

A.refuel = function(self, cmd, root)
    local idx, fillType = getFuelUnit(root)
    if idx == nil then return false, "geen brandstoftank" end
    changeFill(root, idx, root:getFillUnitCapacity(idx), fillType)
    return true
end

A.damage = function(self, cmd, root)
    local amount = math.min(100, math.max(1, tonumber(cmd.param) or 20)) / 100
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.addDamageAmount ~= nil then v:addDamageAmount(amount, true); n = n + 1 end
    end
    if n == 0 then return false, "geen schade-systeem" end
    return true
end

A.dirt = function(self, cmd, root)
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.addDirtAmount ~= nil then v:addDirtAmount(1, true); n = n + 1 end
    end
    if n == 0 then return false, "kan niet vies worden" end
    return true
end

A.repair = function(self, cmd, root)
    for _, v in ipairs(getVehicleChain(root)) do
        if v.repairVehicle ~= nil then v:repairVehicle() elseif v.setDamageAmount ~= nil then v:setDamageAmount(0, true) end
        if v.addDirtAmount ~= nil then v:addDirtAmount(-1, true) end
    end
    return true
end

A.detach_one = function(self, cmd, root)
    local list = getAttachments(root)
    if #list == 0 then return false, "niets gekoppeld" end
    local pick = list[math.random(#list)]
    pick.attacher:detachImplementByObject(pick.object)
    return true, pick.object.getName ~= nil and pick.object:getName() or nil
end

A.detach_all = function(self, cmd, root)
    local list = getAttachments(root)
    if #list == 0 then return false, "niets gekoppeld" end
    -- Alleen wat direct aan de trekker hangt; daaraan gekoppelde aanhangers gaan mee.
    local n = 0
    for _, a in ipairs(list) do
        if a.attacher == root then root:detachImplementByObject(a.object); n = n + 1 end
    end
    if n == 0 then list[1].attacher:detachImplementByObject(list[1].object); n = 1 end
    return true, string.format("%d werktuig(en)", n)
end

A.implement_off = function(self, cmd, root)
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.getIsTurnedOn ~= nil and v.setIsTurnedOn ~= nil and v:getIsTurnedOn() then
            v:setIsTurnedOn(false); n = n + 1
        end
    end
    if n == 0 then return false, "geen werktuig stond aan" end
    return true
end

A.implement_lift = function(self, cmd, root)
    local n, target = 0, nil
    for _, a in ipairs(getAttachments(root)) do
        if a.attacher.setJointMoveDown ~= nil and a.jointDescIndex ~= nil then
            if target == nil then target = not a.attacher:getJointMoveDown(a.jointDescIndex) end
            a.attacher:setJointMoveDown(a.jointDescIndex, target)
            n = n + 1
        end
    end
    if n == 0 then return false, "geen hefbaar werktuig" end
    return true, target and "omlaag" or "omhoog"
end

A.fold_toggle = function(self, cmd, root)
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.getToggledFoldDirection ~= nil and v.setFoldState ~= nil and v.spec_foldable ~= nil and #(v.spec_foldable.foldingParts or {}) > 0 then
            local dir = v:getToggledFoldDirection()
            local allowed = true
            if v.getIsFoldAllowed ~= nil then allowed = v:getIsFoldAllowed(dir, false) end
            if allowed then v:setFoldState(dir, false); n = n + 1 end
        end
    end
    if n == 0 then return false, "niets om te klappen" end
    return true
end

A.cargo_loss = function(self, cmd, root)
    local pct = math.min(100, math.max(1, tonumber(cmd.param) or 50)) / 100
    local removed = 0
    for _, v in ipairs(getVehicleChain(root)) do
        local spec = v.spec_fillUnit
        if spec ~= nil and spec.fillUnits ~= nil and v.getFillUnitFillLevel ~= nil then
            local skip = consumerUnits(v)
            for idx = 1, #spec.fillUnits do
                if not skip[idx] then
                    local level = v:getFillUnitFillLevel(idx)
                    if level > 0 then
                        removed = removed + math.abs(changeFill(v, idx, -level * pct) or level * pct)
                    end
                end
            end
        end
    end
    if removed <= 0 then return false, "geen lading" end
    return true, string.format("-%d liter", math.floor(removed))
end

A.lights_off = function(self, cmd, root)
    if root.setLightsTypesMask == nil then return false, "geen lichten" end
    root:setLightsTypesMask(0, true)
    if root.setBeaconLightsVisibility ~= nil then root:setBeaconLightsVisibility(false, true) end
    return true
end

A.disco = function(self, cmd, root)
    if root.setLightsTypesMask == nil then return false, "geen lichten" end
    local seconds = math.max(2, tonumber(cmd.param) or 20)
    local oldMask = root:getLightsTypesMask()
    local oldBeacon = root.getBeaconLightsVisibility ~= nil and root:getBeaconLightsVisibility() or false
    local oldTurn = root.getTurnLightState ~= nil and root:getTurnLightState() or Lights.TURNLIGHT_OFF
    if root.setBeaconLightsVisibility ~= nil then root:setBeaconLightsVisibility(true, true) end
    if root.setTurnLightState ~= nil then root:setTurnLightState(Lights.TURNLIGHT_HAZARD, true) end
    local acc, on = 0, false
    self:addTimer("disco", root, seconds * 1000, function(dt)
        acc = acc + dt
        if acc >= 400 then
            acc = 0; on = not on
            root:setLightsTypesMask(on and 15 or 0, true)
        end
    end, function()
        root:setLightsTypesMask(oldMask, true)
        if root.setBeaconLightsVisibility ~= nil then root:setBeaconLightsVisibility(oldBeacon, true) end
        if root.setTurnLightState ~= nil then root:setTurnLightState(oldTurn, true) end
    end)
    return true
end

A.honk = function(self, cmd, root)
    if root.playHonk == nil then return false, "geen toeter" end
    local seconds = math.min(30, math.max(1, tonumber(cmd.param) or 4))
    root:playHonk(true)
    self:addTimer("honk", root, seconds * 1000, nil, function() root:playHonk(false) end)
    return true
end

A.random = function(self, cmd, root, target)
    local pool = { "engine_off", "cruise_slow", "honk", "lights_off", "dirt", "implement_lift", "detach_one" }
    return A[pool[math.random(#pool)]](self, cmd, root, target)
end

-- ---------------------------------------------------------------------------
-- Acties zonder voertuig: function(self, cmd, targets) -> ok, msg
-- ---------------------------------------------------------------------------

local G = {}

local function moneyAction(sign)
    return function(self, cmd, targets)
        local amount = math.max(1, tonumber(cmd.param) or 5000)
        local farms = farmIdsFor(cmd, targets)
        if #farms == 0 then return false, "boerderij van de speler niet gevonden" end
        for _, farmId in ipairs(farms) do addMoney(sign * amount, farmId) end
        return true, string.format("%s€%d", sign < 0 and "-" or "+", amount)
    end
end
G.money_loss = moneyAction(-1)
G.money_gift = moneyAction(1)

G.time_warp = function(self, cmd)
    if g_currentMission.setTimeScale == nil then return false, "tijd aanpassen niet mogelijk" end
    local seconds = math.max(1, tonumber(cmd.param) or 20)
    if self.timeWarpRestore == nil then self.timeWarpRestore = g_currentMission.missionInfo.timeScale or 1 end
    g_currentMission:setTimeScale(120)
    self:addTimer("time_warp", "world", seconds * 1000, nil, function()
        g_currentMission:setTimeScale(self.timeWarpRestore or 1)
        self.timeWarpRestore = nil
    end)
    return true
end

G.message = function(self, cmd)
    local text = cmd.text ~= "" and cmd.text or "(leeg bericht)"
    self:notifyAll(string.format("%s: %s", cmd.viewer, text), 8000)
    return true
end

TwitchSabotage.ACTIONS = A
TwitchSabotage.GLOBAL_ACTIONS = G

-- ---------------------------------------------------------------------------
-- Levenscyclus
-- ---------------------------------------------------------------------------

function TwitchSabotage:loadMap(name)
    self.dir = getUserProfileAppPath() .. "modSettings/" .. TwitchSabotage.MOD_NAME .. "/"
    self.inboxPath = self.dir .. "inbox.xml"
    self.outboxPath = self.dir .. "outbox.xml"
    self.epoch = nil
    self.lastId = 0
    self.results = {}
    self.timers = {}
    self.pollTimer = 0
    self.heartbeatTimer = 0
    self.beat = 0
    -- Alleen de server (dedicated, host of singleplayer) voert opdrachten uit.
    self.enabled = g_currentMission:getIsServer()
    if self.enabled then
        createFolder(getUserProfileAppPath() .. "modSettings/")
        createFolder(self.dir)
        log("v%s geladen (server), map: %s", TwitchSabotage.VERSION, self.dir)
    else
        log("v%s geladen (speler): meldingen komen van de server", TwitchSabotage.VERSION)
    end
end

function TwitchSabotage:deleteMap()
    for key, _ in pairs(self.timers or {}) do self:finishTimer(key) end
end

function TwitchSabotage:update(dt)
    if not self.enabled then return end
    self:updateTimers(dt)

    if g_currentMission.paused then return end -- gepauzeerd: geen hartslag → sabotage wacht

    self.pollTimer = self.pollTimer + dt
    if self.pollTimer >= TwitchSabotage.POLL_INTERVAL then
        self.pollTimer = 0
        local ok, err = pcall(self.poll, self)
        if not ok then log("Fout bij lezen inbox: %s", tostring(err)) end
    end

    self.heartbeatTimer = self.heartbeatTimer + dt
    if self.heartbeatTimer >= TwitchSabotage.HEARTBEAT_INTERVAL then
        self.heartbeatTimer = 0
        self:writeOutbox()
    end
end

-- ---------------------------------------------------------------------------
-- Timers (per effect en per voertuig, zodat twee spelers tegelijk disco kunnen hebben)
-- ---------------------------------------------------------------------------

function TwitchSabotage:addTimer(name, owner, duration, onTick, onEnd)
    local key = name .. ":" .. tostring(owner)
    if self.timers[key] ~= nil then
        self.timers[key].remaining = self.timers[key].remaining + duration
        return
    end
    self.timers[key] = { remaining = duration, onTick = onTick, onEnd = onEnd }
end

function TwitchSabotage:finishTimer(key)
    local t = self.timers[key]
    self.timers[key] = nil
    if t ~= nil and t.onEnd ~= nil then
        local ok, err = pcall(t.onEnd)
        if not ok then log("Timer %s: %s", key, tostring(err)) end
    end
end

function TwitchSabotage:updateTimers(dt)
    for key, t in pairs(self.timers) do
        t.remaining = t.remaining - dt
        if t.onTick ~= nil then
            local ok, err = pcall(t.onTick, dt)
            if not ok then log("Timer %s: %s", key, tostring(err)); t.remaining = 0 end
        end
        if t.remaining <= 0 then self:finishTimer(key) end
    end
end

-- ---------------------------------------------------------------------------
-- Bestanden
-- ---------------------------------------------------------------------------

function TwitchSabotage:poll()
    if not fileExists(self.inboxPath) then return end
    local xml = loadXMLFile("TwitchSabotageInbox", self.inboxPath)
    if xml == nil or xml == 0 then return end

    local epoch = getXMLString(xml, "inbox#epoch") or ""
    if epoch ~= self.epoch then
        self.epoch = epoch
        self.lastId = 0
        self.results = {}
    end

    local cmds = {}
    local i = 0
    while true do
        local key = string.format("inbox.cmd(%d)", i)
        if not hasXMLProperty(xml, key) then break end
        table.insert(cmds, {
            id = getXMLInt(xml, key .. "#id") or 0,
            action = getXMLString(xml, key .. "#action") or "",
            param = getXMLString(xml, key .. "#param") or "",
            viewer = getXMLString(xml, key .. "#viewer") or "?",
            source = getXMLString(xml, key .. "#source") or "",
            amount = getXMLInt(xml, key .. "#amount") or 0,
            label = getXMLString(xml, key .. "#label") or "",
            text = getXMLString(xml, key .. "#text") or "",
            target = getXMLString(xml, key .. "#target") or "",
            player = getXMLString(xml, key .. "#player") or "",
        })
        i = i + 1
    end
    delete(xml)

    table.sort(cmds, function(a, b) return a.id < b.id end)
    local changed = false
    for _, cmd in ipairs(cmds) do
        if cmd.id > self.lastId then
            self:execute(cmd)
            self.lastId = cmd.id
            changed = true
        end
    end
    if changed then self:writeOutbox() end
end

function TwitchSabotage:execute(cmd)
    local success, msg, names = false, nil, {}
    local ok, err = pcall(function()
        local targets = TwitchSabotage.getTargets(cmd)
        local global = G[cmd.action]
        local handler = A[cmd.action]

        if global ~= nil then
            success, msg = global(self, cmd, targets)
            for _, t in ipairs(targets) do if t.name ~= "" then table.insert(names, t.name) end end
        elseif handler ~= nil then
            if #targets == 0 then
                msg = (cmd.player ~= "" and cmd.target ~= "random" and cmd.target ~= "all")
                    and string.format("%s zit niet in een voertuig", cmd.player)
                    or "niemand zit in een voertuig"
                return
            end
            local reasons = {}
            for _, t in ipairs(targets) do
                local r1, r2 = handler(self, cmd, t.vehicle, t)
                if r1 == true then
                    success = true
                    table.insert(names, t.name ~= "" and t.name or "?")
                    if r2 ~= nil and #targets == 1 then msg = r2 end
                elseif r2 ~= nil then
                    table.insert(reasons, r2)
                end
            end
            if not success then msg = reasons[1] end
        else
            msg = "onbekende actie (mod updaten?)"
        end
    end)
    if not ok then
        success, msg = false, "scriptfout"
        log("Actie %s mislukt: %s", cmd.action, tostring(err))
    end

    if success and cmd.action ~= "message" then
        local who = cmd.viewer
        if cmd.source == "bits" then who = string.format("%s (%d bits)", cmd.viewer, cmd.amount)
        elseif cmd.source == "points" then who = string.format("%s (%d punten)", cmd.viewer, cmd.amount) end
        local victims = #names > 0 and (" → " .. table.concat(names, ", ")) or ""
        self:notifyAll(string.format("%s: %s!%s", who, cmd.label ~= "" and cmd.label or cmd.action, victims), 4500)
    end
    if success and #names > 0 and (msg == nil or msg == "") then msg = table.concat(names, ", ") end
    log("#%d %s door %s → %s %s", cmd.id, cmd.action, cmd.viewer, success and "OK" or "MISLUKT", msg or "")

    table.insert(self.results, { id = cmd.id, action = cmd.action, status = success and "ok" or "failed", msg = msg or "" })
    while #self.results > TwitchSabotage.MAX_RESULTS do table.remove(self.results, 1) end
end

function TwitchSabotage:writeOutbox()
    self.beat = self.beat + 1
    local xml = createXMLFile("TwitchSabotageOutbox", self.outboxPath, "outbox")
    if xml == nil or xml == 0 then return end
    setXMLString(xml, "outbox#version", TwitchSabotage.VERSION)
    setXMLString(xml, "outbox#epoch", self.epoch or "")
    setXMLInt(xml, "outbox#lastId", self.lastId)
    setXMLInt(xml, "outbox#beat", self.beat)
    setXMLString(xml, "outbox#time", tostring(g_time or 0))
    for i, r in ipairs(self.results) do
        local key = string.format("outbox.result(%d)", i - 1)
        setXMLInt(xml, key .. "#id", r.id)
        setXMLString(xml, key .. "#action", r.action)
        setXMLString(xml, key .. "#status", r.status)
        setXMLString(xml, key .. "#msg", r.msg)
    end
    saveXMLFile(xml)
    delete(xml)
end

-- ---------------------------------------------------------------------------
-- Meldingen
-- ---------------------------------------------------------------------------

-- Melding bij deze speler in beeld (niet op een dedicated server, die heeft geen scherm).
function TwitchSabotage.showLocal(text, duration)
    if g_dedicatedServer ~= nil then return end
    duration = duration or 4000
    local shown = pcall(function() g_currentMission:showBlinkingWarning(text, duration) end)
    pcall(function() g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, text) end)
    if not shown then log("%s", text) end
end

-- Melding bij iedereen: lokaal + naar alle verbonden spelers.
function TwitchSabotage:notifyAll(text, duration)
    TwitchSabotage.showLocal(text, duration)
    if g_server ~= nil and TwitchSabotageEvent ~= nil then
        pcall(function() g_server:broadcastEvent(TwitchSabotageEvent.new("notify", text, duration or 4000)) end)
    end
end

addModEventListener(TwitchSabotage)
