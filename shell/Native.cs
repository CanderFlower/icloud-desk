using System.Runtime.InteropServices;

namespace ICloudDesk.Shell;

internal static class Native
{
    public const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;
    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_CAPTION_COLOR = 35;
    public const int DWMWA_TEXT_COLOR = 36;
    public const int ASFW_ANY = -1;
    public const int SW_RESTORE = 9;

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AllowSetForegroundWindow(int dwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    // ---- custom caption / hotkey
    public const int WM_NCCALCSIZE = 0x0083;
    public const int WM_NCHITTEST = 0x0084;
    public const int WM_HOTKEY = 0x0312;
    public const int HTTRANSPARENT = -1;
    public const int HTCLIENT = 1;
    public const int HTCAPTION = 2;
    public const int HTTOP = 12;
    public const int HTTOPLEFT = 13;
    public const int HTTOPRIGHT = 14;
    public const uint MOD_ALT = 0x0001;
    public const uint MOD_CONTROL = 0x0002;
    public const uint MOD_NOREPEAT = 0x4000;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsZoomed(IntPtr hWnd);

    public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    /// <summary>Screen point packed in a WM_NCHITTEST lParam (signed, multi-monitor safe).</summary>
    public static Point PointFromLParam(IntPtr lParam)
    {
        long v = lParam.ToInt64();
        return new Point((short)(v & 0xFFFF), (short)((v >> 16) & 0xFFFF));
    }

    public static int ToColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

    /// <summary>Applies dark-mode chrome and (on Windows 11) a custom caption color to a top-level window.</summary>
    public static void ApplyTitleBar(IntPtr hwnd, bool dark, Color? caption)
    {
        if (hwnd == IntPtr.Zero) return;
        int useDark = dark ? 1 : 0;
        if (DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDark, sizeof(int)) != 0)
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, ref useDark, sizeof(int));

        if (caption is Color c)
        {
            int color = ToColorRef(c);
            DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ref color, sizeof(int));
            double luminance = (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0;
            int text = ToColorRef(luminance < 0.5 ? Color.White : Color.Black);
            DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, ref text, sizeof(int));
        }
    }
}
