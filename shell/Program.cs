namespace ICloudDesk.Shell;

internal sealed record LaunchOptions(bool Demo, bool Debug, bool Quit)
{
    public static LaunchOptions Parse(IEnumerable<string> args)
    {
        var set = new HashSet<string>(args.Select(a => a.Trim().ToLowerInvariant()));
        bool demo = set.Contains("--demo") || Environment.GetEnvironmentVariable("ICLOUD_DESK_DEMO") is "1" or "true";
        return new LaunchOptions(demo, set.Contains("--debug"), set.Contains("--quit"));
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var options = LaunchOptions.Parse(args);
        Native.SetCurrentProcessExplicitAppUserModelID(AppPaths.AppUserModelId);

        using var instance = SingleInstance.Acquire();
        if (!instance.IsFirst)
        {
            // Another window is already open: hand over the arguments (activate or quit) and exit.
            bool sent = SingleInstance.SendToRunningInstance(args, TimeSpan.FromSeconds(5));
            // "--quit" (used by the installer) waits until the running instance has really exited.
            if (sent && options.Quit && !instance.WaitForOwnerExit(TimeSpan.FromSeconds(15)))
                return 2;
            return sent ? 0 : 1;
        }
        if (options.Quit)
            return 0;

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log.Error("Unhandled UI exception", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Unhandled exception", e.ExceptionObject as Exception);

        Log.Info($"iCloud Desk shell {AppPaths.Version} starting (args: {string.Join(' ', args)})");
        using var form = new MainForm(options);
        instance.Listen(msg => form.OnSecondInstance(LaunchOptions.Parse(msg)));
        Application.Run(form);
        Log.Info("Shell exited");
        return 0;
    }
}
