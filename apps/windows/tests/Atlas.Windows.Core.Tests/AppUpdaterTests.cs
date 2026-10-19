using System.Net;
using System.Security.Cryptography;
using System.Text;
using Atlas.Windows.Core;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public sealed class AppUpdaterTests : IDisposable
{
    private const string Offered = "https://github.com/ithealthtech/nexus-atlas/releases/latest/download/AtlasForWindowsSetup.exe";
    private readonly string folder = Path.Combine(Path.GetTempPath(), "atlas-updater-test-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(folder))
            Directory.Delete(folder, recursive: true);
    }

    /// <summary>
    /// GitHub as it serves a release file: the "latest" address redirects to a versioned one, which redirects to
    /// the download server, which answers with the file or its checksum.
    /// </summary>
    private sealed class FakeGitHub(byte[] setup, string? checksum = null, string downloadHost = "release-assets.githubusercontent.com") : HttpMessageHandler
    {
        public List<string> Asked { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            Asked.Add(uri.AbsoluteUri);
            HttpResponseMessage Redirect(string to) => new(HttpStatusCode.Found) { Headers = { Location = new Uri(to) } };
            var file = uri.AbsolutePath.EndsWith(".sha256", StringComparison.Ordinal) ? "AtlasForWindowsSetup.exe.sha256" : "AtlasForWindowsSetup.exe";
            if (uri.AbsolutePath.Contains("/latest/download/", StringComparison.Ordinal))
                return Task.FromResult(Redirect($"https://github.com/ithealthtech/nexus-atlas/releases/download/v9.9.9/{file}"));
            if (uri.Host == "github.com")
                return Task.FromResult(Redirect($"https://{downloadHost}/123/{file}?token=x"));
            var body = file.EndsWith(".sha256", StringComparison.Ordinal)
                ? Encoding.ASCII.GetBytes((checksum ?? Convert.ToHexString(SHA256.HashData(setup)).ToLowerInvariant()) + "  AtlasForWindowsSetup.exe\r\n")
                : setup;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) });
        }
    }

    private static readonly byte[] Setup = [(byte)'M', (byte)'Z', .. Enumerable.Range(0, 5000).Select(i => (byte)i)];

    [Fact]
    public async Task Downloads_the_setup_program_through_GitHubs_redirects_and_checks_it()
    {
        var github = new FakeGitHub(Setup);
        using var updater = new AppUpdater(github);
        var progress = new List<double>();
        var path = await updater.DownloadAsync(new AppRelease("9.9.9", Offered), folder, new Progress<double>(progress.Add), TestContext.Current.CancellationToken);
        Assert.Equal(Setup, await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken));
        Assert.Equal("AtlasForWindowsSetup.exe", Path.GetFileName(path));
        Assert.Contains(github.Asked, a => a.StartsWith("https://release-assets.githubusercontent.com/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Refuses_a_download_that_does_not_match_its_checksum()
    {
        using var updater = new AppUpdater(new FakeGitHub(Setup, checksum: new string('a', 64)));
        var error = await Assert.ThrowsAsync<UpdateFailedException>(() => updater.DownloadAsync(new AppRelease("9.9.9", Offered), folder, cancellationToken: TestContext.Current.CancellationToken));
        Assert.Contains("checksum", error.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(folder, "AtlasForWindowsSetup.exe")));
    }

    [Fact]
    public async Task Refuses_a_file_that_is_not_a_Windows_program()
    {
        using var updater = new AppUpdater(new FakeGitHub(Encoding.ASCII.GetBytes("<html>not a program</html>")));
        await Assert.ThrowsAsync<UpdateFailedException>(() => updater.DownloadAsync(new AppRelease("9.9.9", Offered), folder, cancellationToken: TestContext.Current.CancellationToken));
        Assert.False(File.Exists(Path.Combine(folder, "AtlasForWindowsSetup.exe")));
    }

    [Fact]
    public async Task Will_not_follow_a_redirect_away_from_GitHub()
    {
        using var updater = new AppUpdater(new FakeGitHub(Setup, downloadHost: "downloads.example.com"));
        var error = await Assert.ThrowsAsync<UpdateFailedException>(() => updater.DownloadAsync(new AppRelease("9.9.9", Offered), folder, cancellationToken: TestContext.Current.CancellationToken));
        Assert.Contains("downloads.example.com", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("http://github.com/ithealthtech/nexus-atlas/releases/latest/download/AtlasForWindowsSetup.exe")]
    [InlineData("https://github.com/ithealthtech/nexus-atlas/releases/latest/download/SomethingElse.exe")]
    public async Task Only_takes_an_https_address_for_the_setup_program(string offered)
    {
        using var updater = new AppUpdater(new FakeGitHub(Setup));
        await Assert.ThrowsAsync<UpdateFailedException>(() => updater.DownloadAsync(new AppRelease("9.9.9", offered), folder, cancellationToken: TestContext.Current.CancellationToken));
    }
}
