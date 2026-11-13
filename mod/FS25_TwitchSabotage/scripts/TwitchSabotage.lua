-- FS25 Twitch Sabotage
-- Leest opdrachten uit modSettings/FS25_TwitchSabotage/inbox.xml (geschreven door het hulpprogramma)
-- en schrijft resultaten + een hartslag naar outbox.xml.
--
-- Elke actie geeft `true` (gelukt) of `false, "reden"` terug. Bij mislukken krijgt de kijker
-- zijn channel points automatisch terug.

TwitchSabotage = {}
TwitchSabotage.VERSION = "1.0.0"
TwitchSabotage.MOD_NAME = g_currentModName or "FS25_TwitchSabotage"
TwitchSabotage.POLL_INTERVAL = 500        -- ms
TwitchSabotage.HEARTBEAT_INTERVAL = 2000  -- ms
TwitchSabotage.MAX_RESULTS = 50

local LOG_PREFIX = "[TwitchSabotage] "
local function log(fmt, ...) print(LOG_PREFIX .. string.format(fmt, ...)) end

-- ---------------------------------------------------------------------------
-- Hulpfuncties voor voertuigen
-- ---------------------------------------------------------------------------

local function getRootVehicle()
    local vehicle = nil
    if g_localPlayer ~= nil and g_localPlayer.getCurrentVehicle ~= nil then
        vehicle = g_localPlayer:getCurrentVehicle()
    end
    if vehicle == nil and g_currentMission ~= nil then
        vehicle = g_currentMission.controlledVehicle
    end
    if vehicle ~= nil and vehicle.getRootVehicle ~= nil then
        vehicle = vehicle:getRootVehicle() or vehicle
    end
    return vehicle
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

local function requireVehicle()
    local root = getRootVehicle()
    if root == nil then return nil, "Speler zit niet in een voertuig" end
    return root
end

-- Alle (koppelaar, werktuig, jointDescIndex) in de keten.
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

local function getFarmId(vehicle)
    if vehicle ~= nil and vehicle.getOwnerFarmId ~= nil then return vehicle:getOwnerFarmId() end
    if g_currentMission ~= nil and g_currentMission.getFarmId ~= nil then return g_currentMission:getFarmId() end
    return 1
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
    return vehicle:addFillUnitFillLevel(getFarmId(vehicle), fillUnitIndex, delta, fillType, ToolType.UNDEFINED, nil)
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

local function isServer()
    return g_currentMission ~= nil and g_currentMission:getIsServer()
end

local function addMoney(amount, farmId)
    if not isServer() then return false, "Alleen de host kan geld aanpassen" end
    local ok = pcall(function()
        g_currentMission:addMoney(amount, farmId, MoneyType.OTHER, true, true)
    end)
    if not ok then
        local farm = g_farmManager:getFarmById(farmId)
        if farm == nil then return false, "Boerderij niet gevonden" end
        farm:changeBalance(amount, MoneyType.OTHER)
    end
    return true
end

-- ---------------------------------------------------------------------------
-- Acties
-- ---------------------------------------------------------------------------

local A = {}

A.engine_off = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    if root.stopMotor == nil then return false, "Voertuig heeft geen motor" end
    if root.getIsMotorStarted ~= nil and not root:getIsMotorStarted() then return false, "Motor stond al uit" end
    root:stopMotor()
    return true
end

A.engine_lock = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    if root.stopMotor == nil then return false, "Voertuig heeft geen motor" end
    local seconds = math.max(1, tonumber(cmd.param) or 20)
    root:stopMotor()
    self:addTimer("engine_lock", seconds * 1000, function()
        if root.getIsMotorStarted ~= nil and root:getIsMotorStarted() then root:stopMotor() end
    end, function()
        self:notify(string.format("Motorblokkade voorbij"), 2000)
    end)
    return true, string.format("%d s", seconds)
end

local function cruise(root, speed)
    if root.setCruiseControlState == nil then return false, "Voertuig heeft geen cruise control" end
    if root.getIsMotorStarted ~= nil and not root:getIsMotorStarted() and root.startMotor ~= nil then
        root:startMotor()
    end
    local cc = root.spec_drivable and root.spec_drivable.cruiseControl
    if speed == nil and cc ~= nil then speed = cc.maxSpeed end
    root:setCruiseControlMaxSpeed(speed)
    root:setCruiseControlState(Drivable.CRUISECONTROL_STATE_ACTIVE)
    return true
end

A.cruise_max = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    return cruise(root, nil)
end

A.cruise_slow = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    return cruise(root, math.max(1, tonumber(cmd.param) or 3))
end

A.kick_out = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    if g_localPlayer ~= nil and g_localPlayer.leaveVehicle ~= nil then
        g_localPlayer:leaveVehicle()
        return true
    end
    return false, "Uitstappen niet mogelijk"
end

A.fuel_leak = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local idx, fillType = getFuelUnit(root)
    if idx == nil then return false, "Geen brandstoftank gevonden" end
    local pct = math.min(100, math.max(1, tonumber(cmd.param) or 25)) / 100
    local level = root:getFillUnitFillLevel(idx)
    if level <= 0 then return false, "Tank is al leeg" end
    changeFill(root, idx, -level * pct, fillType)
    return true, string.format("-%d liter", math.floor(level * pct))
end

A.fuel_empty = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local idx, fillType = getFuelUnit(root)
    if idx == nil then return false, "Geen brandstoftank gevonden" end
    local target = root:getFillUnitCapacity(idx) * 0.05
    local level = root:getFillUnitFillLevel(idx)
    if level <= target then return false, "Tank is al (bijna) leeg" end
    changeFill(root, idx, target - level, fillType)
    return true
end

A.refuel = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local idx, fillType = getFuelUnit(root)
    if idx == nil then return false, "Geen brandstoftank gevonden" end
    changeFill(root, idx, root:getFillUnitCapacity(idx), fillType)
    return true
end

A.damage = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local amount = math.min(100, math.max(1, tonumber(cmd.param) or 20)) / 100
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.addDamageAmount ~= nil then v:addDamageAmount(amount, true); n = n + 1 end
    end
    if n == 0 then return false, "Geen voertuig met schade-systeem" end
    return true
end

A.dirt = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.addDirtAmount ~= nil then v:addDirtAmount(1, true); n = n + 1 end
    end
    if n == 0 then return false, "Kan niet vies worden" end
    return true
end

A.repair = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    for _, v in ipairs(getVehicleChain(root)) do
        if v.repairVehicle ~= nil then v:repairVehicle() elseif v.setDamageAmount ~= nil then v:setDamageAmount(0, true) end
        if v.addDirtAmount ~= nil then v:addDirtAmount(-1, true) end
    end
    return true
end

A.detach_one = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local list = getAttachments(root)
    if #list == 0 then return false, "Niets gekoppeld" end
    local pick = list[math.random(#list)]
    pick.attacher:detachImplementByObject(pick.object)
    local name = pick.object.getName ~= nil and pick.object:getName() or "werktuig"
    return true, name
end

A.detach_all = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local list = getAttachments(root)
    if #list == 0 then return false, "Niets gekoppeld" end
    -- Alleen wat direct aan de trekker hangt; daaraan gekoppelde aanhangers gaan mee.
    local n = 0
    for _, a in ipairs(list) do
        if a.attacher == root then root:detachImplementByObject(a.object); n = n + 1 end
    end
    if n == 0 then list[1].attacher:detachImplementByObject(list[1].object); n = 1 end
    return true, string.format("%d werktuig(en)", n)
end

A.implement_off = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.getIsTurnedOn ~= nil and v.setIsTurnedOn ~= nil and v:getIsTurnedOn() then
            v:setIsTurnedOn(false); n = n + 1
        end
    end
    if n == 0 then return false, "Geen werktuig stond aan" end
    return true
end

A.implement_lift = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local list = getAttachments(root)
    local n, target = 0, nil
    for _, a in ipairs(list) do
        if a.attacher.setJointMoveDown ~= nil and a.jointDescIndex ~= nil then
            if target == nil then target = not a.attacher:getJointMoveDown(a.jointDescIndex) end
            a.attacher:setJointMoveDown(a.jointDescIndex, target)
            n = n + 1
        end
    end
    if n == 0 then return false, "Geen hefbaar werktuig" end
    return true, target and "omlaag" or "omhoog"
end

A.fold_toggle = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    local n = 0
    for _, v in ipairs(getVehicleChain(root)) do
        if v.getToggledFoldDirection ~= nil and v.setFoldState ~= nil and v.spec_foldable ~= nil and #(v.spec_foldable.foldingParts or {}) > 0 then
            local dir = v:getToggledFoldDirection()
            local allowed = true
            if v.getIsFoldAllowed ~= nil then allowed = v:getIsFoldAllowed(dir, false) end
            if allowed then v:setFoldState(dir, false); n = n + 1 end
        end
    end
    if n == 0 then return false, "Niets om te klappen" end
    return true
end

A.cargo_loss = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
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
    if removed <= 0 then return false, "Geen lading gevonden" end
    return true, string.format("-%d liter", math.floor(removed))
end

A.lights_off = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    if root.setLightsTypesMask == nil then return false, "Geen lichten" end
    root:setLightsTypesMask(0, true)
    if root.setBeaconLightsVisibility ~= nil then root:setBeaconLightsVisibility(false, true) end
    return true
end

A.disco = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    if root.setLightsTypesMask == nil then return false, "Geen lichten" end
    local seconds = math.max(2, tonumber(cmd.param) or 20)
    local oldMask = root:getLightsTypesMask()
    local oldBeacon = root.getBeaconLightsVisibility ~= nil and root:getBeaconLightsVisibility() or false
    local oldTurn = root.getTurnLightState ~= nil and root:getTurnLightState() or Lights.TURNLIGHT_OFF
    if root.setBeaconLightsVisibility ~= nil then root:setBeaconLightsVisibility(true, true) end
    if root.setTurnLightState ~= nil then root:setTurnLightState(Lights.TURNLIGHT_HAZARD, true) end
    local acc, on = 0, false
    self:addTimer("disco", seconds * 1000, function(dt)
        acc = acc + dt
        if acc >= 350 then
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

A.honk = function(self, cmd)
    local root, err = requireVehicle(); if root == nil then return false, err end
    if root.playHonk == nil then return false, "Geen toeter" end
    local seconds = math.min(30, math.max(1, tonumber(cmd.param) or 4))
    root:playHonk(true)
    self:addTimer("honk", seconds * 1000, nil, function() root:playHonk(false) end)
    return true
end

A.money_loss = function(self, cmd)
    local amount = math.max(1, tonumber(cmd.param) or 5000)
    local ok, err = addMoney(-amount, getFarmId(getRootVehicle()))
    if not ok then return false, err end
    return true, string.format("-€%d", amount)
end

A.money_gift = function(self, cmd)
    local amount = math.max(1, tonumber(cmd.param) or 5000)
    local ok, err = addMoney(amount, getFarmId(getRootVehicle()))
    if not ok then return false, err end
    return true, string.format("+€%d", amount)
end

A.time_warp = function(self, cmd)
    if not isServer() then return false, "Alleen de host kan de tijd aanpassen" end
    if g_currentMission.setTimeScale == nil then return false, "Tijd aanpassen niet mogelijk" end
    local seconds = math.max(1, tonumber(cmd.param) or 20)
    local old = g_currentMission.missionInfo.timeScale or 1
    if self.timers.time_warp ~= nil then old = self.timeWarpRestore or old end
    self.timeWarpRestore = old
    g_currentMission:setTimeScale(120)
    self:addTimer("time_warp", seconds * 1000, nil, function()
        g_currentMission:setTimeScale(self.timeWarpRestore or 1)
        self.timeWarpRestore = nil
    end)
    return true
end

A.message = function(self, cmd)
    local text = cmd.text ~= "" and cmd.text or "(leeg bericht)"
    self:notify(string.format("%s: %s", cmd.viewer, text), 8000)
    return true
end

A.random = function(self, cmd)
    local pool = { "engine_off", "cruise_slow", "honk", "lights_off", "dirt", "implement_lift", "detach_one" }
    local pick = pool[math.random(#pool)]
    return A[pick](self, cmd)
end

TwitchSabotage.ACTIONS = A

-- ---------------------------------------------------------------------------
-- Levenscyclus
-- ---------------------------------------------------------------------------

function TwitchSabotage:loadMap(name)
    self.dir = getUserProfileAppPath() .. "modSettings/" .. TwitchSabotage.MOD_NAME .. "/"
    createFolder(getUserProfileAppPath() .. "modSettings/")
    createFolder(self.dir)
    self.inboxPath = self.dir .. "inbox.xml"
    self.outboxPath = self.dir .. "outbox.xml"
    self.epoch = nil
    self.lastId = 0
    self.results = {}
    self.timers = {}
    self.pollTimer = 0
    self.heartbeatTimer = 0
    self.enabled = g_dedicatedServer == nil  -- op een dedicated server doet de mod niets
    log("v%s geladen, map: %s", TwitchSabotage.VERSION, self.dir)
end

function TwitchSabotage:deleteMap()
    for id, _ in pairs(self.timers or {}) do self:finishTimer(id) end
    -- Hartslag stopt: het hulpprogramma ziet dat de game niet meer actief is.
end

function TwitchSabotage:update(dt)
    if not self.enabled then return end
    self:updateTimers(dt)

    if g_currentMission ~= nil and g_currentMission.paused then return end -- gepauzeerd: geen hartslag → server wacht

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
-- Timers (voor acties die een tijdje duren)
-- ---------------------------------------------------------------------------

function TwitchSabotage:addTimer(id, duration, onTick, onEnd)
    if self.timers[id] ~= nil then
        -- Zelfde effect nogmaals: verleng in plaats van dubbel starten.
        self.timers[id].remaining = self.timers[id].remaining + duration
        return
    end
    self.timers[id] = { remaining = duration, onTick = onTick, onEnd = onEnd }
end

function TwitchSabotage:finishTimer(id)
    local t = self.timers[id]
    self.timers[id] = nil
    if t ~= nil and t.onEnd ~= nil then
        local ok, err = pcall(t.onEnd)
        if not ok then log("Timer %s: %s", id, tostring(err)) end
    end
end

function TwitchSabotage:updateTimers(dt)
    for id, t in pairs(self.timers) do
        t.remaining = t.remaining - dt
        if t.onTick ~= nil then
            local ok, err = pcall(t.onTick, dt)
            if not ok then log("Timer %s: %s", id, tostring(err)); t.remaining = 0 end
        end
        if t.remaining <= 0 then self:finishTimer(id) end
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
    local handler = A[cmd.action]
    local success, msg = false, nil
    if handler == nil then
        msg = "Onbekende actie (mod updaten?)"
    else
        local ok, r1, r2 = pcall(handler, self, cmd)
        if ok then
            success, msg = r1 == true, r2
        else
            msg = "Scriptfout"
            log("Actie %s mislukt: %s", cmd.action, tostring(r1))
        end
    end

    if success then
        local who = cmd.viewer
        if cmd.source == "bits" then who = string.format("%s (%d bits)", cmd.viewer, cmd.amount)
        elseif cmd.source == "points" then who = string.format("%s (%d punten)", cmd.viewer, cmd.amount) end
        if cmd.action ~= "message" then
            self:notify(string.format("%s: %s!", who, cmd.label ~= "" and cmd.label or cmd.action), 4000)
        end
    end
    log("#%d %s door %s → %s %s", cmd.id, cmd.action, cmd.viewer, success and "OK" or "MISLUKT", msg or "")

    table.insert(self.results, { id = cmd.id, action = cmd.action, status = success and "ok" or "failed", msg = msg or "" })
    while #self.results > TwitchSabotage.MAX_RESULTS do table.remove(self.results, 1) end
end

function TwitchSabotage:writeOutbox()
    local xml = createXMLFile("TwitchSabotageOutbox", self.outboxPath, "outbox")
    if xml == nil or xml == 0 then return end
    setXMLString(xml, "outbox#version", TwitchSabotage.VERSION)
    setXMLString(xml, "outbox#epoch", self.epoch or "")
    setXMLInt(xml, "outbox#lastId", self.lastId)
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
-- Melding in beeld
-- ---------------------------------------------------------------------------

function TwitchSabotage:notify(text, duration)
    duration = duration or 4000
    local shown = pcall(function() g_currentMission:showBlinkingWarning(text, duration) end)
    pcall(function() g_currentMission:addIngameNotification(FSBaseMission.INGAME_NOTIFICATION_INFO, text) end)
    if not shown then log("%s", text) end
end

addModEventListener(TwitchSabotage)
