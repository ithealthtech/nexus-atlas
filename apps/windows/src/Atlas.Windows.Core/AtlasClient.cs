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
    // "write" lets the app change what the person may change in the browser; Atlas checks each change as it would there.
    public const string RequestedScopes = "read write reveal";
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
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("AtlasForWindows", AppInfo.VersionText));
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

    // ---------- browsing ----------
    private static string ForClient(string? clientId) => clientId is null ? "" : $"?client={Uri.EscapeDataString(clientId)}";

    private static string Archived(string? clientId) => "?archived=true" + (clientId is null ? "" : $"&client={Uri.EscapeDataString(clientId)}");

    // ---------- archived items ----------
    public Task<IReadOnlyList<PasswordSummary>> ListArchivedPasswordsAsync(string? clientId = null, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<PasswordSummary>>(HttpMethod.Get, "passwords" + Archived(clientId), null, cancellationToken);

    public Task<IReadOnlyList<AssetSummary>> ListArchivedAssetsAsync(string? clientId = null, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<AssetSummary>>(HttpMethod.Get, "assets" + Archived(clientId), null, cancellationToken);

    public Task<IReadOnlyList<DocumentSummary>> ListArchivedDocumentsAsync(string? clientId = null, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<DocumentSummary>>(HttpMethod.Get, "documents" + Archived(clientId), null, cancellationToken);

    // ---------- history, related items, and files ----------
    /// <summary>Earlier versions of a password, newest first.</summary>
    public Task<IReadOnlyList<PasswordVersion>> ListPasswordHistoryAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<PasswordVersion>>(HttpMethod.Get, $"passwords/{Uri.EscapeDataString(id)}/history", null, cancellationToken);

    /// <summary>Reveals an earlier version of a password. Atlas records it like any reveal and may ask for a reason.</summary>
    public Task<RevealResult> RevealOldPasswordAsync(string id, string versionId, string reason = "", CancellationToken cancellationToken = default) =>
        SendAsync<RevealResult>(
            HttpMethod.Post,
            $"passwords/{Uri.EscapeDataString(id)}/history/{Uri.EscapeDataString(versionId)}/reveal",
            new { reason },
            cancellationToken);

    /// <summary>Items linked to this one (type: password, asset, or document).</summary>
    public Task<IReadOnlyList<RelatedItem>> ListRelatedAsync(string type, string id, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<RelatedItem>>(HttpMethod.Get, $"items/{Uri.EscapeDataString(type)}/{Uri.EscapeDataString(id)}/relations", null, cancellationToken);

    /// <summary>Files attached to a password, asset, or document.</summary>
    public Task<IReadOnlyList<AttachmentInfo>> ListAttachmentsAsync(string type, string id, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<AttachmentInfo>>(
            HttpMethod.Get,
            type == "password" ? $"passwords/{Uri.EscapeDataString(id)}/attachments" : $"items/{Uri.EscapeDataString(type)}/{Uri.EscapeDataString(id)}/attachments",
            null,
            cancellationToken);

    /// <summary>
    /// A file's contents. A password's files are recorded like a reveal (and may need a reason); other items' files
    /// are read like the item.
    /// </summary>
    public Task<byte[]> DownloadAttachmentAsync(string type, string itemId, string attachmentId, string reason = "", CancellationToken cancellationToken = default) =>
        type == "password"
            ? SendBytesAsync(HttpMethod.Post, $"passwords/{Uri.EscapeDataString(itemId)}/attachments/{Uri.EscapeDataString(attachmentId)}/download", new { reason }, cancellationToken)
            : SendBytesAsync(HttpMethod.Get, $"attachments/{Uri.EscapeDataString(attachmentId)}/content", null, cancellationToken);

    public Task<IReadOnlyList<ClientSummary>> ListClientsAsync(CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<ClientSummary>>(HttpMethod.Get, "clients", null, cancellationToken);

    /// <summary>The password entries the person can open, for one client or all of them. Never their secrets.</summary>
    public Task<IReadOnlyList<PasswordSummary>> ListPasswordsAsync(string? clientId = null, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<PasswordSummary>>(HttpMethod.Get, "passwords" + ForClient(clientId), null, cancellationToken);

    public Task<IReadOnlyList<AssetSummary>> ListAssetsAsync(string? clientId = null, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<AssetSummary>>(HttpMethod.Get, "assets" + ForClient(clientId), null, cancellationToken);

    public Task<AssetSummary> GetAssetAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<AssetSummary>(HttpMethod.Get, $"assets/{Uri.EscapeDataString(id)}", null, cancellationToken);

    public Task<IReadOnlyList<LayoutInfo>> ListLayoutsAsync(CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<LayoutInfo>>(HttpMethod.Get, "layouts", null, cancellationToken);

    public Task<IReadOnlyList<DocumentSummary>> ListDocumentsAsync(string? clientId = null, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<DocumentSummary>>(HttpMethod.Get, "documents" + ForClient(clientId), null, cancellationToken);

    public Task<DocumentDetail> GetDocumentAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<DocumentDetail>(HttpMethod.Get, $"documents/{Uri.EscapeDataString(id)}", null, cancellationToken);

    /// <summary>What the person starred in Atlas.</summary>
    public Task<IReadOnlyList<FavoriteItem>> ListFavoritesAsync(CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<FavoriteItem>>(HttpMethod.Get, "favorites", null, cancellationToken);

    public Task<ClientDetail> GetClientAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<ClientDetail>(HttpMethod.Get, $"clients/{Uri.EscapeDataString(id)}", null, cancellationToken);

    public Task<IReadOnlyList<ContactInfo>> ListContactsAsync(string clientId, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<ContactInfo>>(HttpMethod.Get, $"clients/{Uri.EscapeDataString(clientId)}/contacts", null, cancellationToken);

    public Task<IReadOnlyList<LocationInfo>> ListLocationsAsync(string clientId, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<LocationInfo>>(HttpMethod.Get, $"clients/{Uri.EscapeDataString(clientId)}/locations", null, cancellationToken);

    /// <summary>
    /// Saves a client's quick note. The version it was edited from goes with it: if someone saved since, Atlas
    /// refuses (409) rather than overwrite their words.
    /// </summary>
    public Task<ClientDetail> SaveQuickNoteAsync(string clientId, string notes, int version, CancellationToken cancellationToken = default) =>
        SendAsync<ClientDetail>(HttpMethod.Patch, $"clients/{Uri.EscapeDataString(clientId)}", new { notes, notesVersion = version }, cancellationToken);

    public Task<IReadOnlyList<PasswordFolder>> ListPasswordFoldersAsync(string clientId, CancellationToken cancellationToken = default) =>
        SendAsync<IReadOnlyList<PasswordFolder>>(HttpMethod.Get, $"clients/{Uri.EscapeDataString(clientId)}/password-folders", null, cancellationToken);

    /// <summary>Adds a login to a client's vault. Atlas records who added it, with this app named.</summary>
    public Task<PasswordEntry> CreatePasswordAsync(string clientId, PasswordDraft draft, CancellationToken cancellationToken = default) =>
        SendAsync<PasswordEntry>(
            HttpMethod.Post,
            $"clients/{Uri.EscapeDataString(clientId)}/passwords",
            new
            {
                kind = "login",
                name = draft.Name,
                username = draft.Username,
                url = draft.Url,
                secret = draft.Secret ?? "",
                totp = draft.Totp ?? "",
                notes = draft.Notes ?? "",
                rotationDays = draft.RotationDays,
                folderId = draft.FolderId,
            },
            cancellationToken);

    /// <summary>
    /// Changes a password entry. The version it was opened at goes with it: if someone saved since, Atlas refuses
    /// (409) rather than overwrite them. The old password moves to the entry's history.
    /// </summary>
    public Task<PasswordEntry> UpdatePasswordAsync(string id, int version, PasswordDraft draft, CancellationToken cancellationToken = default)
    {
        var changes = new Dictionary<string, object?>
        {
            ["version"] = version,
            ["name"] = draft.Name,
            ["username"] = draft.Username,
            ["url"] = draft.Url,
            ["rotationDays"] = draft.RotationDays,
            ["folderId"] = draft.FolderId,
        };
        if (!string.IsNullOrEmpty(draft.Secret))
            changes["secret"] = draft.Secret;
        if (draft.Totp is not null)
            changes["totp"] = draft.Totp;
        if (draft.Notes is not null)
            changes["notes"] = draft.Notes;
        return SendAsync<PasswordEntry>(HttpMethod.Patch, $"passwords/{Uri.EscapeDataString(id)}", changes, cancellationToken);
    }

    /// <summary>Archives an entry (or restores it). Archived entries leave lists but can be restored in Atlas.</summary>
    public Task<PasswordEntry> ArchivePasswordAsync(string id, bool archived = true, CancellationToken cancellationToken = default) =>
        SendAsync<PasswordEntry>(HttpMethod.Post, $"passwords/{Uri.EscapeDataString(id)}/archive", new { archived }, cancellationToken);

    /// <summary>Adds an asset to a client, in one of the layouts. Atlas checks each field against the layout.</summary>
    public Task<AssetSummary> CreateAssetAsync(
        string clientId,
        string layoutId,
        string name,
        string status,
        IReadOnlyDictionary<string, object?> fields,
        string notes,
        CancellationToken cancellationToken = default) =>
        SendAsync<AssetSummary>(
            HttpMethod.Post,
            $"clients/{Uri.EscapeDataString(clientId)}/assets",
            new { layoutId, name, status, fields, notes },
            cancellationToken);

    /// <summary>Changes an asset, refused (409) if someone saved it since the version it was opened at.</summary>
    public Task<AssetSummary> UpdateAssetAsync(
        string id,
        int version,
        string name,
        string status,
        IReadOnlyDictionary<string, object?> fields,
        string notes,
        CancellationToken cancellationToken = default) =>
        SendAsync<AssetSummary>(
            HttpMethod.Patch,
            $"assets/{Uri.EscapeDataString(id)}",
            new { version, name, status, fields, notes },
            cancellationToken);

    public Task<AssetSummary> ArchiveAssetAsync(string id, bool archived = true, CancellationToken cancellationToken = default) =>
        SendAsync<AssetSummary>(HttpMethod.Post, $"assets/{Uri.EscapeDataString(id)}/archive", new { archived }, cancellationToken);

    // ---------- documents ----------
    /// <summary>Adds a document, for a client or (with no client) in the knowledge base.</summary>
    public Task<DocumentDetail> CreateDocumentAsync(
        string? clientId,
        string title,
        string status,
        System.Text.Json.Nodes.JsonObject content,
        CancellationToken cancellationToken = default) =>
        SendAsync<DocumentDetail>(HttpMethod.Post, "documents", new { clientId, title, status, content }, cancellationToken);

    /// <summary>
    /// Changes a document saved as <paramref name="version"/>. Leave <paramref name="content"/> null to keep the body;
    /// a 409 means someone saved it meanwhile.
    /// </summary>
    public Task<DocumentDetail> UpdateDocumentAsync(
        string id,
        int version,
        string title,
        string status,
        System.Text.Json.Nodes.JsonObject? content,
        CancellationToken cancellationToken = default)
    {
        var changes = new Dictionary<string, object> { ["version"] = version, ["title"] = title, ["status"] = status };
        if (content is not null)
            changes["content"] = content;
        return SendAsync<DocumentDetail>(HttpMethod.Patch, $"documents/{Uri.EscapeDataString(id)}", changes, cancellationToken);
    }

    public Task<JsonElement> ArchiveDocumentAsync(string id, bool archived = true, CancellationToken cancellationToken = default) =>
        SendAsync<JsonElement>(HttpMethod.Post, $"documents/{Uri.EscapeDataString(id)}/archive", new { archived }, cancellationToken);

    // ---------- contacts and locations ----------
    public Task<ContactInfo> CreateContactAsync(string clientId, ContactDraft draft, CancellationToken cancellationToken = default) =>
        SendAsync<ContactInfo>(HttpMethod.Post, $"clients/{Uri.EscapeDataString(clientId)}/contacts", draft, cancellationToken);

    public Task<ContactInfo> UpdateContactAsync(string id, ContactDraft draft, CancellationToken cancellationToken = default) =>
        SendAsync<ContactInfo>(HttpMethod.Patch, $"contacts/{Uri.EscapeDataString(id)}", draft, cancellationToken);

    public Task DeleteContactAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<JsonElement>(HttpMethod.Delete, $"contacts/{Uri.EscapeDataString(id)}", null, cancellationToken);

    public Task<LocationInfo> CreateLocationAsync(string clientId, LocationDraft draft, CancellationToken cancellationToken = default) =>
        SendAsync<LocationInfo>(HttpMethod.Post, $"clients/{Uri.EscapeDataString(clientId)}/locations", draft, cancellationToken);

    public Task<LocationInfo> UpdateLocationAsync(string id, LocationDraft draft, CancellationToken cancellationToken = default) =>
        SendAsync<LocationInfo>(HttpMethod.Patch, $"locations/{Uri.EscapeDataString(id)}", draft, cancellationToken);

    public Task DeleteLocationAsync(string id, CancellationToken cancellationToken = default) =>
        SendAsync<JsonElement>(HttpMethod.Delete, $"locations/{Uri.EscapeDataString(id)}", null, cancellationToken);

    /// <summary>Stars or unstars a client, asset, document, or password: the person's own bookmark in Atlas.</summary>
    public Task<FavoriteState> SetFavoriteAsync(string kind, string id, bool favorite, CancellationToken cancellationToken = default)
    {
        var escaped = Uri.EscapeDataString(id);
        var path = kind == "password" ? $"passwords/{escaped}/favorite" : $"favorites/{Uri.EscapeDataString(kind)}/{escaped}";
        return SendAsync<FavoriteState>(favorite ? HttpMethod.Put : HttpMethod.Delete, path, null, cancellationToken);
    }

    /// <summary>
    /// Reads a password or the current one-time code to show it on screen for a moment. Recorded in the password's
    /// access history like a reveal in the browser.
    /// </summary>
    public Task<RevealResult> RevealToShowAsync(string id, SecretField field, string reason = "", CancellationToken cancellationToken = default) =>
        SendAsync<RevealResult>(
            HttpMethod.Post,
            $"passwords/{Uri.EscapeDataString(id)}/reveal",
            new { field = field == SecretField.OneTimeCode ? "totp" : "secret", copy = false, reason },
            cancellationToken);

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

    private async Task<byte[]> SendBytesAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
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
        if (!response.IsSuccessStatusCode)
        {
            var error = await ReadErrorAsync(response, cancellationToken).ConfigureAwait(false);
            throw new AtlasApiException(response.StatusCode, error.Message ?? $"Atlas answered {(int)response.StatusCode}.", error.Code);
        }
        return await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
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
