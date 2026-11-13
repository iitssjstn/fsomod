// Versie zonder venster. Wordt gebruikt door de end-to-end test (Linux/CI) en is handig om te debuggen.
//   Fs25Sabotage.Cli --key FS25-... [--game-dir MAP] [--config-dir MAP]
using Fs25Sabotage;

string? Arg(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }

var configDir = Arg("--config-dir") ?? BridgeConfig.DefaultDir();
using var bridge = new Bridge(configDir);
bridge.Log += Console.WriteLine;
bridge.PairingRejected += _ => Environment.Exit(2);

if (Arg("--game-dir") is { } gameDir) bridge.SetGameDir(gameDir);
if (Arg("--key") is { } key && !bridge.SetPairCode(key)) { Console.Error.WriteLine("Ongeldige koppelcode"); return 1; }

Console.WriteLine($"FS25 Twitch Sabotage (zonder venster) v{Bridge.Version}");
bridge.Start();
var done = new TaskCompletionSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.TrySetResult(); };
AppDomain.CurrentDomain.ProcessExit += (_, _) => done.TrySetResult();
await done.Task;
return 0;
