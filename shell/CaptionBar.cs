using System.Drawing.Drawing2D;

namespace ICloudDesk.Shell;

/// <summary>
/// Custom title bar (the native caption is removed in MainForm.WndProc). Draws the app title and
/// Windows 11 style caption buttons; everything except the buttons is reported as HTTRANSPARENT so the
/// form answers WM_NCHITTEST with HTCAPTION/HTTOP — dragging, Aero Snap, double-click maximize and the
/// system menu therefore stay native.
/// </summary>
internal sealed class CaptionBar : Control
{
    public const int LogicalHeight = 40;
    private const int LogicalButtonWidth = 46;
    private const int LogicalResizeBorder = 5;

    private enum Part { None, Minimize, Maximize, Close }

    private static readonly string GlyphFont =
        new System.Drawing.Text.InstalledFontCollection().Families.Any(f => f.Name == "Segoe Fluent Icons") ? "Segoe Fluent Icons" : "Segoe MDL2 Assets";

    private ThemeColors _theme;
    private Color _back;
    private bool _maximized;
    private bool _active = true;
    private Part _hover;
    private Part _pressed;
    private Bitmap? _icon;
    private int _iconDpi;

    public event EventHandler? MinimizeClicked;
    public event EventHandler? MaximizeClicked;
    public event EventHandler? CloseClicked;

    public CaptionBar(ThemeColors theme, Color back)
    {
        _theme = theme;
        _back = back;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        TabStop = false;
    }

    private int Dpi => DeviceDpi > 0 ? DeviceDpi : 96;
    private int S(int logical) => logical * Dpi / 96;
    public int ScaledHeight => S(LogicalHeight);
    public int ResizeBorder => S(LogicalResizeBorder);

    public bool Maximized
    {
        get => _maximized;
        set { if (_maximized != value) { _maximized = value; Invalidate(); } }
    }

    public bool Active
    {
        get => _active;
        set { if (_active != value) { _active = value; Invalidate(); } }
    }

    public void ApplyTheme(ThemeColors theme, Color back)
    {
        _theme = theme;
        _back = back;
        Invalidate();
    }

    private Rectangle ButtonRect(Part part)
    {
        int w = S(LogicalButtonWidth);
        int index = part switch { Part.Close => 1, Part.Maximize => 2, Part.Minimize => 3, _ => 0 };
        return index == 0 ? Rectangle.Empty : new Rectangle(Width - w * index, 0, w, Height);
    }

    private Part HitTest(Point p)
    {
        foreach (var part in new[] { Part.Close, Part.Maximize, Part.Minimize })
            if (ButtonRect(part).Contains(p)) return part;
        return Part.None;
    }

    /// <summary>True when the client point (in this control) should behave as caption / resize area.</summary>
    public bool IsDragArea(Point p) => HitTest(p) == Part.None || (!_maximized && p.Y < ResizeBorder);

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WM_NCHITTEST && IsDragArea(PointToClient(Native.PointFromLParam(m.LParam))))
        {
            m.Result = (IntPtr)Native.HTTRANSPARENT;
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var part = HitTest(e.Location);
        if (part != _hover) { _hover = part; Invalidate(); }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        _hover = Part.None;
        _pressed = Part.None;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        _pressed = HitTest(e.Location);
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        var pressed = _pressed;
        _pressed = Part.None;
        Invalidate();
        if (e.Button != MouseButtons.Left || pressed == Part.None || HitTest(e.Location) != pressed) return;
        _hover = Part.None;
        switch (pressed)
        {
            case Part.Minimize: MinimizeClicked?.Invoke(this, EventArgs.Empty); break;
            case Part.Maximize: MaximizeClicked?.Invoke(this, EventArgs.Empty); break;
            case Part.Close: CloseClicked?.Invoke(this, EventArgs.Empty); break;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(_back);
        var fore = _active ? _theme.Foreground : _theme.Muted;

        // Icon + title
        if (_icon is null || _iconDpi != Dpi)
        {
            _icon?.Dispose();
            _icon = AppIcon.GetBitmap(S(16));
            _iconDpi = Dpi;
        }
        int x = S(14);
        if (_icon is not null)
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawImage(_icon, x, (Height - _icon.Height) / 2, _icon.Width, _icon.Height);
            x += _icon.Width + S(8);
        }
        using (var font = new Font("Segoe UI", S(12), FontStyle.Regular, GraphicsUnit.Pixel))
        {
            var titleRect = new Rectangle(x, 0, Math.Max(0, Width - x - S(LogicalButtonWidth) * 3), Height);
            TextRenderer.DrawText(g, AppPaths.AppTitle, font, titleRect, _active ? _theme.Foreground : _theme.Muted, _back,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding);
        }

        // Caption buttons
        using var glyphFont = new Font(GlyphFont, S(10), FontStyle.Regular, GraphicsUnit.Pixel);
        foreach (var part in new[] { Part.Minimize, Part.Maximize, Part.Close })
        {
            var r = ButtonRect(part);
            bool hot = _hover == part, down = _pressed == part && hot;
            Color bg = _back, glyph = fore;
            if (part == Part.Close && (hot || down))
            {
                bg = down ? Color.FromArgb(0xC8, 0x3C, 0x31) : Color.FromArgb(0xC4, 0x2B, 0x1C);
                glyph = Color.White;
            }
            else if (hot || down)
            {
                int alpha = down ? (_theme.Dark ? 22 : 18) : (_theme.Dark ? 14 : 10);
                bg = Blend(_back, _theme.Dark ? Color.White : Color.Black, alpha / 100f);
            }
            using (var b = new SolidBrush(bg)) g.FillRectangle(b, r);
            string text = part switch
            {
                Part.Minimize => "\uE921",
                Part.Maximize => _maximized ? "\uE923" : "\uE922",
                _ => "\uE8BB",
            };
            TextRenderer.DrawText(g, text, glyphFont, r, glyph, bg,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
        }
    }

    private static Color Blend(Color a, Color b, float t) => Color.FromArgb(
        (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));

    protected override void Dispose(bool disposing)
    {
        if (disposing) _icon?.Dispose();
        base.Dispose(disposing);
    }
}
