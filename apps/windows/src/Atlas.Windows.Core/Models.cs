using System.Text.Json.Serialization;

namespace Atlas.Windows.Core;

public sealed record SignedInUser(string Name, string Email);

public sealed record TokenResponse(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("scope")] string Scope,
    [property: JsonPropertyName("expires_in")] long ExpiresIn,
    [property: JsonPropertyName("session_id")] string SessionId,
    [property: JsonPropertyName("user")] SignedInUser User);

/// <summary>Who the app is signed in as. <c>App</c> is missing from an Atlas older than this app's update notice.</summary>
public sealed record AppSessionInfo(
    SignedInUser User,
    OrganizationInfo Organization,
    string DeviceName,
    string[] Scopes,
    AppRelease? App = null)
{
    public bool CanReveal => Scopes.Contains("reveal");

    /// <summary>Whether this sign-in may change things. Sign-ins from before the app could edit may only read.</summary>
    public bool CanWrite => Scopes.Contains("write");
}

/// <summary>The version of this app that Atlas offers, and where its setup program is.</summary>
public sealed record AppRelease(string LatestVersion, string DownloadUrl)
{
    /// <summary>Where to get it, or null unless it's an https address: the app only ever opens a secure link.</summary>
    public Uri? DownloadLink =>
        Uri.TryCreate(DownloadUrl, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps ? uri : null;
}

public sealed record OrganizationInfo(string Id, string Name);

/// <summary>One quick-search hit: a client, asset, document, password entry, contact, or location.</summary>
public sealed record SearchResult(
    string Type,
    string Id,
    string Title,
    string Subtitle,
    string? ClientId,
    string? ClientName,
    string Snippet)
{
    public bool IsPassword => Type == "password";
}

/// <summary>A password entry without its secrets.</summary>
public sealed record PasswordEntry(
    string Id,
    string ClientId,
    string ClientName,
    string Name,
    string Username,
    string Url,
    bool HasTotp,
    bool RequireReason,
    string UpdatedAt);

public sealed record RevealResult(string Value, int? ExpiresIn);

public sealed record ExpirationItem(string Kind, string Id, string Title, string Label, string? ClientName, string Date, int DaysLeft);

/// <summary>Which secret to copy.</summary>
public enum SecretField
{
    Password,
    OneTimeCode,
}

// ---------- browsing ----------
// What the desktop app lists in its three columns. None of these carry a secret: passwords and one-time codes are
// only ever fetched to copy or briefly show, through RevealAsync, which Atlas records.

public sealed record ClientSummary(string Id, string Name, string Type, string Status);

/// <summary>A password entry as listed, without its secret.</summary>
public sealed record PasswordSummary(
    string Id,
    string ClientId,
    string ClientName,
    string Kind,
    string Name,
    string Username,
    string Url,
    bool HasTotp,
    bool HasNotes,
    bool RequireReason,
    bool CanReveal,
    bool Restricted,
    string UpdatedAt,
    string? UpdatedByName = null);

public sealed record LayoutField(string Key, string Label, string Type);

public sealed record LayoutInfo(string Id, string Name, string Icon, LayoutField[] Fields);

public sealed record AssetSummary(
    string Id,
    string ClientId,
    string ClientName,
    string LayoutId,
    string LayoutName,
    string Name,
    string Status,
    Dictionary<string, System.Text.Json.JsonElement> Fields,
    string Notes,
    string UpdatedAt,
    string? UpdatedByName = null);

public sealed record DocumentSummary(
    string Id,
    string? ClientId,
    string? ClientName,
    string Title,
    string Status,
    string UpdatedAt,
    string? UpdatedByName = null);

public sealed record DocumentDetail(
    string Id,
    string? ClientId,
    string? ClientName,
    string Title,
    string Status,
    string UpdatedAt,
    System.Text.Json.JsonElement Content,
    string? UpdatedByName = null);

public sealed record FavoriteState(bool Favorite);

/// <summary>A client in full: its quick note (with the version it was saved as), hours, and your access.</summary>
public sealed record ClientDetail(
    string Id,
    string Name,
    string Type,
    string Status,
    string Notes,
    int NotesVersion,
    string? NotesUpdatedAt,
    string? NotesUpdatedByName,
    string Hours,
    string MaintenanceWindow,
    bool RequireRevealReason,
    string Access)
{
    /// <summary>Whether the person may change this client's documentation.</summary>
    public bool CanEdit => Access is "edit" or "edit_passwords";
}

public sealed record ContactInfo(string Id, string ClientId, string Name, string Title, string Email, string Phone, string Mobile, string Notes, bool Primary);

public sealed record LocationInfo(
    string Id,
    string ClientId,
    string Name,
    string Address,
    string City,
    string Region,
    string PostalCode,
    string Country,
    string Phone,
    string Notes,
    bool Primary)
{
    public string OneLine => string.Join(", ", new[] { Address, City, Region, PostalCode }.Where(p => !string.IsNullOrWhiteSpace(p)));
}

/// <summary>Something the person starred in Atlas.</summary>
public sealed record FavoriteItem(string Type, string Id, string Name, string? ClientId, string? ClientName);
