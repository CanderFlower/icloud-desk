using System.Text.Json;

namespace ICloudDesk.Shell;

internal sealed class WindowPlacement
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Maximized { get; set; }
}

/// <summary>Persists window bounds to %APPDATA%\icloud-desk\window.json (physical pixels).</summary>
internal static class WindowStateStore
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static WindowPlacement? Load()
    {
        try
        {
            if (!File.Exists(AppPaths.WindowStateFile)) return null;
            var p = JsonSerializer.Deserialize<WindowPlacement>(File.ReadAllText(AppPaths.WindowStateFile), Options);
            if (p is null || p.Width < 200 || p.Height < 150) return null;
            var rect = new Rectangle(p.X, p.Y, p.Width, p.Height);
            // Require the title bar area to be reachable on some screen.
            var grip = new Rectangle(p.X + 40, p.Y, Math.Max(1, p.Width - 80), 40);
            return Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(grip)) ? p : null;
        }
        catch (Exception ex)
        {
            Log.Error("Failed to read window state", ex);
            return null;
        }
    }

    public static void Save(WindowPlacement p)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.DataDir);
            var tmp = AppPaths.WindowStateFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(p, Options));
            File.Move(tmp, AppPaths.WindowStateFile, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Error("Failed to save window state", ex);
        }
    }
}
