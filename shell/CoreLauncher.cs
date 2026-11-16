using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ICloudDesk.Shell;

internal sealed class DaemonInfo
{
    [JsonPropertyName("pid")] public int Pid { get; set; }
    [JsonPropertyName("port")] public int Port { get; set; }
    [JsonPropertyName("url")] public string Url { get; set; } = "";
    [JsonPropertyName("ui_url")] public string UiUrl { get; set; } = "";
    [JsonPropertyName("token")] public string Token { get; set; } = "";
    [JsonPropertyName("demo")] public bool Demo { get; set; }
    [JsonPropertyName("version")] public string Version { get; set; } = "";
}

internal sealed class CoreLaunchException(string message, string? details = null) : Exception(message)
{
    public string? Details { get; } = details;
}

/// <summary>Locates the core (icd.exe, or icd.py in a dev checkout) and runs "daemon ensure".</summary>
internal static class CoreLauncher
{
    private static readonly TimeSpan EnsureTimeout = TimeSpan.FromSeconds(60);
    private static readonly HttpClient ProbeClient = new(new HttpClientHandler { UseProxy = false })
    {
        Timeout = TimeSpan.FromSeconds(1),
    };

    public sealed record CoreCommand(string FileName, IReadOnlyList<string> PrefixArgs, string WorkingDirectory)
    {
        public string Describe() => $"{FileName} {string.Join(' ', PrefixArgs)}".Trim();
    }

    public static CoreCommand? Locate()
    {
        var baseDir = AppContext.BaseDirectory;
        var exe = Path.Combine(baseDir, "icd.exe");
        if (File.Exists(exe))
            return new CoreCommand(exe, [], baseDir);

        // Dev fallback: walk up to a checkout containing icd.py and use its venv.
        for (var dir = new DirectoryInfo(baseDir); dir is not null; dir = dir.Parent)
        {
            var script = Path.Combine(dir.FullName, "icd.py");
            if (!File.Exists(script)) continue;
            var python = Path.Combine(dir.FullName, ".venv", "Scripts", "python.exe");
            if (!File.Exists(python)) python = "python.exe";
            return new CoreCommand(python, [script], dir.FullName);
        }
        return null;
    }

    public static async Task<DaemonInfo> EnsureAsync(bool demo, CancellationToken ct)
    {
        var existing = await TryReuseAsync(demo, ct);
        if (existing is not null) return existing;
        var cmd = Locate() ?? throw new CoreLaunchException(
            "找不到 iCloud Desk 核心组件 (icd.exe)。",
            $"在 {AppContext.BaseDirectory} 中没有找到 icd.exe。请重新安装 iCloud Desk。");

        var psi = new ProcessStartInfo
        {
            FileName = cmd.FileName,
            WorkingDirectory = cmd.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in cmd.PrefixArgs) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("daemon");
        psi.ArgumentList.Add("ensure");
        if (demo) psi.ArgumentList.Add("--demo");
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
        psi.Environment["PYTHONUTF8"] = "1";

        Log.Info($"Running core: {cmd.Describe()} daemon ensure{(demo ? " --demo" : "")}");
        var sw = Stopwatch.StartNew();

        using var proc = new Process { StartInfo = psi };
        try
        {
            proc.Start();
        }
        catch (Exception ex)
        {
            throw new CoreLaunchException("无法启动 iCloud Desk 核心组件。", $"{cmd.FileName}\n{ex.Message}");
        }
        proc.StandardInput.Close();

        // Read the streams without waiting for EOF: the daemon spawned by "ensure" could
        // inherit the pipe handles, which would keep them open after the CLI exits.
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var outTask = PumpAsync(proc.StandardOutput, stdout);
        var errTask = PumpAsync(proc.StandardError, stderr);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(EnsureTimeout);
        try
        {
            await proc.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: false); } catch { /* already gone */ }
            ct.ThrowIfCancellationRequested();
            throw new CoreLaunchException("启动 iCloud Desk 服务超时。", Tail(stderr));
        }
        await Task.WhenAny(Task.WhenAll(outTask, errTask), Task.Delay(1000, CancellationToken.None)).ConfigureAwait(false);

        string outText, errText;
        lock (stdout) outText = stdout.ToString();
        lock (stderr) errText = stderr.ToString();
        Log.Info($"Core exited with {proc.ExitCode} after {sw.ElapsedMilliseconds} ms");

        if (proc.ExitCode != 0)
        {
            Log.Error($"daemon ensure failed: {errText.Trim()} {outText.Trim()}");
            throw new CoreLaunchException("iCloud Desk 服务未能启动。", Tail(errText.Length > 0 ? errText : outText));
        }

        // Contract is one JSON line, but accept pretty-printed output (or leading log noise) too.
        int start = outText.IndexOf('{'), end = outText.LastIndexOf('}');
        string? line = start >= 0 && end > start ? outText[start..(end + 1)] : null;
        DaemonInfo? info = null;
        try
        {
            if (line is not null) info = JsonSerializer.Deserialize<DaemonInfo>(line);
        }
        catch (JsonException)
        {
            line = outText.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.StartsWith('{') && l.EndsWith('}'));
            try
            {
                if (line is not null) info = JsonSerializer.Deserialize<DaemonInfo>(line);
            }
            catch (JsonException ex)
            {
                Log.Error("Bad JSON from daemon ensure", ex);
            }
        }
        if (info is null || !IsLoopback(info.UiUrl))
        {
            Log.Error($"Unexpected output from daemon ensure: {outText}");
            throw new CoreLaunchException("iCloud Desk 服务返回了无法识别的信息。", Tail(outText + "\n" + errText));
        }
        Log.Info($"Daemon ready: pid={info.Pid} port={info.Port} demo={info.Demo} version={info.Version}");
        return info;
    }

    private static async Task<DaemonInfo?> TryReuseAsync(bool demo, CancellationToken ct)
    {
        var stateFile = Path.Combine(AppPaths.DataDir, demo ? "daemon-demo.json" : "daemon.json");
        var tokenFile = Path.Combine(AppPaths.DataDir, "token");
        if (!File.Exists(stateFile) || !File.Exists(tokenFile)) return null;
        var sw = Stopwatch.StartNew();
        try
        {
            var info = JsonSerializer.Deserialize<DaemonInfo>(await File.ReadAllTextAsync(stateFile, ct));
            if (info is null || info.Port is < 1 or > 65535 || info.Demo != demo || info.Version != AppPaths.Version)
                return null;
            var token = (await File.ReadAllTextAsync(tokenFile, ct)).Trim();
            if (token.Length < 32) return null;
            var url = $"http://127.0.0.1:{info.Port}/";
            using var request = new HttpRequestMessage(HttpMethod.Get, url + "api/ping");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await ProbeClient.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                Log.Info($"Existing daemon probe returned {(int)response.StatusCode}; running ensure");
                return null;
            }
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var ping = JsonSerializer.Deserialize<DaemonInfo>(json.RootElement.GetRawText());
            if (!json.RootElement.TryGetProperty("app", out var app) || app.GetString() != "icloud-desk" ||
                ping is null || ping.Pid != info.Pid || ping.Demo != demo || ping.Version != info.Version)
                return null;
            info.Url = url;
            info.Token = token;
            info.UiUrl = url + "?token=" + Uri.EscapeDataString(token);
            Log.Info($"Reused daemon: pid={info.Pid} port={info.Port} in {sw.ElapsedMilliseconds} ms");
            return info;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or HttpRequestException)
        {
            Log.Info($"Existing daemon unavailable ({ex.GetType().Name}); running ensure");
            return null;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            Log.Info("Existing daemon probe timed out; running ensure");
            return null;
        }
    }

    public static bool IsLoopback(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttp && u.IsLoopback;

    private static async Task PumpAsync(StreamReader reader, StringBuilder sink)
    {
        var buffer = new char[4096];
        try
        {
            int n;
            while ((n = await reader.ReadAsync(buffer).ConfigureAwait(false)) > 0)
                lock (sink) sink.Append(buffer, 0, n);
        }
        catch
        {
            // Stream closed.
        }
    }

    private static string Tail(StringBuilder sb)
    {
        lock (sb) return Tail(sb.ToString());
    }

    private static string Tail(string s)
    {
        s = s.Trim();
        const int max = 1500;
        return s.Length <= max ? s : "…" + s[^max..];
    }
}
