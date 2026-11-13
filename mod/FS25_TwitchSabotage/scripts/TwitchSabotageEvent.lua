-- Netwerkbericht van de server naar spelers:
--   "notify" : melding in beeld bij iedereen
--   "kick"   : speler uit zijn voertuig zetten (alleen naar die ene speler gestuurd)
-- Berichten die van een speler komen worden genegeerd: alleen de server mag dit sturen.

TwitchSabotageEvent = {}
local TwitchSabotageEvent_mt = Class(TwitchSabotageEvent, Event)
InitEventClass(TwitchSabotageEvent, "TwitchSabotageEvent")

function TwitchSabotageEvent.emptyNew()
    return Event.new(TwitchSabotageEvent_mt)
end

function TwitchSabotageEvent.new(kind, text, duration)
    local self = TwitchSabotageEvent.emptyNew()
    self.kind = kind or "notify"
    self.text = text or ""
    self.duration = duration or 4000
    return self
end

function TwitchSabotageEvent:writeStream(streamId, connection)
    streamWriteString(streamId, self.kind)
    streamWriteString(streamId, self.text)
    streamWriteInt32(streamId, self.duration)
end

function TwitchSabotageEvent:readStream(streamId, connection)
    self.kind = streamReadString(streamId)
    self.text = streamReadString(streamId)
    self.duration = streamReadInt32(streamId)
    self:run(connection)
end

function TwitchSabotageEvent:run(connection)
    if connection == nil or not connection:getIsServer() then return end
    if self.kind == "notify" then
        TwitchSabotage.showLocal(self.text, self.duration)
    elseif self.kind == "kick" then
        if g_localPlayer ~= nil and g_localPlayer.leaveVehicle ~= nil then g_localPlayer:leaveVehicle() end
    end
end
