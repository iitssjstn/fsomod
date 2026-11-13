using System.Text;
using System.Text.Json;

namespace Fs25Sabotage;

/// <summary>Opgeslagen instellingen (in %APPDATA%\FS25TwitchSabotage\config.json).</summary>
public sealed record BridgeConfig(string? ServerUrl = null, string? PairKey = null, string? GameDir = null)
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static string DefaultDir() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "FS25TwitchSabotage");

    public static BridgeConfig Load(string dir)
    {
        try { return JsonSerializer.Deserialize<BridgeConfig>(File.ReadAllText(Path.Combine(dir, "config.json"))) ?? new(); }
        catch { return new(); }
    }

    public void Save(string dir)
    {
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "config.json"), JsonSerializer.Serialize(this, Json));
    }
}

/// <summary>Koppelcode van de website: "FS25-" + base64url("serveradres|sleutel").</summary>
public static class PairCode
{
    public static (string ServerUrl, string Key)? Parse(string? code)
    {
        code = (code ?? "").Trim();
        if (!code.StartsWith("FS25-", StringComparison.Ordinal)) return null;
        try
        {
            var b64 = code[5..].Replace('-', '+').Replace('_', '/');
            b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(b64)).Split('|');
            if (parts.Length != 2) return null;
            if (!Uri.TryCreate(parts[0], UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http")) return null;
            if (string.IsNullOrWhiteSpace(parts[1])) return null;
            return (parts[0].TrimEnd('/'), parts[1]);
        }
        catch { return null; }
    }
}

/// <summary>Zoekt "Documenten\My Games\FarmingSimulator2025" (ook bij OneDrive of een verplaatste Documenten-map).</summary>
public static class GameLocator
{
    public static string? Find()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var candidates = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            Path.Combine(home, "Documents"),
            Path.Combine(home, "Documenten"),
            Path.Combine(home, "OneDrive", "Documents"),
            Path.Combine(home, "OneDrive", "Documenten"),
        };
        foreach (var docs in candidates.Where(d => !string.IsNullOrEmpty(d)).Distinct())
        {
            var p = Path.Combine(docs, "My Games", "FarmingSimulator2025");
            if (Directory.Exists(p)) return p;
        }
        return null;
    }
}
