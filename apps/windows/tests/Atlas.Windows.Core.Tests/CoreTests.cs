using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Atlas.Windows.Core;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public class AtlasAddressTests
{
    [Theory]
    [InlineData("atlas.example.com", "https://atlas.example.com")]
    [InlineData("https://atlas.example.com/some/page?x=1", "https://atlas.example.com")]
    [InlineData("https://atlas.example.com:8443", "https://atlas.example.com:8443")]
    [InlineData("http://127.0.0.1:4318", "http://127.0.0.1:4318")]
    [InlineData("http://localhost:4318", "http://localhost:4318")]
    public void Accepts_https_or_a_server_on_this_computer(string input, string expected)
    {
        Assert.True(AtlasAddress.TryParse(input, out var address, out _));
        Assert.Equal(expected, address!.ToString());
        Assert.Equal($"{expected}/api/v1/", address.Api.ToString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("http://atlas.example.com")]
    [InlineData("ftp://atlas.example.com")]
    [InlineData("https://user:pass@atlas.example.com")]
    public void Refuses_anything_else(string input)
    {
        Assert.False(AtlasAddress.TryParse(input, out _, out var error));
        Assert.NotEmpty(error);
    }

    [Fact]
    public void Links_records_to_their_page_in_the_web_app()
    {
        var atlas = AtlasAddress.Parse("https://atlas.example.com");
        Assert.Equal("https://atlas.example.com/passwords/p1", atlas.WebLink("password", "p1").ToString());
        Assert.Equal("https://atlas.example.com/assets/a1", atlas.WebLink("asset", "a1").ToString());
        Assert.Equal("https://atlas.example.com/clients/c1/contacts", atlas.WebLink("contact", "x", "c1").ToString());
    }
}

public class PkceTests
{
    [Fact]
    public void Matches_the_RFC_7636_example()
    {
        Assert.Equal(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            Pkce.ChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
    }

    [Fact]
    public void Is_random_url_safe_and_the_length_Atlas_expects()
    {
        var a = Pkce.Create();
        var b = Pkce.Create();
        Assert.NotEqual(a.Verifier, b.Verifier);
        Assert.NotEqual(a.State, b.State);
        Assert.Matches("^[A-Za-z0-9_-]{43}$", a.Verifier);
        Assert.Matches("^[A-Za-z0-9_-]{43}$", a.Challenge);
        Assert.Matches("^[A-Za-z0-9_-]{43}$", a.State);
    }
}

public class LoopbackListenerTests
{
    private static async Task<(int Status, string Body)> Get(string url)
    {
        using var http = new HttpClient();
        using var response = await http.GetAsync(new Uri(url), TestContext.Current.CancellationToken);
        return ((int)response.StatusCode, await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Ignores_requests_without_the_right_state_then_takes_the_real_reply()
    {
        using var listener = new LoopbackListener();
        Assert.Matches(@"^http://127\.0\.0\.1:\d+/callback$", listener.RedirectUri);
        var wait = listener.WaitAsync("expected-state", TestContext.Current.CancellationToken);

        Assert.Equal(404, (await Get($"{listener.RedirectUri}?code=evil&state=guess")).Status);
        Assert.Equal(404, (await Get(listener.RedirectUri.Replace("/callback", "/favicon.ico", StringComparison.Ordinal))).Status);
        Assert.Equal(404, (await Get($"{listener.RedirectUri}?code=a&state=expected-state&state=expected-state")).Status);
        Assert.False(wait.IsCompleted);

        var (status, body) = await Get($"{listener.RedirectUri}?code=the-code&state=expected-state");
        Assert.Equal(200, status);
        Assert.Contains("You can close this tab", body, StringComparison.Ordinal);
        var reply = await wait;
        Assert.Equal("the-code", reply.Code);
        Assert.Null(reply.Error);

        // One-shot: nothing is listening any more.
        var port = new Uri(listener.RedirectUri).Port;
        using var socket = new TcpClient();
        await Assert.ThrowsAnyAsync<SocketException>(() => socket.ConnectAsync(IPAddress.Loopback, port, TestContext.Current.CancellationToken).AsTask());
    }

    [Fact]
    public async Task Reports_a_cancelled_sign_in()
    {
        using var listener = new LoopbackListener();
        var wait = listener.WaitAsync("s", TestContext.Current.CancellationToken);
        await Get($"{listener.RedirectUri}?error=access_denied&state=s");
        var reply = await wait;
        Assert.Null(reply.Code);
        Assert.Equal("access_denied", reply.Error);
    }

    [Theory]
    [InlineData("GET /callback?code=1 HTTP/1.1\r\nHost: x\r\n\r\n", "/callback?code=1")]
    [InlineData("POST /callback HTTP/1.1\r\n\r\n", null)]
    [InlineData("GET /callback\r\n\r\n", null)]
    [InlineData("garbage", null)]
    public async Task Reads_only_a_GET_request_line(string request, string? target)
    {
        using var stream = new MemoryStream(Encoding.ASCII.GetBytes(request));
        Assert.Equal(target, await LoopbackListener.ReadRequestTargetAsync(stream, TestContext.Current.CancellationToken));
    }
}

/// <summary>A fake Atlas server for the API client.</summary>
internal sealed class FakeAtlas : HttpMessageHandler
{
    public List<(HttpMethod Method, string Path, string? Authorization, string Body)> Requests { get; } = [];
    public Func<HttpRequestMessage, string, HttpResponseMessage> Respond { get; set; } = (_, _) => Json(200, "{}");

    public static HttpResponseMessage Json(int status, string body) =>
        new((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add((request.Method, request.RequestUri!.PathAndQuery, request.Headers.Authorization?.ToString(), body));
        return Respond(request, body);
    }
}

public class AtlasClientTests
{
    private const string TokenJson =
        """{"access_token":"atlasd_token","token_type":"Bearer","scope":"read reveal","expires_in":2592000,"session_id":"s1","user":{"name":"Tess Tech","email":"tess@atlas.test"}}""";

    [Fact]
    public void Builds_the_sign_in_address_Atlas_expects()
    {
        using var client = new AtlasClient(AtlasAddress.Parse("https://atlas.example.com"), new FakeAtlas());
        var pkce = Pkce.Create();
        var uri = client.AuthorizeUri(pkce, "http://127.0.0.1:50000/callback", "TECH-LAPTOP 07");
        Assert.Equal("/native/authorize", uri.AbsolutePath);
        var query = uri.Query.TrimStart('?').Split('&').Select(p => p.Split('=')).ToDictionary(p => p[0], p => Uri.UnescapeDataString(p[1]));
        Assert.Equal("atlas-windows", query["client_id"]);
        Assert.Equal("http://127.0.0.1:50000/callback", query["redirect_uri"]);
        Assert.Equal(pkce.Challenge, query["code_challenge"]);
        Assert.Equal("S256", query["code_challenge_method"]);
        Assert.Equal(pkce.State, query["state"]);
        Assert.Equal("read reveal", query["scope"]);
        Assert.Equal("TECH-LAPTOP 07", query["device_name"]);
        Assert.DoesNotContain("verifier", uri.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Exchanges_the_code_then_sends_the_token_as_a_bearer()
    {
        var atlas = new FakeAtlas { Respond = (r, _) => FakeAtlas.Json(200, r.RequestUri!.AbsolutePath.EndsWith("/token", StringComparison.Ordinal) ? TokenJson : "[]") };
        using var client = new AtlasClient(AtlasAddress.Parse("https://atlas.example.com"), atlas);
        var token = await client.ExchangeCodeAsync("the-code", "the-verifier", "http://127.0.0.1:1/callback", TestContext.Current.CancellationToken);
        Assert.Equal("atlasd_token", token.AccessToken);
        Assert.Equal("Tess Tech", token.User.Name);
        var exchange = atlas.Requests[0];
        Assert.Equal("/api/v1/native/token", exchange.Path);
        Assert.Null(exchange.Authorization);
        using var sent = JsonDocument.Parse(exchange.Body);
        Assert.Equal("authorization_code", sent.RootElement.GetProperty("grant_type").GetString());
        Assert.Equal("the-verifier", sent.RootElement.GetProperty("code_verifier").GetString());

        await client.SearchAsync("harbor router", 8, TestContext.Current.CancellationToken);
        Assert.Equal("/api/v1/search?q=harbor%20router&limit=8", atlas.Requests[1].Path);
        Assert.Equal("Bearer atlasd_token", atlas.Requests[1].Authorization);
    }

    [Fact]
    public async Task Copies_through_the_audited_reveal()
    {
        var atlas = new FakeAtlas { Respond = (_, _) => FakeAtlas.Json(200, """{"value":"123456","expiresIn":12}""") };
        using var client = new AtlasClient(AtlasAddress.Parse("https://atlas.example.com"), atlas);
        client.UseToken("atlasd_token");
        var code = await client.RevealForCopyAsync("p1", SecretField.OneTimeCode, "Ticket 42", TestContext.Current.CancellationToken);
        Assert.Equal("123456", code.Value);
        Assert.Equal(12, code.ExpiresIn);
        Assert.Equal("/api/v1/passwords/p1/reveal", atlas.Requests[0].Path);
        using var sent = JsonDocument.Parse(atlas.Requests[0].Body);
        Assert.Equal("totp", sent.RootElement.GetProperty("field").GetString());
        Assert.True(sent.RootElement.GetProperty("copy").GetBoolean());
        Assert.Equal("Ticket 42", sent.RootElement.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Forgets_the_token_when_the_session_ends_and_passes_on_refusals()
    {
        var atlas = new FakeAtlas();
        using var client = new AtlasClient(AtlasAddress.Parse("https://atlas.example.com"), atlas);
        client.UseToken("atlasd_token");
        atlas.Respond = (_, _) => FakeAtlas.Json(400, """{"error":"This client requires a reason before revealing passwords.","code":"reason_required"}""");
        var refused = await Assert.ThrowsAsync<AtlasApiException>(() => client.RevealForCopyAsync("p1", SecretField.Password, cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal("reason_required", refused.Code);
        Assert.True(client.SignedIn);

        atlas.Respond = (_, _) => FakeAtlas.Json(401, """{"error":"Sign in to Atlas again from the app.","code":"session"}""");
        var ended = await Assert.ThrowsAsync<SessionEndedException>(() => client.SearchAsync("x", cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal("Sign in to Atlas again from the app.", ended.Message);
        Assert.False(client.SignedIn);
    }
}

public class SignInTests
{
    [Fact]
    public async Task Runs_the_browser_round_trip()
    {
        var atlas = new FakeAtlas();
        atlas.Respond = (_, _) => FakeAtlas.Json(200,
            """{"access_token":"atlasd_token","token_type":"Bearer","scope":"read reveal","expires_in":1,"session_id":"s1","user":{"name":"T","email":"t@atlas.test"}}""");
        using var client = new AtlasClient(AtlasAddress.Parse("https://atlas.example.com"), atlas);
        // The "browser": approves at once and follows the redirect back to the app.
        void Browser(Uri authorize)
        {
            var query = authorize.Query.TrimStart('?').Split('&').Select(p => p.Split('=')).ToDictionary(p => p[0], p => Uri.UnescapeDataString(p[1]));
            _ = Task.Run(async () =>
            {
                using var http = new HttpClient();
                await http.GetAsync(new Uri($"{query["redirect_uri"]}?code=the-code&state={query["state"]}"));
            });
        }
        var result = await SignIn.RunAsync(client, "PC-1", Browser, TestContext.Current.CancellationToken);
        Assert.Equal("atlasd_token", result.AccessToken);
        Assert.True(client.SignedIn);
        using var sent = JsonDocument.Parse(atlas.Requests.Single().Body);
        Assert.Equal("the-code", sent.RootElement.GetProperty("code").GetString());
        Assert.Matches(@"^http://127\.0\.0\.1:\d+/callback$", sent.RootElement.GetProperty("redirect_uri").GetString());
    }
}

internal sealed class ReversingProtector : IDataProtector
{
    public byte[] Protect(byte[] data) => data.Reverse().Select(b => (byte)(b ^ 0x5a)).ToArray();

    public byte[] Unprotect(byte[] data) =>
        data.Length > 0 && data[0] == 0 ? throw new System.Security.Cryptography.CryptographicException() : data.Select(b => (byte)(b ^ 0x5a)).Reverse().ToArray();
}

public sealed class SecureStoreTests : IDisposable
{
    private readonly string folder = Path.Combine(Path.GetTempPath(), $"atlas-{Guid.NewGuid():N}");

    [Fact]
    public void Keeps_the_token_encrypted_and_only_for_its_server()
    {
        var store = new SecureStore(folder, new ReversingProtector());
        var atlas = AtlasAddress.Parse("https://atlas.example.com");
        store.SaveToken(atlas, "atlasd_secret-token");
        Assert.DoesNotContain("atlasd_secret-token", File.ReadAllText(Path.Combine(folder, "session.bin")), StringComparison.Ordinal);
        Assert.Equal("atlasd_secret-token", store.LoadToken(atlas));
        Assert.Null(store.LoadToken(AtlasAddress.Parse("https://other.example.com")));

        File.WriteAllBytes(Path.Combine(folder, "session.bin"), [0, 1, 2]);
        Assert.Null(store.LoadToken(atlas));
        store.ForgetToken();
        Assert.Null(store.LoadToken(atlas));
    }

    [Fact]
    public void Protects_the_token_with_DPAPI_on_Windows()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "DPAPI is part of Windows.");
        if (OperatingSystem.IsWindows())
            DpapiRoundTrip();
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private void DpapiRoundTrip()
    {
        var store = new SecureStore(folder, new DpapiProtector());
        var atlas = AtlasAddress.Parse("https://atlas.example.com");
        store.SaveToken(atlas, "atlasd_secret-token");
        var raw = File.ReadAllBytes(Path.Combine(folder, "session.bin"));
        Assert.DoesNotContain("atlasd_secret-token", Encoding.UTF8.GetString(raw), StringComparison.Ordinal);
        Assert.Equal("atlasd_secret-token", store.LoadToken(atlas));
        // Without the app's entropy, DPAPI refuses (another app running as the same person can't simply decrypt it).
        Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(
            () => System.Security.Cryptography.ProtectedData.Unprotect(raw, null, System.Security.Cryptography.DataProtectionScope.CurrentUser));
    }

    [Fact]
    public void Saves_settings_without_secrets()
    {
        var store = new SecureStore(folder, new ReversingProtector());
        Assert.Null(store.LoadSettings().AtlasUrl);
        store.SaveSettings(new AppSettings { AtlasUrl = "https://atlas.example.com", StartWithWindows = true });
        Assert.Equal("https://atlas.example.com", store.LoadSettings().AtlasUrl);
        Assert.True(store.LoadSettings().StartWithWindows);
    }

    public void Dispose()
    {
        if (Directory.Exists(folder))
            Directory.Delete(folder, recursive: true);
    }
}

internal sealed class FakeClipboard : IClipboard
{
    public string? Text { get; set; }
    public bool LastSensitive { get; private set; }

    public void SetText(string text, bool sensitive)
    {
        Text = text;
        LastSensitive = sensitive;
    }

    public string? GetText() => Text;

    public void Clear() => Text = null;
}

public class ClipboardGuardTests
{
    [Fact]
    public void Clears_a_secret_after_30_seconds()
    {
        var clipboard = new FakeClipboard();
        var time = new FakeTimeProvider();
        using var guard = new ClipboardGuard(clipboard, time);
        var cleared = 0;
        guard.Cleared += (_, _) => cleared++;
        guard.Copy("R0uter!pass", sensitive: true);
        Assert.True(clipboard.LastSensitive);
        time.Advance(TimeSpan.FromSeconds(29));
        Assert.Equal("R0uter!pass", clipboard.Text);
        time.Advance(TimeSpan.FromSeconds(1));
        Assert.Null(clipboard.Text);
        Assert.Equal(1, cleared);
    }

    [Fact]
    public void Leaves_whatever_the_person_copied_since()
    {
        var clipboard = new FakeClipboard();
        var time = new FakeTimeProvider();
        using var guard = new ClipboardGuard(clipboard, time);
        guard.Copy("R0uter!pass", sensitive: true);
        clipboard.Text = "a ticket number";
        time.Advance(ClipboardGuard.ClearAfter);
        Assert.Equal("a ticket number", clipboard.Text);
    }

    [Fact]
    public void Never_clears_ordinary_text_and_restarts_the_timer_on_each_copy()
    {
        var clipboard = new FakeClipboard();
        var time = new FakeTimeProvider();
        using var guard = new ClipboardGuard(clipboard, time);
        guard.Copy("admin", sensitive: false);
        time.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal("admin", clipboard.Text);

        guard.Copy("first", sensitive: true);
        time.Advance(TimeSpan.FromSeconds(20));
        guard.Copy("second", sensitive: true);
        time.Advance(TimeSpan.FromSeconds(20));
        Assert.Equal("second", clipboard.Text);
        time.Advance(TimeSpan.FromSeconds(10));
        Assert.Null(clipboard.Text);
    }
}
