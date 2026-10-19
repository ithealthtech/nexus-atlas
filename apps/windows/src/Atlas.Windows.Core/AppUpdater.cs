using System.Net;
using System.Security.Cryptography;

namespace Atlas.Windows.Core;

/// <summary>An update couldn't be downloaded or didn't check out. The message says why, for the person.</summary>
public sealed class UpdateFailedException(string message) : Exception(message);

/// <summary>
/// Downloads the setup program for a newer version of this app and checks it before anything runs it. It only
/// fetches over https, from the address Atlas gave and GitHub's own download servers (where release files are
/// served from); the file must match the SHA-256 published beside it (<c>AtlasForWindowsSetup.exe.sha256</c>), be
/// a Windows program, and be a sensible size.
/// </summary>
public sealed class AppUpdater : IDisposable
{
    public const string SetupName = "AtlasForWindowsSetup.exe";
    private const long MaxBytes = 300L * 1024 * 1024;
    private const int MaxRedirects = 5;

    private readonly HttpClient http;

    /// <param name="handler">Tests pass a fake server.</param>
    public AppUpdater(HttpMessageHandler? handler = null)
    {
        // Redirects are followed by hand, so each address can be checked before it is used.
        http = handler is null
            ? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
            : new HttpClient(handler, disposeHandler: true);
        http.Timeout = TimeSpan.FromMinutes(10);
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"AtlasForWindows/{AppInfo.VersionText}");
    }

    /// <summary>Downloads and checks the setup program into <paramref name="folder"/>, and returns its path.</summary>
    public async Task<string> DownloadAsync(AppRelease release, string folder, IProgress<double>? progress = null, CancellationToken cancellationToken = default)
    {
        var link = release.DownloadLink ?? throw new UpdateFailedException("Atlas offered an update without a secure download address.");
        if (!link.AbsolutePath.EndsWith("/" + SetupName, StringComparison.OrdinalIgnoreCase))
            throw new UpdateFailedException("Atlas offered an update that isn't the Atlas for Windows setup program.");

        var expected = await ExpectedHashAsync(link, cancellationToken).ConfigureAwait(false);
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, SetupName);
        using (var response = await GetAsync(link, link, cancellationToken).ConfigureAwait(false))
        {
            var total = response.Content.Headers.ContentLength;
            if (total > MaxBytes)
                throw new UpdateFailedException("The download is much larger than the setup program should be.");
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using (var source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false))
            await using (var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[81920];
                long read = 0;
                int count;
                while ((count = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
                {
                    read += count;
                    if (read > MaxBytes)
                        throw new UpdateFailedException("The download is much larger than the setup program should be.");
                    hash.AppendData(buffer, 0, count);
                    await file.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
                    if (total is > 0)
                        progress?.Report((double)read / total.Value);
                }
            }
            var actual = Convert.ToHexString(hash.GetHashAndReset());
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(path);
                throw new UpdateFailedException("The download didn't match its published checksum, so it wasn't installed. Try again later.");
            }
        }

        // A Windows program starts with "MZ".
        var start = new byte[2];
        await using (var check = File.OpenRead(path))
            await check.ReadExactlyAsync(start, cancellationToken).ConfigureAwait(false);
        if (start[0] != 'M' || start[1] != 'Z')
        {
            File.Delete(path);
            throw new UpdateFailedException("The download isn't a Windows program, so it wasn't installed.");
        }
        progress?.Report(1);
        return path;
    }

    // The checksum file published with every release: the hash, then (optionally) the file's name.
    private async Task<string> ExpectedHashAsync(Uri link, CancellationToken cancellationToken)
    {
        var checksum = new Uri(link.AbsoluteUri + ".sha256");
        using var response = await GetAsync(checksum, link, cancellationToken).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var hash = text.Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        if (hash.Length != 64 || !hash.All(Uri.IsHexDigit))
            throw new UpdateFailedException("The update's checksum couldn't be read, so it wasn't installed.");
        return hash;
    }

    private async Task<HttpResponseMessage> GetAsync(Uri address, Uri offered, CancellationToken cancellationToken)
    {
        for (var hops = 0; hops <= MaxRedirects; hops++)
        {
            if (!Trusted(address, offered))
                throw new UpdateFailedException($"The download was sent to {address.Host}, which isn't where Atlas for Windows comes from.");
            var response = await http.GetAsync(address, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode is HttpStatusCode.Moved or HttpStatusCode.Found or HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect
                && response.Headers.Location is { } next)
            {
                address = next.IsAbsoluteUri ? next : new Uri(address, next);
                response.Dispose();
                continue;
            }
            if (!response.IsSuccessStatusCode)
            {
                var status = (int)response.StatusCode;
                response.Dispose();
                throw new UpdateFailedException(status == 404
                    ? "The update isn't available for download yet. Try again in a few minutes."
                    : $"The download failed (the server answered {status}).");
            }
            return response;
        }
        throw new UpdateFailedException("The download was redirected too many times.");
    }

    /// <summary>
    /// The address Atlas gave, or one of GitHub's: github.com, where releases live, and its servers that hand out
    /// release files. Always https.
    /// </summary>
    internal static bool Trusted(Uri address, Uri offered)
    {
        if (address.Scheme != Uri.UriSchemeHttps)
            return false;
        var host = address.IdnHost;
        return string.Equals(host, offered.IdnHost, StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "github.com", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".githubusercontent.com", StringComparison.OrdinalIgnoreCase);
    }

    public void Dispose() => http.Dispose();
}
