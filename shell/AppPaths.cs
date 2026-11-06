using System.Text;

namespace ICloudDesk.Shell;

internal static class AppPaths
{
    public const string AppTitle = "iCloud Desk";
    public const string AppUserModelId = "iCloudDesk.App";

    // Same data directory as the core (app/config.py honours ICLOUD_DESK_HOME too).
    public static string DataDir { get; } =
        Environment.GetEnvironmentVariable("ICLOUD_DESK_HOME") is { Length: > 0 } home
            ? home
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "icloud-desk");

    public static string LogsDir => Path.Combine(DataDir, "logs");

    public static string WindowStateFile => Path.Combine(DataDir, "window.json");

    public static string WebViewDataDir { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iCloud Desk", "WebView2");

    public static string Version { get; } = GetVersion();

    private static string GetVersion()
    {
        var v = Application.ProductVersion;
        int plus = v.IndexOf('+');
        return plus >= 0 ? v[..plus] : v;
    }
}

/// <summary>Tiny append-only log at %APPDATA%\icloud-desk\logs\shell.log.</summary>
internal static class Log
{
    private static readonly object Gate = new();

    public static void Info(string message) => Write("INFO", message);

    public static void Error(string message, Exception? ex = null) =>
        Write("ERROR", ex is null ? message : $"{message}: {ex}");

    private static void Write(string level, string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(AppPaths.LogsDir);
                var file = Path.Combine(AppPaths.LogsDir, "shell.log");
                var info = new FileInfo(file);
                if (info.Exists && info.Length > 1_000_000)
                    File.Move(file, file + ".1", overwrite: true);
                File.AppendAllText(file,
                    $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{Environment.ProcessId}] {level} {message}{Environment.NewLine}",
                    Encoding.UTF8);
            }
        }
        catch
        {
            // Logging must never break the app.
        }
    }
}
