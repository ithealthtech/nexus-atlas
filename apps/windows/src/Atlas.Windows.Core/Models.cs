using System.Text.Json.Serialization;

namespace Atlas.Windows.Core;

public sealed record SignedInUser(string Name, string Email);

public sealed record TokenResponse(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("scope")] string Scope,
    [property: JsonPropertyName("expires_in")] long ExpiresIn,
    [property: JsonPropertyName("session_id")] string SessionId,
    [property: JsonPropertyName("user")] SignedInUser User);

public sealed record AppSessionInfo(SignedInUser User, OrganizationInfo Organization, string DeviceName, string[] Scopes)
{
    public bool CanReveal => Scopes.Contains("reveal");
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
