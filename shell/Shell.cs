using System.Diagnostics;

namespace ICloudDesk.Shell;

internal static class Shell
{
    public static bool IsExternalSafe(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) &&
        (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeMailto);

    public static void OpenExternal(string? url)
    {
        if (!IsExternalSafe(url))
        {
            Log.Info($"Refused to open external URL: {url}");
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(url!) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log.Error($"Failed to open {url}", ex);
        }
    }

    public static void OpenFolder(string path)
    {
        try
        {
            Directory.CreateDirectory(path);
            Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { path }, UseShellExecute = false });
        }
        catch (Exception ex)
        {
            Log.Error($"Failed to open folder {path}", ex);
        }
    }
}
