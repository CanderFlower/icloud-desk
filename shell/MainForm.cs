using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace ICloudDesk.Shell;

internal sealed class MainForm : Form
{
    private const string WebView2DownloadUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    private static readonly Size DefaultLogicalSize = new(1280, 820);
    private static readonly Size MinLogicalSize = new(960, 640);

    private readonly LaunchOptions _options;
    private readonly SplashView _splash;
    private readonly ErrorView _error;
    private readonly System.Windows.Forms.Timer _splashFallback = new() { Interval = 4000 };
    private ThemeColors _theme;
    private bool _uiControlsTheme;
    private Color? _captionColor;

    private WebView2? _webView;
    private CoreWebView2Environment? _environment;
    private DaemonInfo? _daemon;
    private string? _origin;
    private bool _starting;
    private DateTime _lastAutoReconnect = DateTime.MinValue;
    private readonly CancellationTokenSource _lifetime = new();

    private FormWindowState _lastVisibleState = FormWindowState.Normal;
    private bool _fullScreen;
    private Rectangle _preFullScreenBounds;
    private FormWindowState _preFullScreenState;

    // Custom title bar, tray icon, global hotkey
    private const int ToggleHotkeyId = 0x4943; // "IC"
    private const string ToggleHotkeyText = "Ctrl+Alt+R";
    private readonly CaptionBar _caption;
    private readonly ShellSettings _settings = ShellSettings.Load();
    private NotifyIcon? _tray;
    private ToolStripMenuItem? _trayShowItem;
    private bool _hotkeyRegistered;
    private bool _exiting;

    private static Color DefaultCaptionColor(bool dark) => dark ? Color.FromArgb(0x26, 0x26, 0x28) : Color.FromArgb(0xEC, 0xEC, 0xF0);

    public MainForm(LaunchOptions options)
    {
        _options = options;
        _theme = Theme.ForDark(Theme.SystemPrefersDark());

        Text = AppPaths.AppTitle;
        Icon = AppIcon.Get(32);
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96f, 96f);
        BackColor = _theme.Background;
        KeyPreview = false;

        RestorePlacement();

        _caption = new CaptionBar(_theme, DefaultCaptionColor(_theme.Dark)) { Location = Point.Empty, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        _caption.MinimizeClicked += (_, _) => WindowState = FormWindowState.Minimized;
        _caption.MaximizeClicked += (_, _) => WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
        _caption.CloseClicked += (_, _) => Close();
        Controls.Add(_caption);
        LayoutCaption();

        _splash = new SplashView(_theme) { Dock = DockStyle.Fill };
        _error = new ErrorView(_theme) { Dock = DockStyle.Fill, Visible = false };
        _error.RetryClicked += (_, _) => _ = StartAsync();
        Controls.Add(_splash);
        Controls.Add(_error);

        _splashFallback.Tick += (_, _) =>
        {
            _splashFallback.Stop();
            HideSplash();
        };

        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        CreateTray();
    }

    // ---------------------------------------------------------------- custom caption

    private void LayoutCaption()
    {
        if (_caption is null) return;
        bool show = !_fullScreen;
        int h = show ? _caption.ScaledHeight : 0;
        _caption.Visible = show;
        _caption.Bounds = new Rectangle(0, 0, ClientSize.Width, h);
        _caption.Maximized = WindowState == FormWindowState.Maximized;
        if (Padding.Top != h) Padding = new Padding(0, h, 0, 0);
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case Native.WM_NCCALCSIZE when m.WParam != IntPtr.Zero && FormBorderStyle != FormBorderStyle.None:
            {
                // Keep the native left/right/bottom frame (resize borders, shadow) but drop the caption.
                var before = Marshal.PtrToStructure<Native.RECT>(m.LParam);
                base.WndProc(ref m);
                var after = Marshal.PtrToStructure<Native.RECT>(m.LParam);
                // A maximized window overhangs the monitor by the frame width; keep the top inside the screen.
                after.Top = before.Top + (Native.IsZoomed(Handle) ? after.Left - before.Left : 0);
                Marshal.StructureToPtr(after, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }
            case Native.WM_NCHITTEST when _caption is { Visible: true }:
            {
                base.WndProc(ref m);
                if ((int)m.Result != Native.HTCLIENT) return;
                var pt = PointToClient(Native.PointFromLParam(m.LParam));
                if (pt.Y >= _caption.Height || !_caption.IsDragArea(pt)) return;
                int border = _caption.ResizeBorder;
                if (WindowState == FormWindowState.Normal && pt.Y < border)
                    m.Result = (IntPtr)(pt.X < border * 2 ? Native.HTTOPLEFT : pt.X >= ClientSize.Width - border * 2 ? Native.HTTOPRIGHT : Native.HTTOP);
                else
                    m.Result = (IntPtr)Native.HTCAPTION;
                return;
            }
            case Native.WM_HOTKEY when (int)m.WParam == ToggleHotkeyId:
                ToggleFromHotkey();
                return;
        }
        base.WndProc(ref m);
    }

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        _caption.Active = true;
    }

    protected override void OnDeactivate(EventArgs e)
    {
        base.OnDeactivate(e);
        _caption.Active = false;
    }

    // ---------------------------------------------------------------- tray / hotkey / close-to-tray

    private void CreateTray()
    {
        _trayShowItem = new ToolStripMenuItem("显示 iCloud Desk", null, (_, _) => ShowFromTray())
        {
            Font = new Font(SystemFonts.MenuFont ?? Control.DefaultFont, FontStyle.Bold),
            ShortcutKeyDisplayString = ToggleHotkeyText,
        };
        var closeToTray = new ToolStripMenuItem("关闭窗口时隐藏到托盘") { Checked = _settings.CloseToTray, CheckOnClick = true };
        closeToTray.CheckedChanged += (_, _) =>
        {
            _settings.CloseToTray = closeToTray.Checked;
            _settings.Save();
        };
        var menu = new ContextMenuStrip();
        menu.Items.AddRange([_trayShowItem, closeToTray, new ToolStripSeparator(), new ToolStripMenuItem("退出", null, (_, _) => ExitApp())]);

        _tray = new NotifyIcon { Icon = AppIcon.Get(16) ?? Icon, Text = AppPaths.AppTitle, ContextMenuStrip = menu, Visible = true };
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowFromTray(); };
        _tray.BalloonTipClicked += (_, _) => ShowFromTray();
    }

    private void RegisterToggleHotkey()
    {
        _hotkeyRegistered = Native.RegisterHotKey(Handle, ToggleHotkeyId, Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_NOREPEAT, (uint)Keys.R);
        if (!_hotkeyRegistered)
            Log.Error($"RegisterHotKey({ToggleHotkeyText}) failed: {Marshal.GetLastWin32Error()} (already used by another app?)");
        if (_trayShowItem is not null)
            _trayShowItem.ShortcutKeyDisplayString = _hotkeyRegistered ? ToggleHotkeyText : $"{ToggleHotkeyText}（被占用）";
    }

    private void ToggleFromHotkey()
    {
        bool onScreen = Visible && WindowState != FormWindowState.Minimized;
        if (onScreen && Native.GetForegroundWindow() == Handle) HideToTray();
        else ShowFromTray();
    }

    private void HideToTray()
    {
        if (!Visible) return;
        SavePlacement();
        Hide();
        if (!_settings.TrayHintShown && _tray is not null)
        {
            _settings.TrayHintShown = true;
            _settings.Save();
            _tray.ShowBalloonTip(5000, "iCloud Desk 仍在后台运行",
                $"点击托盘图标或按 {ToggleHotkeyText} 重新打开。右键托盘图标可以退出或更改关闭行为。", ToolTipIcon.None);
        }
    }

    public void ShowFromTray()
    {
        if (IsDisposed) return;
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized || Native.IsIconic(Handle))
            Native.ShowWindow(Handle, Native.SW_RESTORE);
        Activate();
        Native.SetForegroundWindow(Handle);
    }

    private void ExitApp()
    {
        _exiting = true;
        Close();
    }

    // ---------------------------------------------------------------- window placement

    private int Dpi => DeviceDpi > 0 ? DeviceDpi : 96;

    private Size ScaleLogical(Size s, int dpi) => new(s.Width * dpi / 96, s.Height * dpi / 96);

    private void RestorePlacement()
    {
        StartPosition = FormStartPosition.Manual;
        MinimumSize = ScaleLogical(MinLogicalSize, Dpi);
        var saved = WindowStateStore.Load();
        if (saved is not null)
        {
            Bounds = new Rectangle(saved.X, saved.Y, Math.Max(saved.Width, MinimumSize.Width), Math.Max(saved.Height, MinimumSize.Height));
            if (saved.Maximized) WindowState = FormWindowState.Maximized;
            return;
        }
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        var size = ScaleLogical(DefaultLogicalSize, Dpi);
        size = new Size(Math.Min(size.Width, area.Width), Math.Min(size.Height, area.Height));
        Bounds = new Rectangle(area.X + (area.Width - size.Width) / 2, area.Y + (area.Height - size.Height) / 2, size.Width, size.Height);
    }

    private void SavePlacement()
    {
        var bounds = _fullScreen ? _preFullScreenBounds : WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        bool maximized = _fullScreen
            ? _preFullScreenState == FormWindowState.Maximized
            : WindowState == FormWindowState.Maximized || (WindowState == FormWindowState.Minimized && _lastVisibleState == FormWindowState.Maximized);
        WindowStateStore.Save(new WindowPlacement { X = bounds.X, Y = bounds.Y, Width = bounds.Width, Height = bounds.Height, Maximized = maximized });
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (WindowState != FormWindowState.Minimized) _lastVisibleState = WindowState;
        LayoutCaption();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        MinimumSize = ScaleLogical(MinLogicalSize, e.DeviceDpiNew);
        LayoutCaption();
    }

    // ---------------------------------------------------------------- lifecycle

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.ApplyTitleBar(Handle, _theme.Dark, _captionColor);
        // Re-run WM_NCCALCSIZE so the caption removal applies to the initial frame too.
        Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
            Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED);
        RegisterToggleHotkey();
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        if (_hotkeyRegistered) Native.UnregisterHotKey(Handle, ToggleHotkeyId);
        _hotkeyRegistered = false;
        base.OnHandleDestroyed(e);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        LayoutCaption();
        _ = StartAsync();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Caption ✕, Alt+F4 and taskbar close arrive as UserClosing. Task Manager / external WM_CLOSE,
        // Windows shutdown and the installer's --quit really exit.
        if (!_exiting && e.CloseReason == CloseReason.UserClosing && _settings.CloseToTray)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }
        // The daemon keeps running on purpose: CLI users rely on it and it has its own idle timeout.
        if (Visible) SavePlacement();
        if (_tray is not null) _tray.Visible = false;
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
            _lifetime.Cancel();
            _splashFallback.Dispose();
            _tray?.ContextMenuStrip?.Dispose();
            _tray?.Dispose();
            _webView?.Dispose();
        }
        base.Dispose(disposing);
    }

    /// <summary>Called from the single-instance pipe thread when the app is launched again.</summary>
    public void OnSecondInstance(LaunchOptions options)
    {
        if (IsDisposed) return;
        try
        {
            BeginInvoke(() =>
            {
                if (options.Quit)
                {
                    Log.Info("Quit requested by another process");
                    ExitApp();
                    return;
                }
                ShowFromTray();
            });
        }
        catch (InvalidOperationException)
        {
            // Window is closing.
        }
    }

    // ---------------------------------------------------------------- startup

    private void ShowSplash(string status)
    {
        _error.Visible = false;
        _splash.Status = status;
        _splash.Visible = true;
        _splash.BringToFront();
    }

    private void HideSplash()
    {
        _splashFallback.Stop();
        if (_webView is not null)
        {
            _webView.Visible = true;
            _webView.BringToFront();
        }
        _splash.Visible = false;
        _webView?.Focus();
    }

    private void ShowError(string title, string message, string? details, string? linkText = null, string? linkUrl = null)
    {
        _splashFallback.Stop();
        _splash.Visible = false;
        _error.ShowError(title, message, details, linkText, linkUrl);
        _error.Visible = true;
        _error.BringToFront();
    }

    private async Task StartAsync()
    {
        if (_starting) return;
        _starting = true;
        try
        {
            ShowSplash("正在启动 iCloud Desk…");

            string? runtime = null;
            try
            {
                runtime = CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (Exception ex) when (ex is WebView2RuntimeNotFoundException or FileNotFoundException or DllNotFoundException)
            {
                Log.Error("WebView2 runtime lookup failed", ex);
            }
            if (string.IsNullOrEmpty(runtime))
            {
                ShowError("需要 Microsoft Edge WebView2 运行时",
                    "iCloud Desk 使用 WebView2 显示界面，但这台电脑上没有安装它。请下载并安装“常青版”WebView2 运行时，然后点击“重试”。",
                    null, "下载 WebView2 运行时", WebView2DownloadUrl);
                return;
            }

            var ensureTask = CoreLauncher.EnsureAsync(_options.Demo, _lifetime.Token);
            var webTask = EnsureWebViewAsync();
            try
            {
                await webTask;
            }
            catch (Exception ex)
            {
                Log.Error("WebView2 initialization failed", ex);
                DisposeWebView();
                _ = ensureTask.ContinueWith(t => _ = t.Exception, TaskScheduler.Default);
                ShowError("无法初始化界面组件", "WebView2 初始化失败。可以尝试重试；如果问题持续，请重新安装 WebView2 运行时。", ex.Message,
                    "下载 WebView2 运行时", WebView2DownloadUrl);
                return;
            }

            try
            {
                _daemon = await ensureTask;
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (CoreLaunchException ex)
            {
                ShowError("无法启动 iCloud Desk", ex.Message, ex.Details);
                return;
            }
            catch (Exception ex)
            {
                Log.Error("daemon ensure failed", ex);
                ShowError("无法启动 iCloud Desk", "启动后台服务时出现意外错误。", ex.Message);
                return;
            }

            NavigateToDaemon();
        }
        finally
        {
            _starting = false;
        }
    }

    private async Task ReconnectAsync(string reason)
    {
        if (_starting) return;
        Log.Info($"Reconnecting to daemon: {reason}");
        _starting = true;
        try
        {
            ShowSplash("正在重新连接 iCloud Desk 服务…");
            _daemon = await CoreLauncher.EnsureAsync(_options.Demo, _lifetime.Token);
            if (_webView?.CoreWebView2 is null)
            {
                _starting = false;
                await StartAsync();
                return;
            }
            NavigateToDaemon();
        }
        catch (OperationCanceledException)
        {
        }
        catch (CoreLaunchException ex)
        {
            ShowError("与 iCloud Desk 服务的连接已断开", ex.Message, ex.Details);
        }
        catch (Exception ex)
        {
            Log.Error("Reconnect failed", ex);
            ShowError("与 iCloud Desk 服务的连接已断开", "重新启动后台服务失败。", ex.Message);
        }
        finally
        {
            _starting = false;
        }
    }

    private void NavigateToDaemon()
    {
        if (_daemon is null || _webView?.CoreWebView2 is null) return;
        var ui = new Uri(_daemon.UiUrl);
        _origin = ui.GetLeftPart(UriPartial.Authority);
        _webView.CoreWebView2.Navigate(_daemon.UiUrl);
    }

    // ---------------------------------------------------------------- WebView2

    private async Task EnsureWebViewAsync()
    {
        if (_webView?.CoreWebView2 is not null) return;

        if (_environment is null)
        {
            Directory.CreateDirectory(AppPaths.WebViewDataDir);
            _environment = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewDataDir);
        }

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = _captionColor ?? _theme.Background,
        };
        Controls.Add(_webView);
        _splash.BringToFront();

        await _webView.EnsureCoreWebView2Async(_environment);
        var core = _webView.CoreWebView2!;
        var s = core.Settings;
        s.AreDefaultContextMenusEnabled = _options.Debug;
        s.AreDevToolsEnabled = _options.Debug;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = true;
        s.IsBuiltInErrorPageEnabled = true;

        var shellInfo = JsonSerializer.Serialize(new { version = AppPaths.Version, platform = "windows", debug = _options.Debug, chrome = "custom" });
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            $"try {{ Object.defineProperty(window, '__ICD_SHELL__', {{ value: Object.freeze({shellInfo}), configurable: false }}); }} catch (e) {{}}");

        core.NavigationStarting += OnNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.NewWindowRequested += OnNewWindowRequested;
        core.WebMessageReceived += OnWebMessageReceived;
        core.ProcessFailed += OnProcessFailed;
        core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);
        core.DocumentTitleChanged += (_, _) => Text = AppPaths.AppTitle;
    }

    private void DisposeWebView()
    {
        if (_webView is null) return;
        Controls.Remove(_webView);
        _webView.Dispose();
        _webView = null;
    }

    private bool IsOwnOrigin(string? url) =>
        _origin is not null && Uri.TryCreate(url, UriKind.Absolute, out var u) &&
        string.Equals(u.GetLeftPart(UriPartial.Authority), _origin, StringComparison.OrdinalIgnoreCase);

    private static bool IsInternalScheme(string url) =>
        url.StartsWith("about:", StringComparison.OrdinalIgnoreCase) ||
        url.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
        url.StartsWith("blob:", StringComparison.OrdinalIgnoreCase);

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsOwnOrigin(e.Uri) || IsInternalScheme(e.Uri)) return;
        // Navigating to the daemon before _origin is known (first load) is fine too.
        if (_daemon is not null && CoreLauncher.IsLoopback(e.Uri) && e.Uri.StartsWith(_daemon.Url, StringComparison.OrdinalIgnoreCase)) return;
        e.Cancel = true;
        Shell.OpenExternal(e.Uri);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            if (_splash.Visible) _splashFallback.Start();
            return;
        }
        Log.Info($"Navigation failed: {e.WebErrorStatus} (HTTP {e.HttpStatusCode})");
        if (e.WebErrorStatus is CoreWebView2WebErrorStatus.CannotConnect or CoreWebView2WebErrorStatus.ConnectionAborted
            or CoreWebView2WebErrorStatus.ConnectionReset or CoreWebView2WebErrorStatus.Disconnected
            or CoreWebView2WebErrorStatus.ServerUnreachable or CoreWebView2WebErrorStatus.Timeout)
        {
            if (DateTime.UtcNow - _lastAutoReconnect > TimeSpan.FromSeconds(15))
            {
                _lastAutoReconnect = DateTime.UtcNow;
                _ = ReconnectAsync($"navigation failed ({e.WebErrorStatus})");
            }
            else
            {
                ShowError("无法连接到 iCloud Desk 服务", "后台服务没有响应。", $"WebErrorStatus: {e.WebErrorStatus}");
            }
        }
        else if (_splash.Visible)
        {
            HideSplash();
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        if (IsOwnOrigin(e.Uri) && _environment is not null)
        {
            // Same-origin popups (e.g. file previews) need the session cookie, so keep them in-app.
            var deferral = e.GetDeferral();
            var popup = new PopupForm(_environment, _origin!, _theme, _options.Debug);
            popup.Show(this);
            _ = popup.AttachAsync(e, deferral);
            return;
        }
        e.Handled = true;
        Shell.OpenExternal(e.Uri);
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log.Error($"WebView2 process failed: {e.ProcessFailedKind} ({e.Reason}, exit {e.ExitCode})");
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            BeginInvoke(() =>
            {
                DisposeWebView();
                ShowError("界面组件意外退出", "WebView2 浏览器进程已退出。点击“重试”重新加载。", $"{e.ProcessFailedKind}: {e.Reason}");
            });
        }
        else if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
        {
            BeginInvoke(() => _webView?.CoreWebView2?.Reload());
        }
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsOwnOrigin(e.Source)) return;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var typeEl)) return;
            switch (typeEl.GetString())
            {
                case "ready":
                    HideSplash();
                    break;
                case "theme":
                    bool dark = root.TryGetProperty("dark", out var d) && d.ValueKind == JsonValueKind.True;
                    Color? caption = root.TryGetProperty("titlebar", out var tb) && Theme.TryParseHex(tb.GetString(), out var c) ? c : null;
                    _uiControlsTheme = true;
                    ApplyTheme(Theme.ForDark(dark), caption);
                    break;
                case "open-external":
                    if (root.TryGetProperty("url", out var url)) Shell.OpenExternal(url.GetString());
                    break;
                case "daemon-lost":
                    _ = ReconnectAsync("UI reported daemon-lost");
                    break;
                case "notify":
                    ShowNotification(root.TryGetProperty("title", out var t) ? t.GetString() : null,
                        root.TryGetProperty("body", out var b) ? b.GetString() : null);
                    break;
            }
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            Log.Error("Bad web message", ex);
        }
    }

    // ---------------------------------------------------------------- theme / fullscreen / notifications

    private void OnUserPreferenceChanged(object? sender, UserPreferenceChangedEventArgs e)
    {
        if (_uiControlsTheme || e.Category != UserPreferenceCategory.General) return;
        bool dark = Theme.SystemPrefersDark();
        if (dark == _theme.Dark) return;
        BeginInvoke(() => ApplyTheme(Theme.ForDark(dark), null));
    }

    private void ApplyTheme(ThemeColors theme, Color? caption)
    {
        _theme = caption is Color bg ? theme with { Background = bg } : theme;
        _captionColor = caption;
        BackColor = _theme.Background;
        _caption.ApplyTheme(_theme, caption ?? DefaultCaptionColor(_theme.Dark));
        _splash.ApplyTheme(_theme);
        _error.ApplyTheme(_theme);
        if (_webView is not null) _webView.DefaultBackgroundColor = _theme.Background;
        if (IsHandleCreated) Native.ApplyTitleBar(Handle, _theme.Dark, caption);
    }

    private void SetFullScreen(bool on)
    {
        if (on == _fullScreen) return;
        if (on)
        {
            _preFullScreenState = WindowState;
            _preFullScreenBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            _fullScreen = true;
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            LayoutCaption();
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            _fullScreen = false;
            FormBorderStyle = FormBorderStyle.Sizable;
            LayoutCaption();
            Bounds = _preFullScreenBounds;
            WindowState = _preFullScreenState;
            Native.ApplyTitleBar(Handle, _theme.Dark, _captionColor);
        }
    }

    private void ShowNotification(string? title, string? body)
    {
        if (_tray is null || (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(body))) return;
        _tray.ShowBalloonTip(5000, string.IsNullOrWhiteSpace(title) ? AppPaths.AppTitle : title!, body ?? "", ToolTipIcon.None);
    }
}
