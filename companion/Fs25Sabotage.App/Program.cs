namespace Fs25Sabotage.App;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Maar één exemplaar tegelijk.
        using var mutex = new Mutex(true, @"Local\FS25TwitchSabotage", out var first);
        if (!first)
        {
            MessageBox.Show("FS25 Twitch Sabotage draait al.\n\nKijk rechtsonder bij de klok (systeemvak).",
                "FS25 Twitch Sabotage", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        var bridge = new Bridge(BridgeConfig.DefaultDir());
        Application.Run(new MainForm(bridge, startMinimized: args.Contains("--minimized")));
    }
}
