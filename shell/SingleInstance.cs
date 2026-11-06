using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace ICloudDesk.Shell;

/// <summary>
/// Single-instance guard: a per-session named mutex plus a named pipe that lets a second
/// launch hand its arguments to the running instance (activate / quit).
/// </summary>
internal sealed class SingleInstance : IDisposable
{
    private static readonly string Suffix = $"{Environment.UserName}-{System.Diagnostics.Process.GetCurrentProcess().SessionId}";
    private static readonly string MutexName = $@"Local\iCloudDesk.SingleInstance.{Suffix}";
    private static readonly string PipeName = $"iCloudDesk.Activate.{Suffix}";

    private readonly Mutex _mutex;
    private readonly CancellationTokenSource _cts = new();

    private SingleInstance(Mutex mutex) => _mutex = mutex;

    public bool IsFirst { get; private set; }

    public static SingleInstance Acquire()
    {
        var mutex = new Mutex(initiallyOwned: true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            try
            {
                createdNew = mutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                createdNew = true;
            }
        }
        return new SingleInstance(mutex) { IsFirst = createdNew };
    }

    /// <summary>Starts listening for messages from later launches; <paramref name="onMessage"/> runs on a worker thread.</summary>
    public void Listen(Action<string[]> onMessage)
    {
        var token = _cts.Token;
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync(token).ConfigureAwait(false);
                    using var reader = new StreamReader(server, Encoding.UTF8);
                    var line = await reader.ReadLineAsync(token).ConfigureAwait(false);
                    var args = string.IsNullOrEmpty(line) ? [] : JsonSerializer.Deserialize<string[]>(line) ?? [];
                    onMessage(args);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception ex)
                {
                    Log.Error("Single-instance pipe error", ex);
                    await Task.Delay(200, CancellationToken.None).ConfigureAwait(false);
                }
            }
        }, token);
    }

    /// <summary>Sends the arguments to the running instance. Retries briefly while it is still starting.</summary>
    public static bool SendToRunningInstance(string[] args, TimeSpan timeout)
    {
        Native.AllowSetForegroundWindow(Native.ASFW_ANY);
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            try
            {
                using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
                client.Connect(500);
                using var writer = new StreamWriter(client, new UTF8Encoding(false));
                writer.WriteLine(JsonSerializer.Serialize(args));
                writer.Flush();
                return true;
            }
            catch (Exception ex) when (ex is TimeoutException or IOException)
            {
                if (DateTime.UtcNow > deadline)
                {
                    Log.Error("Could not reach the running instance", ex);
                    return false;
                }
                Thread.Sleep(200);
            }
        }
    }

    /// <summary>Blocks until the instance that owns the mutex exits (it releases or abandons the mutex).</summary>
    public bool WaitForOwnerExit(TimeSpan timeout)
    {
        if (IsFirst) return true;
        try
        {
            IsFirst = _mutex.WaitOne(timeout);
        }
        catch (AbandonedMutexException)
        {
            IsFirst = true;
        }
        return IsFirst;
    }

    public void Dispose()
    {
        _cts.Cancel();
        if (IsFirst)
        {
            try { _mutex.ReleaseMutex(); } catch { /* not owned */ }
        }
        _mutex.Dispose();
    }
}
