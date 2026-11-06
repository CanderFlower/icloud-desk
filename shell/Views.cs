using System.Drawing.Drawing2D;
using System.Drawing.Text;

namespace ICloudDesk.Shell;

internal static class AppIcon
{
    private static byte[]? _bytes;

    private static Stream Open()
    {
        _bytes ??= ReadAll();
        return new MemoryStream(_bytes, writable: false);
    }

    private static byte[] ReadAll()
    {
        using var s = typeof(AppIcon).Assembly.GetManifestResourceStream("app.ico");
        if (s is null) return [];
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    public static Icon? Get(int size)
    {
        try
        {
            using var s = Open();
            return s.Length == 0 ? null : new Icon(s, size, size);
        }
        catch
        {
            return null;
        }
    }

    public static Bitmap? GetBitmap(int size)
    {
        using var icon = Get(size);
        if (icon is null) return null;
        using var src = icon.ToBitmap();
        if (src.Width == size) return new Bitmap(src);
        var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(src, 0, 0, size, size);
        return bmp;
    }
}

/// <summary>Native splash: app icon, status text and a small spinner.</summary>
internal sealed class SplashView : Control
{
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 16 };
    private ThemeColors _theme;
    private Bitmap? _icon;
    private int _iconDpi;
    private float _angle;
    private string _status = "正在启动 iCloud Desk…";

    public SplashView(ThemeColors theme)
    {
        _theme = theme;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = theme.Background;
        _timer.Tick += (_, _) =>
        {
            _angle = (_angle + 7f) % 360f;
            Invalidate(SpinnerBounds());
        };
    }

    public string Status
    {
        get => _status;
        set { _status = value; Invalidate(); }
    }

    public void ApplyTheme(ThemeColors theme)
    {
        _theme = theme;
        BackColor = theme.Background;
        Invalidate();
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        _timer.Enabled = Visible;
    }

    private float Px(float v) => v * DeviceDpi / 96f;

    private Rectangle SpinnerBounds()
    {
        int size = (int)Px(22);
        var center = new Point(Width / 2, Height / 2 + (int)Px(70));
        return new Rectangle(center.X - size, center.Y - size, size * 2, size * 2);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.Clear(_theme.Background);

        int iconSize = (int)Px(80);
        if (_icon is null || _iconDpi != DeviceDpi)
        {
            _icon?.Dispose();
            _icon = AppIcon.GetBitmap(iconSize);
            _iconDpi = DeviceDpi;
        }
        int cx = Width / 2, cy = Height / 2;
        if (_icon is not null)
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawImage(_icon, cx - iconSize / 2, cy - iconSize - (int)Px(10), iconSize, iconSize);
        }

        using var font = new Font("Microsoft YaHei UI", 11f, FontStyle.Regular, GraphicsUnit.Point);
        var textRect = new Rectangle(0, cy + (int)Px(14), Width, (int)Px(30));
        TextRenderer.DrawText(g, _status, font, textRect, _theme.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);

        var sb = SpinnerBounds();
        float r = Px(9);
        var arcRect = new RectangleF(sb.X + sb.Width / 2f - r, sb.Y + sb.Height / 2f - r, r * 2, r * 2);
        using var track = new Pen(Color.FromArgb(40, _theme.Foreground), Px(2.4f));
        using var pen = new Pen(_theme.Accent, Px(2.4f)) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        g.DrawEllipse(track, arcRect);
        g.DrawArc(pen, arcRect, _angle, 90);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
            _icon?.Dispose();
        }
        base.Dispose(disposing);
    }
}

/// <summary>Friendly error panel with retry / open-logs actions and an optional download link.</summary>
internal sealed class ErrorView : UserControl
{
    private readonly TableLayoutPanel _layout;
    private readonly PictureBox _picture;
    private readonly Label _title;
    private readonly Label _message;
    private readonly TextBox _details;
    private readonly LinkLabel _link;
    private readonly LinkLabel _logs;
    private readonly Button _retry;
    private readonly Button _close;
    private string? _linkUrl;
    private ThemeColors _theme;

    public event EventHandler? RetryClicked;

    public ErrorView(ThemeColors theme)
    {
        _theme = theme;
        AutoScaleDimensions = new SizeF(96f, 96f);
        AutoScaleMode = AutoScaleMode.Dpi;
        DoubleBuffered = true;

        _layout = new TableLayoutPanel
        {
            ColumnCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(0),
        };
        _layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 560));

        _picture = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(56, 56), Anchor = AnchorStyles.Top, Margin = new Padding(0, 0, 0, 12) };
        _title = new Label { AutoSize = true, Anchor = AnchorStyles.Top, Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold), Margin = new Padding(0, 0, 0, 8) };
        _message = new Label { AutoSize = true, MaximumSize = new Size(560, 0), Anchor = AnchorStyles.Top, Font = new Font("Microsoft YaHei UI", 10f), TextAlign = ContentAlignment.MiddleCenter, Margin = new Padding(0, 0, 0, 12) };
        _details = new TextBox
        {
            Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BorderStyle = BorderStyle.FixedSingle,
            Width = 560, Height = 110, Font = new Font("Consolas", 9f), Margin = new Padding(0, 0, 0, 12), Anchor = AnchorStyles.Top,
        };
        _link = new LinkLabel { AutoSize = true, Anchor = AnchorStyles.Top, Font = new Font("Microsoft YaHei UI", 10f), Margin = new Padding(0, 0, 0, 8) };
        _link.LinkClicked += (_, _) => { if (_linkUrl is not null) Shell.OpenExternal(_linkUrl); };
        _logs = new LinkLabel { AutoSize = true, Anchor = AnchorStyles.Top, Font = new Font("Microsoft YaHei UI", 9f), Margin = new Padding(0, 0, 0, 16) };
        _logs.LinkClicked += (_, _) => Shell.OpenFolder(AppPaths.LogsDir);

        _retry = MakeButton("重试", primary: true);
        _retry.Click += (_, _) => RetryClicked?.Invoke(this, EventArgs.Empty);
        _close = MakeButton("关闭", primary: false);
        _close.Click += (_, _) => FindForm()?.Close();
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Anchor = AnchorStyles.Top, WrapContents = false, Margin = new Padding(0) };
        buttons.Controls.Add(_retry);
        buttons.Controls.Add(_close);

        foreach (Control c in new Control[] { _picture, _title, _message, _details, _link, _logs, buttons })
            _layout.Controls.Add(c);
        Controls.Add(_layout);

        _picture.Image = AppIcon.GetBitmap(128);
        ApplyTheme(theme);
    }

    private static Button MakeButton(string text, bool primary) => new()
    {
        Text = text,
        AutoSize = true,
        MinimumSize = new Size(96, 34),
        FlatStyle = FlatStyle.Flat,
        Font = new Font("Microsoft YaHei UI", 10f, primary ? FontStyle.Bold : FontStyle.Regular),
        Margin = new Padding(6, 0, 6, 0),
        Cursor = Cursors.Hand,
        Tag = primary,
    };

    public void ShowError(string title, string message, string? details, string? linkText = null, string? linkUrl = null)
    {
        _title.Text = title;
        _message.Text = message;
        _details.Text = (details ?? "").Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
        _details.Visible = !string.IsNullOrWhiteSpace(details);
        _linkUrl = linkUrl;
        _link.Text = linkText ?? "";
        _link.Visible = linkUrl is not null;
        _logs.Text = $"日志文件夹：{AppPaths.LogsDir}";
        CenterLayout();
        _retry.Focus();
    }

    public void ApplyTheme(ThemeColors theme)
    {
        _theme = theme;
        BackColor = theme.Background;
        _layout.BackColor = theme.Background;
        _title.ForeColor = theme.Foreground;
        _message.ForeColor = theme.Muted;
        _details.BackColor = theme.Surface;
        _details.ForeColor = theme.Foreground;
        foreach (var l in new[] { _link, _logs })
        {
            l.LinkColor = theme.Accent;
            l.ActiveLinkColor = theme.Accent;
            l.VisitedLinkColor = theme.Accent;
        }
        foreach (var b in new[] { _retry, _close })
        {
            bool primary = b.Tag is true;
            b.BackColor = primary ? theme.Accent : theme.Surface;
            b.ForeColor = primary ? Color.White : theme.Foreground;
            b.FlatAppearance.BorderColor = primary ? theme.Accent : Color.FromArgb(60, theme.Foreground);
            b.FlatAppearance.BorderSize = 1;
        }
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        CenterLayout();
    }

    private void CenterLayout()
    {
        if (_layout is null) return;
        var size = _layout.PreferredSize;
        _layout.Size = size;
        _layout.Location = new Point(Math.Max(0, (ClientSize.Width - size.Width) / 2), Math.Max(0, (ClientSize.Height - size.Height) / 2 - 20));
    }
}
