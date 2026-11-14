using System.IO.Compression;
using System.Net.WebSockets;
using System.Text.RegularExpressions;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

namespace Fs25Sabotage;

/// <summary>
/// Brug tussen de server (WebSocket) en de FS25-mod (XML-bestanden in modSettings).
///   inbox.xml  : programma → mod (opdrachten)
///   outbox.xml : mod → programma (resultaten + hartslag)
/// Events worden op een achtergrondthread afgevuurd.
/// </summary>
public sealed class Bridge : IDisposable
{
    public const string ModName = "FS25_TwitchSabotage";
    public static string Version => typeof(Bridge).Assembly.GetName().Version?.ToString(3) ?? "?";

    public event Action<string>? Log;
    public event Action? StatusChanged;
    /// <summary>De server heeft de koppelcode geweigerd; er is een nieuwe nodig.</summary>
    public event Action<string>? PairingRejected;

    public BridgeConfig Config { get; private set; }
    public bool ServerConnected { get; private set; }
    public bool GameActive { get; private set; }
    public string? StreamerName { get; private set; }
    public string? ModVersion { get; private set; }
    /// <summary>Nieuwste versie van dit programma volgens de server (null = onbekend).</summary>
    public string? LatestAppVersion { get; private set; }
    public bool UpdateAvailable => IsNewer(LatestAppVersion, Version);
    public string? DownloadUrl => Config.ServerUrl is { } u ? $"{u.TrimEnd('/')}/downloads/FS25TwitchSabotage.exe" : null;

    public static bool IsNewer(string? candidate, string? current) =>
        System.Version.TryParse(candidate, out var a) && System.Version.TryParse(current, out var b) && a > b;
    public string? GameDir => Config.GameDir ?? GameLocator.Find();

    private readonly string _configDir;
    private readonly object _lock = new();
    private readonly List<JsonElement> _commands = new();
    private readonly HashSet<string> _sentResults = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private CancellationTokenSource? _cts;
    private ClientWebSocket? _ws;
    private Task? _loop;
    private Timer? _pollTimer;
    private Timer? _statusTimer;
    private string _epoch = "";

    public Bridge(string configDir)
    {
        _configDir = configDir;
        Config = BridgeConfig.Load(configDir);
    }

    public bool IsPaired => !string.IsNullOrEmpty(Config.PairKey) && !string.IsNullOrEmpty(Config.ServerUrl);

    /// <summary>Koppelcode van de website toepassen. Geeft false bij een ongeldige code.</summary>
    public bool SetPairCode(string code)
    {
        var parsed = PairCode.Parse(code);
        if (parsed is null) return false;
        Config = Config with { ServerUrl = parsed.Value.ServerUrl, PairKey = parsed.Value.Key };
        Config.Save(_configDir);
        Restart();
        return true;
    }

    public void SetGameDir(string? dir)
    {
        Config = Config with { GameDir = string.IsNullOrWhiteSpace(dir) ? null : dir };
        Config.Save(_configDir);
        Say($"Gamemap: {GameDir ?? "(niet gevonden)"}");
        WriteInbox();
        Changed();
    }

    public void Start()
    {
        _pollTimer ??= new Timer(_ => SafePoll(), null, 500, 500);
        _statusTimer ??= new Timer(_ => _ = SendStatus(), null, 10_000, 10_000);
        if (GameDir is null) Say("De map 'Documenten\\My Games\\FarmingSimulator2025' is niet gevonden. Kies hem handmatig.");
        else Say($"Gamemap: {GameDir}");
        if (!IsPaired) { Say("Nog niet gekoppeld: plak je koppelcode van de website."); return; }
        if (_cts is not null) return; // draait al
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => ConnectLoop(_cts.Token));
    }

    private void Restart()
    {
        Stop();
        Start();
    }

    public void Stop()
    {
        try { _cts?.Cancel(); } catch { }
        try { _ws?.Abort(); } catch { }
        try { _loop?.Wait(2000); } catch { }
        _cts = null; _loop = null; _ws = null;
        SetServer(false, null);
    }

    public void Dispose()
    {
        Stop();
        _pollTimer?.Dispose();
        _statusTimer?.Dispose();
    }

    // ------------------------------------------------------------------ WebSocket

    private async Task ConnectLoop(CancellationToken ct)
    {
        var delay = 1000;
        while (!ct.IsCancellationRequested)
        {
            var closeStatus = (int?)null; var closeReason = "";
            try
            {
                using var ws = new ClientWebSocket();
                ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                _ws = ws;
                var url = Config.ServerUrl!.TrimEnd('/');
                url = (url.StartsWith("https", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws") + url[url.IndexOf(':')..];
                await ws.ConnectAsync(new Uri($"{url}/ws?key={Uri.EscapeDataString(Config.PairKey!)}"), ct);
                delay = 1000;
                await SendStatus();
                await ReceiveLoop(ws, ct);
                closeStatus = (int?)ws.CloseStatus; closeReason = ws.CloseStatusDescription ?? "";
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception e) { Say($"Verbindingsfout: {e.Message}"); }
            finally { _ws = null; SetServer(false, null); }

            if (closeStatus is 4003 or 4001)
            {
                Say($"Koppelcode niet (meer) geldig: {closeReason}. Plak een nieuwe code van de website.");
                Config = Config with { PairKey = null };
                Config.Save(_configDir);
                PairingRejected?.Invoke(closeReason);
                return;
            }
            if (closeStatus == 4002)
            {
                // Kanaal gebruikt een gameserver via FTP; dit programma is dan niet nodig.
                Say(closeReason.Length > 0 ? closeReason : "Dit kanaal gebruikt een gameserver via FTP.");
                delay = 60_000;
            }
            if (ct.IsCancellationRequested) break;
            Say($"Opnieuw verbinden over {delay / 1000} s…");
            try { await Task.Delay(delay, ct); } catch { break; }
            delay = Math.Min(delay * 2, 30_000);
        }
    }

    private async Task ReceiveLoop(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        var ms = new MemoryStream();
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            var r = await ws.ReceiveAsync(buffer, ct);
            if (r.MessageType == WebSocketMessageType.Close)
            {
                try { await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
                return;
            }
            ms.Write(buffer, 0, r.Count);
            if (!r.EndOfMessage) continue;
            var text = Encoding.UTF8.GetString(ms.ToArray());
            ms.SetLength(0);
            try { HandleMessage(text); } catch (Exception e) { Say($"Fout in bericht: {e.Message}"); }
        }
    }

    private void HandleMessage(string text)
    {
        using var doc = JsonDocument.Parse(text);
        var m = doc.RootElement;
        var type = m.GetProperty("type").GetString();
        switch (type)
        {
            case "hello":
                SetEpoch(Str(m, "epoch"));
                LatestAppVersion = Str(m, "latestApp") is { Length: > 0 } la ? la : null;
                if (UpdateAvailable) Say($"Nieuwe versie beschikbaar: v{LatestAppVersion} (je hebt v{Version}).");
                SetServer(true, Str(m, "user"));
                Say($"Verbonden met de server als {StreamerName}");
                WriteInbox();
                break;
            case "command":
                if (m.TryGetProperty("epoch", out var ep)) SetEpoch(ep.GetString() ?? "");
                var cmd = m.GetProperty("cmd").Clone();
                var id = cmd.GetProperty("id").GetInt64();
                lock (_lock)
                {
                    if (!_commands.Any(c => c.GetProperty("id").GetInt64() == id)) _commands.Add(cmd);
                }
                WriteInbox();
                Say($"→ #{id} {Str(cmd, "label")} (door {Str(cmd, "viewer")})");
                break;
            case "error":
                Say($"Fout van de server: {Str(m, "message")}");
                break;
            case "installMod":
                var requestId = Str(m, "requestId");
                _ = Task.Run(async () =>
                {
                    var (ok, msg) = await InstallModAsync();
                    await Send(new { type = "installResult", requestId, ok, msg });
                });
                break;
        }
    }

    private void SetEpoch(string epoch)
    {
        lock (_lock)
        {
            if (epoch == _epoch) return;
            _epoch = epoch;
            _commands.Clear();
        }
    }

    private async Task Send(object payload)
    {
        var ws = _ws;
        if (ws is null || ws.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        await _sendLock.WaitAsync();
        try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None); }
        catch { }
        finally { _sendLock.Release(); }
    }

    private Task SendStatus() => Send(new { type = "status", gameActive = GameActive, modVersion = ModVersion, companionVersion = Version });

    // ------------------------------------------------------------------ Mod installeren / bijwerken

    private static readonly Regex ModCopyName = new("twitch.?sabotage", RegexOptions.IgnoreCase);

    /// <summary>
    /// Downloadt de nieuwste mod van de website en zet hem als mods\FS25_TwitchSabotage.zip neer.
    /// Oude kopieën met een andere naam (bijv. "FS25_TwitchSabotage (1).zip") gaan naar een back-upmap.
    /// </summary>
    public async Task<(bool Ok, string Message)> InstallModAsync()
    {
        try
        {
            var game = GameDir;
            if (game is null || !Directory.Exists(game)) return Fail("De FS25-map is niet gevonden. Kies hem eerst in het programma.");
            if (Config.ServerUrl is null) return Fail("Nog niet gekoppeld met de website.");

            Say("Mod downloaden…");
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
            var bytes = await http.GetByteArrayAsync($"{Config.ServerUrl.TrimEnd('/')}/downloads/{ModName}.zip");
            string? version;
            try { version = ReadModVersion(bytes); }
            catch { return Fail("De gedownloade mod is ongeldig."); }

            var mods = Path.Combine(game, "mods");
            Directory.CreateDirectory(mods);
            var target = Path.Combine(mods, $"{ModName}.zip");

            // Oude kopieën onder een andere naam opruimen (verplaatsen, niet verwijderen).
            var backup = Path.Combine(game, "modSettings", ModName, "oude-versies", DateTime.Now.ToString("yyyyMMdd-HHmmss"));
            var moved = new List<string>();
            foreach (var entry in Directory.EnumerateFileSystemEntries(mods))
            {
                var name = Path.GetFileName(entry);
                if (!ModCopyName.IsMatch(name) || string.Equals(entry, target, StringComparison.OrdinalIgnoreCase)) continue;
                Directory.CreateDirectory(backup);
                var dest = Path.Combine(backup, name);
                if (Directory.Exists(entry)) Directory.Move(entry, dest); else File.Move(entry, dest);
                moved.Add(name);
            }

            var tmp = target + ".download";
            await File.WriteAllBytesAsync(tmp, bytes);
            try { File.Move(tmp, target, overwrite: true); }
            catch (IOException)
            {
                try { File.Delete(tmp); } catch { }
                return Fail("Farming Simulator 25 is nog open. Sluit het spel helemaal af en probeer het opnieuw.");
            }

            var msg = $"Mod bijgewerkt naar v{version ?? "?"}." + (moved.Count > 0 ? $" Oude kopieën verplaatst: {string.Join(", ", moved)}." : "")
                + " Start Farming Simulator 25 opnieuw.";
            Say(msg);
            return (true, msg);
        }
        catch (IOException) { return Fail("Farming Simulator 25 is nog open. Sluit het spel helemaal af en probeer het opnieuw."); }
        catch (UnauthorizedAccessException) { return Fail("Geen toegang tot de mods-map. Sluit Farming Simulator 25 en probeer het opnieuw."); }
        catch (Exception e) { return Fail($"Bijwerken mislukt: {e.Message}"); }

        (bool, string) Fail(string m) { Say(m); return (false, m); }
    }

    private static string? ReadModVersion(byte[] zip)
    {
        using var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        var lua = archive.GetEntry("scripts/TwitchSabotage.lua") ?? throw new InvalidDataException("geen mod");
        using var reader = new StreamReader(lua.Open());
        var m = Regex.Match(reader.ReadToEnd(), "TwitchSabotage\\.VERSION\\s*=\\s*\"([^\"]+)\"");
        return m.Success ? m.Groups[1].Value : null;
    }

    // ------------------------------------------------------------------ Bestanden

    private string? ModDir()
    {
        var game = GameDir;
        if (game is null || !Directory.Exists(game)) return null;
        var dir = Path.Combine(game, "modSettings", ModName);
        Directory.CreateDirectory(dir);
        return dir;
    }

    private void WriteInbox()
    {
        var dir = ModDir();
        if (dir is null) return;
        XElement root;
        lock (_lock)
        {
            root = new XElement("inbox", new XAttribute("epoch", _epoch), new XAttribute("written", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            foreach (var c in _commands)
            {
                root.Add(new XElement("cmd",
                    new XAttribute("id", c.GetProperty("id").GetInt64()),
                    new XAttribute("action", Str(c, "action")),
                    new XAttribute("param", Str(c, "param")),
                    new XAttribute("viewer", Clean(Str(c, "viewer"))),
                    new XAttribute("source", Str(c, "source")),
                    new XAttribute("amount", c.TryGetProperty("amount", out var a) && a.ValueKind == JsonValueKind.Number ? a.GetInt64() : 0),
                    new XAttribute("label", Clean(Str(c, "label"))),
                    new XAttribute("text", Clean(Str(c, "text"))),
                    new XAttribute("target", Str(c, "target")),
                    new XAttribute("player", Clean(Str(c, "player")))));
            }
        }
        var file = Path.Combine(dir, "inbox.xml");
        var tmp = file + ".tmp";
        try
        {
            var settings = new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = true };
            using (var w = XmlWriter.Create(tmp, settings)) new XDocument(new XDeclaration("1.0", "utf-8", "no"), root).Save(w);
            File.Move(tmp, file, overwrite: true);
        }
        catch (Exception e) { Say($"Kon inbox niet schrijven: {e.Message}"); }
    }

    private void SafePoll()
    {
        try { ReadOutbox(); } catch (Exception e) { Say($"Fout bij lezen outbox: {e.Message}"); }
    }

    private void ReadOutbox()
    {
        var dir = ModDir();
        var file = dir is null ? null : Path.Combine(dir, "outbox.xml");
        if (file is null || !File.Exists(file)) { SetGame(false); return; }

        // De mod schrijft elke 2 s een hartslag; ouder dan 8 s = game niet actief.
        SetGame(DateTime.UtcNow - File.GetLastWriteTimeUtc(file) < TimeSpan.FromSeconds(8));

        XDocument doc;
        try { doc = XDocument.Load(file); } catch { return; } // mod is net aan het schrijven
        var root = doc.Root;
        if (root is null) return;
        var v = (string?)root.Attribute("version");
        if (v is not null && v != ModVersion) { ModVersion = v; Changed(); }
        string epoch; lock (_lock) epoch = _epoch;
        if ((string?)root.Attribute("epoch") != epoch) return;

        var lastId = long.TryParse((string?)root.Attribute("lastId"), out var l) ? l : 0;
        bool removed;
        lock (_lock) removed = _commands.RemoveAll(c => c.GetProperty("id").GetInt64() <= lastId) > 0;
        if (removed) WriteInbox();

        if (_ws is null || _ws.State != WebSocketState.Open) return;
        foreach (var r in root.Elements("result"))
        {
            var id = (string?)r.Attribute("id") ?? "";
            if (!_sentResults.Add($"{epoch}:{id}")) continue;
            var status = (string?)r.Attribute("status") ?? "failed";
            var msg = (string?)r.Attribute("msg") ?? "";
            _ = Send(new { type = "result", id = long.TryParse(id, out var n) ? n : 0, status, msg });
            Say($"{(status == "ok" ? "OK" : "MISLUKT")} #{id} {(string?)r.Attribute("action")}{(msg.Length > 0 ? $" ({msg})" : "")}");
        }
    }

    // ------------------------------------------------------------------ Status

    private void SetGame(bool active)
    {
        if (active == GameActive) return;
        GameActive = active;
        Say(active ? "Game actief: sabotage staat AAN" : "Game niet actief (geen savegame geladen, gepauzeerd of mod niet geïnstalleerd)");
        _ = SendStatus();
        Changed();
    }

    private void SetServer(bool connected, string? name)
    {
        if (connected == ServerConnected && name == StreamerName) return;
        ServerConnected = connected; StreamerName = name;
        Changed();
    }

    private void Changed() => StatusChanged?.Invoke();
    private void Say(string msg) => Log?.Invoke($"[{DateTime.Now:HH:mm:ss}] {msg}");

    private static string Str(JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var p)) return "";
        return p.ValueKind switch
        {
            JsonValueKind.String => p.GetString() ?? "",
            JsonValueKind.Number => p.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        };
    }

    // Geen regeleindes/stuurtekens in XML-attributen.
    private static string Clean(string s) => new(s.Select(ch => char.IsControl(ch) ? ' ' : ch).ToArray());
}
