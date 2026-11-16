using System.Text.Json;

namespace ICloudDesk.Shell;

/// <summary>Shell preferences at %APPDATA%\icloud-desk\shell.json.</summary>
internal sealed class ShellSettings
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static string FilePath => Path.Combine(AppPaths.DataDir, "shell.json");

    /// <summary>Closing the window hides it to the notification area instead of exiting.</summary>
    public bool CloseToTray { get; set; } = true;

    /// <summary>The "still running in the tray" hint has been shown once.</summary>
    public bool TrayHintShown { get; set; }

    /// <summary>Preferred UI language ("system", "zh-CN", or "en").</summary>
    public string? Language { get; set; }

    public static ShellSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<ShellSettings>(File.ReadAllText(FilePath), Options) ?? new();
        }
        catch (Exception ex)
        {
            Log.Error("Failed to read shell settings", ex);
        }
        return new();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.DataDir);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, Options));
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Error("Failed to save shell settings", ex);
        }
    }
}
