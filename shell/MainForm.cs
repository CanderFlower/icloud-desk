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
    private NotifyIcon? _notifyIcon;

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
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        MinimumSize = ScaleLogical(MinLogicalSize, e.DeviceDpiNew);
    }

    // ---------------------------------------------------------------- lifecycle

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.ApplyTitleBar(Handle, _theme.Dark, _captionColor);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _ = StartAsync();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // The daemon keeps running on purpose: CLI users rely on it and it has its own idle timeout.
        SavePlacement();
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
            _lifetime.Cancel();
            _splashFallback.Dispose();
            _notifyIcon?.Dispose();
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
                    Close();
                    return;
                }
                if (WindowState == FormWindowState.Minimized || Native.IsIconic(Handle))
                    Native.ShowWindow(Handle, Native.SW_RESTORE);
                Show();
                Activate();
                Native.SetForegroundWindow(Handle);
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

        var shellInfo = JsonSerializer.Serialize(new { version = AppPaths.Version, platform = "windows", debug = _options.Debug });
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
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            _fullScreen = false;
            FormBorderStyle = FormBorderStyle.Sizable;
            Bounds = _preFullScreenBounds;
            WindowState = _preFullScreenState;
            Native.ApplyTitleBar(Handle, _theme.Dark, _captionColor);
        }
    }

    private void ShowNotification(string? title, string? body)
    {
        if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(body)) return;
        if (_notifyIcon is null)
        {
            _notifyIcon = new NotifyIcon { Icon = Icon, Text = AppPaths.AppTitle };
            _notifyIcon.BalloonTipClosed += (_, _) => _notifyIcon.Visible = false;
        }
        _notifyIcon.BalloonTipClicked -= OnBalloonClicked;
        _notifyIcon.BalloonTipClicked += OnBalloonClicked;
        _notifyIcon.Visible = true;
        _notifyIcon.ShowBalloonTip(5000, string.IsNullOrWhiteSpace(title) ? AppPaths.AppTitle : title!, body ?? "", ToolTipIcon.None);
    }

    private void OnBalloonClicked(object? sender, EventArgs e) => OnSecondInstance(new LaunchOptions(false, false, false));
}
