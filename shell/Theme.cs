using Microsoft.Win32;

namespace ICloudDesk.Shell;

internal sealed record ThemeColors(bool Dark, Color Background, Color Foreground, Color Muted, Color Accent, Color Surface);

internal static class Theme
{
    public static readonly ThemeColors Light = new(false,
        Color.FromArgb(0xF5, 0xF5, 0xF7), Color.FromArgb(0x1D, 0x1D, 0x1F), Color.FromArgb(0x6E, 0x6E, 0x73),
        Color.FromArgb(0x00, 0x71, 0xE3), Color.White);

    public static readonly ThemeColors Dark = new(true,
        Color.FromArgb(0x1C, 0x1C, 0x1E), Color.FromArgb(0xF5, 0xF5, 0xF7), Color.FromArgb(0x98, 0x98, 0x9D),
        Color.FromArgb(0x0A, 0x84, 0xFF), Color.FromArgb(0x2C, 0x2C, 0x2E));

    public static bool SystemPrefersDark()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }
        catch
        {
            return false;
        }
    }

    public static ThemeColors ForDark(bool dark) => dark ? Dark : Light;

    public static bool TryParseHex(string? s, out Color color)
    {
        color = default;
        if (string.IsNullOrWhiteSpace(s)) return false;
        s = s.Trim().TrimStart('#');
        if (s.Length == 3) s = string.Concat(s.Select(ch => new string(ch, 2)));
        if (s.Length != 6 || !int.TryParse(s, System.Globalization.NumberStyles.HexNumber, null, out int rgb)) return false;
        color = Color.FromArgb((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
        return true;
    }
}
