using System.Diagnostics;
using Microsoft.Win32;

namespace Fs25Sabotage.App;

public sealed class MainForm : Form
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "FS25TwitchSabotage";

    private readonly Bridge _bridge;
    private readonly NotifyIcon _tray;
    private readonly TextBox _code = new() { PlaceholderText = "FS25-…", UseSystemPasswordChar = true, Dock = DockStyle.Fill };
    private readonly Button _pair = new() { Text = "Koppelen", AutoSize = true };
    private readonly Label _pairState = new() { AutoSize = true, ForeColor = Color.DimGray };
    private readonly StatusRow _server = new("Server");
    private readonly StatusRow _game = new("Game");
    private readonly Label _gameDir = new() { AutoSize = true, ForeColor = Color.DimGray, MaximumSize = new Size(420, 0) };
    private readonly Button _chooseDir = new() { Text = "Map kiezen…", AutoSize = true };
    private readonly CheckBox _autostart = new() { Text = "Starten met Windows", AutoSize = true };
    private readonly ListBox _log = new() { Dock = DockStyle.Fill, IntegralHeight = false, HorizontalScrollbar = true };
    private readonly LinkLabel _update = new()
    {
        Dock = DockStyle.Top, AutoSize = true, Visible = false, Padding = new Padding(10, 8, 10, 8), Margin = new Padding(0, 0, 0, 8),
        BackColor = Color.FromArgb(255, 243, 205), ForeColor = Color.FromArgb(102, 77, 3), LinkColor = Color.FromArgb(0, 90, 160),
    };
    private bool _updateHintShown;
    private bool _reallyClose;
    private bool _trayHintShown;

    public MainForm(Bridge bridge, bool startMinimized)
    {
        _bridge = bridge;
        Text = "FS25 Twitch Sabotage";
        Icon = AppIcon.Load();
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(480, 520);
        MinimumSize = new Size(440, 440);
        Font = new Font("Segoe UI", 9.5f);

        // --- Systeemvak ---
        var menu = new ContextMenuStrip();
        menu.Items.Add("Openen", null, (_, _) => ShowFromTray());
        menu.Items.Add("Website openen", null, (_, _) => OpenWebsite());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Afsluiten", null, (_, _) => { _reallyClose = true; Close(); });
        _tray = new NotifyIcon { Icon = Icon, Text = "FS25 Twitch Sabotage", ContextMenuStrip = menu, Visible = true };
        _tray.DoubleClick += (_, _) => ShowFromTray();

        // --- Indeling ---
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 1, RowCount = 6 };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var pairBox = new GroupBox { Text = "Koppelcode (van je dashboard op de website)", Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(10) };
        var pairGrid = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2 };
        pairGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        pairGrid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        pairGrid.Controls.Add(_code, 0, 0);
        pairGrid.Controls.Add(_pair, 1, 0);
        pairGrid.Controls.Add(_pairState, 0, 1);
        pairGrid.SetColumnSpan(_pairState, 2);
        pairBox.Controls.Add(pairGrid);

        var statusBox = new GroupBox { Text = "Status", Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(10) };
        var statusFlow = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
        statusFlow.Controls.Add(_server);
        statusFlow.Controls.Add(_game);
        statusBox.Controls.Add(statusFlow);

        var dirBox = new GroupBox { Text = "Farming Simulator 25-map", Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(10) };
        var dirFlow = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
        dirFlow.Controls.Add(_gameDir);
        dirFlow.Controls.Add(_chooseDir);
        dirBox.Controls.Add(dirFlow);

        var logBox = new GroupBox { Text = "Logboek", Dock = DockStyle.Fill, Padding = new Padding(8) };
        logBox.Controls.Add(_log);

        root.Controls.Add(_update, 0, 0);
        root.Controls.Add(pairBox, 0, 1);
        root.Controls.Add(statusBox, 0, 2);
        root.Controls.Add(dirBox, 0, 3);
        root.Controls.Add(_autostart, 0, 4);
        root.Controls.Add(logBox, 0, 5);
        Controls.Add(root);

        // --- Gedrag ---
        AcceptButton = _pair;
        _pair.Click += (_, _) => Pair();
        _update.LinkClicked += (_, _) => OpenUrl(_bridge.DownloadUrl);
        _chooseDir.Click += (_, _) => ChooseDir();
        _autostart.Checked = AutostartEnabled();
        // Bestaande autostart-regel (bijv. van een oudere versie of een verplaatste .exe) naar dit programma laten wijzen.
        if (_autostart.Checked) SetAutostart(true);
        _autostart.CheckedChanged += (_, _) => SetAutostart(_autostart.Checked);

        _bridge.Log += line => Ui(() => AddLog(line));
        _bridge.StatusChanged += () => Ui(RefreshStatus);
        _bridge.PairingRejected += reason => Ui(() =>
        {
            RefreshStatus();
            ShowFromTray();
            MessageBox.Show(this, $"De koppelcode is niet (meer) geldig.\n\n{reason}\n\nKopieer een nieuwe code van je dashboard op de website.",
                "Opnieuw koppelen", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        });

        RefreshStatus();
        if (startMinimized && _bridge.IsPaired)
        {
            WindowState = FormWindowState.Minimized;
            ShowInTaskbar = false;
            Load += (_, _) => Hide();
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _bridge.Start();
    }

    private void Pair()
    {
        if (!_bridge.SetPairCode(_code.Text))
        {
            MessageBox.Show(this, "Dat is geen geldige koppelcode.\n\nKopieer de code (begint met FS25-) van je dashboard op de website.",
                "Ongeldige code", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        _code.Clear();
        // Bij de eerste koppeling standaard meestarten met Windows aanzetten (staat zichtbaar aangevinkt, kan uit).
        if (!AutostartEnabled()) _autostart.Checked = true;
        RefreshStatus();
    }

    private void ChooseDir()
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = "Kies de map 'Documenten\\My Games\\FarmingSimulator2025'",
            UseDescriptionForTitle = true,
            InitialDirectory = _bridge.GameDir ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dlg.ShowDialog(this) == DialogResult.OK) _bridge.SetGameDir(dlg.SelectedPath);
        RefreshStatus();
    }

    private void RefreshStatus()
    {
        var cfg = _bridge.Config;
        _pairState.Text = _bridge.IsPaired ? $"Gekoppeld met {cfg.ServerUrl}" : "Nog niet gekoppeld.";
        _pair.Text = _bridge.IsPaired ? "Opnieuw koppelen" : "Koppelen";

        if (!_bridge.IsPaired) _server.Set(false, "niet gekoppeld");
        else if (_bridge.ServerConnected) _server.Set(true, $"verbonden als {_bridge.StreamerName}");
        else _server.Set(false, "verbinden…");

        _game.Set(_bridge.GameActive, _bridge.GameActive
            ? $"actief{(_bridge.ModVersion is { } v ? $" (mod v{v})" : "")}"
            : "niet actief: start FS25, zet de mod aan en laad een savegame");

        _gameDir.Text = _bridge.GameDir ?? "Niet gevonden. Kies de map handmatig.";

        // Nieuwe versie beschikbaar?
        _update.Visible = _bridge.UpdateAvailable;
        if (_bridge.UpdateAvailable)
        {
            var text = $"Nieuwe versie v{_bridge.LatestAppVersion} beschikbaar (je hebt v{Bridge.Version}). Downloaden";
            _update.Text = text;
            _update.LinkArea = new LinkArea(text.Length - "Downloaden".Length, "Downloaden".Length);
            if (!_updateHintShown)
            {
                _updateHintShown = true;
                _tray.ShowBalloonTip(5000, "Update beschikbaar",
                    $"FS25 Twitch Sabotage v{_bridge.LatestAppVersion} staat klaar. Open het programma om te downloaden.", ToolTipIcon.Info);
            }
        }
        _tray.Text = $"FS25 Twitch Sabotage: {(_bridge.ServerConnected && _bridge.GameActive ? "actief" : "niet actief")}";
    }

    private void AddLog(string line)
    {
        _log.Items.Add(line);
        while (_log.Items.Count > 300) _log.Items.RemoveAt(0);
        _log.TopIndex = Math.Max(0, _log.Items.Count - 1);
    }

    // Kruisje = naar het systeemvak; echt afsluiten via het menu in het systeemvak.
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_reallyClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            if (!_trayHintShown)
            {
                _trayHintShown = true;
                _tray.ShowBalloonTip(4000, "FS25 Twitch Sabotage draait door",
                    "Het programma staat rechtsonder bij de klok. Rechtsklik op het icoon om af te sluiten.", ToolTipIcon.Info);
            }
            return;
        }
        _tray.Visible = false;
        _bridge.Dispose();
        base.OnFormClosing(e);
    }

    private void ShowFromTray()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void OpenWebsite() => OpenUrl(_bridge.Config.ServerUrl);

    private static void OpenUrl(string? url)
    {
        if (url is null) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    private void Ui(Action a)
    {
        if (IsDisposed) return;
        try { if (InvokeRequired) BeginInvoke(a); else a(); } catch (ObjectDisposedException) { } catch (InvalidOperationException) { }
    }

    // --- Autostart via HKCU\...\Run (alleen voor deze gebruiker, geen beheerdersrechten nodig) ---
    private static bool AutostartEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(RunValue) is string;
    }

    private static void SetAutostart(bool on)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) key.SetValue(RunValue, $"\"{Environment.ProcessPath}\" --minimized");
        else key.DeleteValue(RunValue, false);
    }

    /// <summary>Gekleurd bolletje + tekst.</summary>
    private sealed class StatusRow : FlowLayoutPanel
    {
        private readonly Label _dot = new() { Text = "●", AutoSize = true, Font = new Font("Segoe UI", 11f) };
        private readonly Label _text = new() { AutoSize = true, Padding = new Padding(0, 3, 0, 0) };
        private readonly string _name;

        public StatusRow(string name)
        {
            _name = name;
            AutoSize = true; WrapContents = false; Margin = new Padding(0, 2, 0, 2);
            Controls.Add(_dot); Controls.Add(_text);
        }

        public void Set(bool ok, string text)
        {
            _dot.ForeColor = ok ? Color.FromArgb(46, 160, 67) : Color.FromArgb(200, 70, 60);
            _text.Text = $"{_name}: {text}";
        }
    }
}

internal static class AppIcon
{
    public static Icon Load()
    {
        using var s = typeof(AppIcon).Assembly.GetManifestResourceStream("Fs25Sabotage.App.app.ico");
        return s is null ? SystemIcons.Application : new Icon(s);
    }
}
