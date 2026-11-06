using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ICloudDesk.Shell;

/// <summary>Secondary window for same-origin popups (window.open / target=_blank on the daemon's origin).</summary>
internal sealed class PopupForm : Form
{
    private readonly CoreWebView2Environment _environment;
    private readonly string _origin;
    private readonly bool _debug;
    private readonly ThemeColors _theme;
    private readonly WebView2 _webView;

    public PopupForm(CoreWebView2Environment environment, string origin, ThemeColors theme, bool debug)
    {
        _environment = environment;
        _origin = origin;
        _theme = theme;
        _debug = debug;

        Text = AppPaths.AppTitle;
        Icon = AppIcon.Get(32);
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96f, 96f);
        StartPosition = FormStartPosition.CenterParent;
        Size = new Size(1000 * DeviceDpi / 96, 720 * DeviceDpi / 96);
        BackColor = theme.Background;
        ShowInTaskbar = true;

        _webView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = theme.Background };
        Controls.Add(_webView);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.ApplyTitleBar(Handle, _theme.Dark, null);
    }

    public async Task AttachAsync(CoreWebView2NewWindowRequestedEventArgs request, CoreWebView2Deferral deferral)
    {
        try
        {
            await _webView.EnsureCoreWebView2Async(_environment);
            var core = _webView.CoreWebView2!;
            core.Settings.AreDefaultContextMenusEnabled = _debug;
            core.Settings.AreDevToolsEnabled = _debug;
            core.Settings.IsStatusBarEnabled = false;
            core.DocumentTitleChanged += (_, _) =>
                Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? AppPaths.AppTitle : $"{core.DocumentTitle} - {AppPaths.AppTitle}";
            core.WindowCloseRequested += (_, _) => Close();
            core.NavigationStarting += (_, e) =>
            {
                if (IsAllowed(e.Uri)) return;
                e.Cancel = true;
                Shell.OpenExternal(e.Uri);
            };
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (IsAllowed(e.Uri)) core.Navigate(e.Uri);
                else Shell.OpenExternal(e.Uri);
            };
            request.NewWindow = core;
            request.Handled = true;
        }
        catch (Exception ex)
        {
            Log.Error("Popup initialization failed", ex);
            Close();
        }
        finally
        {
            deferral.Complete();
        }
    }

    private bool IsAllowed(string url) =>
        url.StartsWith("about:", StringComparison.OrdinalIgnoreCase) ||
        url.StartsWith("blob:", StringComparison.OrdinalIgnoreCase) ||
        url.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
        (Uri.TryCreate(url, UriKind.Absolute, out var u) &&
         string.Equals(u.GetLeftPart(UriPartial.Authority), _origin, StringComparison.OrdinalIgnoreCase));
}
