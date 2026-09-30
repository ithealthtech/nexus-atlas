using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Atlas.Windows.Core;

/// <summary>An Atlas refusal, with the server's message (already written for people).</summary>
public class AtlasApiException(HttpStatusCode status, string message, string? code) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
    public string? Code { get; } = code;
}

/// <summary>The app session ended (signed out from the Account page, revoked by an administrator, or expired).</summary>
public sealed class SessionEndedException(string message) : AtlasApiException(HttpStatusCode.Unauthorized, message, "session");

/// <summary>
/// The Atlas REST API (/api/v1) as the signed-in person. Atlas decides what they may see and records what they do;
/// the app never has more access than the person has in the browser, and never touches the database.
/// </summary>
public sealed class AtlasClient : IDisposable
{
    public const string ClientId = "atlas-windows";
    public const string RequestedScopes = "read reveal";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient http;
    private string? token;

    /// <param name="handler">Tests pass a fake server. The default handler uses the Windows certificate store, and
    /// there is intentionally no option to skip certificate checks.</param>
    public AtlasClient(AtlasAddress address, HttpMessageHandler? handler = null)
    {
        Address = address;
        http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: true);
        http.BaseAddress = address.Api;
        http.Timeout = TimeSpan.FromSeconds(30);
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("AtlasForWindows", "0.1"));
    }

    public AtlasAddress Address { get; }

    public bool SignedIn => token is not null;

    /// <summary>Uses a session token from secure storage (or from a sign-in).</summary>
    public void UseToken(string? value) => token = string.IsNullOrEmpty(value) ? null : value;

    /// <summary>The browser address that starts sign-in.</summary>
    public Uri AuthorizeUri(Pkce pkce, string redirectUri, string deviceName)
    {
        var query = new Dictionary<string, string>
        {
            ["client_id"] = ClientId,
            ["redirect_uri"] = redirectUri,
            ["response_type"] = "code",
            ["code_challenge"] = pkce.Challenge,
            ["code_challenge_method"] = "S256",
            ["state"] = pkce.State,
            ["scope"] = RequestedScopes,
            ["device_name"] = deviceName,
        };
        var text = string.Join('&', query.Select(p => $"{p.Key}={Uri.EscapeDataString(p.Value)}"));
        return new Uri(Address.Origin, $"native/authorize?{text}");
    }

    public async Task<TokenResponse> ExchangeCodeAsync(string code, string verifier, string redirectUri, CancellationToken cancellationToken = default)
    {
        using var response = await http.PostAsJsonAsync(
            "native/token",
            new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["client_id"] = ClientId,
                ["code"] = code,
                ["redirect_uri"] = redirectUri,
                ["code_verifier"] = verifier,
            },
            Json,
            cancellationToken).ConfigureAwait(false);
        var result = await ReadAsync<TokenResponse>(response, cancellationToken).ConfigureAwait(false);
        token = result.AccessToken;
        return result;
    }

    public Task<AppSessionInfo> GetSessionAsync(CancellationToken cancellationToken = default) =>
        SendAsync<AppSessionInfo>(HttpMethod.Get, "native/session", null, cancellationToken);

    /// <summary>Ends this app session on the server. The token is forgotten either way.</summary>
    public async Task SignOutAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            if (token is not null)
                await SendAsync<JsonElement>(HttpMethod.Delete, "native/session", null, cancellationToken).ConfigureAwait(false);
        }
        catch (SessionEndedException)
        {
            // Already signed out on the server.
        }
        finally
        {
            token = null;
        }
    }

    /// <summary>As-you-type search over what the person can see. Never returns secrets.</summary>
    public Task<IReadOnlyList<SearchResult>> SearchAsync(string query, int limit = 12, CancellationToken cancellationToken = default)
    {
        var q = query.Trim();
        if (q.Length == 0)
            return Task.FromResult<IReadOnlyList<SearchResult>>([]);
        return SendAsync<IReadOnlyList<SearchResult>>(
            HttpMethod.Get,
            $"search?q={Uri.EscapeDataString(q)}&limit={Math.Clamp(limit, 1, 50)}",
            null,
            cancellationToken);
    }

    public Task<PasswordEntry> GetPasswordAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<PasswordEntry>(HttpMethod.Get, $"passwords/{Uri.EscapeDataString(id)}", null, cancellationToken);

    /// <summary>
    /// Reads a password or the current one-time code in order to copy it. Atlas checks access and required reasons
    /// and records it in the password's access history, exactly like the browser's copy button.
    /// </summary>
    public Task<RevealResult> RevealForCopyAsync(string id, SecretField field, string reason = "", CancellationToken cancellationToken = default) =>
        SendAsync<RevealResult>(
            HttpMethod.Post,
            $"passwords/{Uri.EscapeDataString(id)}/reveal",
            new { field = field == SecretField.OneTimeCode ? "totp" : "secret", copy = true, reason },
            cancellationToken);

    /// <summary>Things coming due (certificates, domains, warranties, password rotations) within the next days.</summary>
    public Task<IReadOnlyList<ExpirationItem>> GetExpirationsAsync(int days = 14, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<ExpirationItem>>(HttpMethod.Get, $"expirations?days={Math.Clamp(days, 1, 730)}", null, cancellationToken);

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        if (token is null)
            throw new SessionEndedException("Sign in to Atlas to continue.");
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null)
            request.Content = JsonContent.Create(body, options: Json);
        using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            token = null;
            throw new SessionEndedException(await ErrorMessageAsync(response, cancellationToken).ConfigureAwait(false) ?? "Sign in to Atlas again.");
        }
        return await ReadAsync<T>(response, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (!response.IsSuccessStatusCode)
        {
            var error = await ReadErrorAsync(response, cancellationToken).ConfigureAwait(false);
            throw new AtlasApiException(response.StatusCode, error.Message ?? $"Atlas answered {(int)response.StatusCode}.", error.Code);
        }
        return await response.Content.ReadFromJsonAsync<T>(Json, cancellationToken).ConfigureAwait(false)
            ?? throw new AtlasApiException(response.StatusCode, "Atlas sent an empty reply.", null);
    }

    private static async Task<string?> ErrorMessageAsync(HttpResponseMessage response, CancellationToken cancellationToken) =>
        (await ReadErrorAsync(response, cancellationToken).ConfigureAwait(false)).Message;

    private static async Task<(string? Message, string? Code)> ReadErrorAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(Json, cancellationToken).ConfigureAwait(false);
            return (
                body.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null,
                body.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null);
        }
        catch (Exception e) when (e is JsonException or NotSupportedException or HttpRequestException)
        {
            // Not Atlas's JSON (a proxy's error page, say).
            return (null, null);
        }
    }

    public void Dispose() => http.Dispose();
}
