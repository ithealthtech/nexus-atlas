using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace Atlas.Windows.Core;

/// <summary>What the browser brought back to the app.</summary>
public sealed record LoopbackReply(string? Code, string? Error);

/// <summary>
/// The one-shot loopback redirect for browser sign-in (RFC 8252). It listens on 127.0.0.1 only, on a port the system
/// picks, answers exactly one matching reply, and then stops. It is the only port the app ever listens on.
/// A plain socket is used instead of HttpListener, which needs a URL reservation for 127.0.0.1 on Windows.
/// </summary>
public sealed class LoopbackListener : IDisposable
{
    private const string CallbackPath = "/callback";
    private const int MaxRequestBytes = 8 * 1024;
    private readonly TcpListener listener;
    private bool disposed;

    public LoopbackListener()
    {
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(backlog: 4);
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        RedirectUri = $"http://127.0.0.1:{port}{CallbackPath}";
    }

    /// <summary>The address to give the server as redirect_uri.</summary>
    public string RedirectUri { get; }

    /// <summary>
    /// Waits for the browser to return with this state. Anything else that connects (another program guessing the
    /// port, a favicon request) gets a 404 and is ignored, so it can neither end the wait nor inject a code.
    /// </summary>
    public async Task<LoopbackReply> WaitAsync(string expectedState, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        try
        {
            while (true)
            {
                using var client = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
                var reply = await HandleAsync(client, expectedState, cancellationToken).ConfigureAwait(false);
                if (reply is not null)
                    return reply;
            }
        }
        finally
        {
            Dispose();
        }
    }

    private static async Task<LoopbackReply?> HandleAsync(TcpClient client, string expectedState, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var stream = client.GetStream();
        string? target;
        try
        {
            target = await ReadRequestTargetAsync(stream, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
        var query = target is null ? null : ParseCallback(target);
        if (query is null || !query.TryGetValue("state", out var state) || !SameState(state, expectedState))
        {
            await RespondAsync(stream, 404, "Not found", "This address is only for signing in to Atlas for Windows.", cancellationToken).ConfigureAwait(false);
            return null;
        }
        query.TryGetValue("code", out var code);
        query.TryGetValue("error", out var error);
        var ok = !string.IsNullOrEmpty(code) && string.IsNullOrEmpty(error);
        await RespondAsync(
            stream,
            200,
            ok ? "Signed in" : "Sign-in cancelled",
            ok ? "You're signed in to Atlas for Windows. You can close this tab." : "Atlas for Windows was not signed in. You can close this tab.",
            cancellationToken).ConfigureAwait(false);
        return new LoopbackReply(ok ? code : null, ok ? null : error ?? "invalid_request");
    }

    /// <summary>Reads the request line of a GET and returns its target, or null for anything else.</summary>
    internal static async Task<string?> ReadRequestTargetAsync(Stream stream, CancellationToken cancellationToken)
    {
        var buffer = new byte[MaxRequestBytes];
        var length = 0;
        while (length < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(length), cancellationToken).ConfigureAwait(false);
            if (read == 0)
                break;
            length += read;
            // Only the request line matters; stop once the headers are complete.
            if (Encoding.ASCII.GetString(buffer, 0, length).Contains("\r\n\r\n", StringComparison.Ordinal))
                break;
        }
        var text = Encoding.ASCII.GetString(buffer, 0, length);
        var end = text.IndexOf("\r\n", StringComparison.Ordinal);
        var parts = (end < 0 ? text : text[..end]).Split(' ');
        return parts.Length == 3 && parts[0] == "GET" && parts[2].StartsWith("HTTP/1.", StringComparison.Ordinal) ? parts[1] : null;
    }

    /// <summary>The query of a request to the callback path, or null for any other path.</summary>
    internal static Dictionary<string, string>? ParseCallback(string target)
    {
        var mark = target.IndexOf('?', StringComparison.Ordinal);
        var path = mark < 0 ? target : target[..mark];
        if (path != CallbackPath)
            return null;
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        if (mark < 0)
            return values;
        foreach (var pair in target[(mark + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=', StringComparison.Ordinal);
            var key = Uri.UnescapeDataString((eq < 0 ? pair : pair[..eq]).Replace('+', ' '));
            var value = eq < 0 ? "" : Uri.UnescapeDataString(pair[(eq + 1)..].Replace('+', ' '));
            // A repeated parameter is suspicious; refuse rather than pick one.
            if (!values.TryAdd(key, value))
                return null;
        }
        return values;
    }

    private static bool SameState(string actual, string expected) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(actual), Encoding.UTF8.GetBytes(expected));

    private static async Task RespondAsync(Stream stream, int status, string title, string message, CancellationToken cancellationToken)
    {
        var body = $"<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>{title}</title>" +
                   $"<body style=\"font-family:Segoe UI,sans-serif;padding:3rem;text-align:center\"><h1>{title}</h1><p>{message}</p></body></html>";
        var bytes = Encoding.UTF8.GetBytes(body);
        var head = $"HTTP/1.1 {status} {(status == 200 ? "OK" : "Not Found")}\r\n" +
                   "Content-Type: text/html; charset=utf-8\r\n" +
                   $"Content-Length: {bytes.Length}\r\n" +
                   "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n" +
                   "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n" +
                   "Connection: close\r\n\r\n";
        try
        {
            await stream.WriteAsync(Encoding.ASCII.GetBytes(head), cancellationToken).ConfigureAwait(false);
            await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        }
        catch (IOException)
        {
            // The browser went away; the reply was still received.
        }
    }

    public void Dispose()
    {
        if (disposed)
            return;
        disposed = true;
        listener.Stop();
        listener.Dispose();
    }
}
