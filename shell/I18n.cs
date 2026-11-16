using System.Globalization;

namespace ICloudDesk.Shell;

internal static class I18n
{
    public static string? Preference { get; set; }

    public static bool IsEn
    {
        get
        {
            var pref = (Preference ?? "").Trim();
            if (pref.StartsWith("en", StringComparison.OrdinalIgnoreCase)) return true;
            if (pref.StartsWith("zh", StringComparison.OrdinalIgnoreCase)) return false;
            return !CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        }
    }

    public static string Tr(string zh, string en) => IsEn ? en : zh;
}
