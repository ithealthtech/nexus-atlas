namespace Atlas.Windows.Core;

/// <summary>
/// The Atlas server the app talks to. HTTPS is required; plain HTTP is accepted only for a server on this computer
/// (development). There is deliberately no way to accept an untrusted certificate: TLS uses the Windows trust chain.
/// </summary>
public sealed record AtlasAddress
{
    private AtlasAddress(Uri origin) => Origin = origin;

    /// <summary>Scheme, host, and port, with a trailing slash (for example https://atlas.example.com/).</summary>
    public Uri Origin { get; }

    /// <summary>The versioned REST API the app uses.</summary>
    public Uri Api => new(Origin, "api/v1/");

    public static bool TryParse(string? input, out AtlasAddress? address, out string error)
    {
        address = null;
        error = "";
        var text = (input ?? "").Trim();
        if (text.Length == 0)
        {
            error = "Enter your Atlas address, for example https://atlas.example.com.";
            return false;
        }
        if (!text.Contains("://", StringComparison.Ordinal))
            text = "https://" + text;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host))
        {
            error = "That isn't a web address.";
            return false;
        }
        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            error = "Leave the user name and password out of the address.";
            return false;
        }
        var loopback = uri.IsLoopback;
        if (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && loopback))
        {
            error = "Atlas must use https://.";
            return false;
        }
        address = new AtlasAddress(new Uri(uri.GetLeftPart(UriPartial.Authority) + "/"));
        return true;
    }

    public static AtlasAddress Parse(string input) =>
        TryParse(input, out var address, out var error) ? address! : throw new FormatException(error);

    /// <summary>The page in the web app for a search result, so "Open in browser" lands on the record.</summary>
    public Uri WebLink(string type, string id, string? clientId = null)
    {
        var escaped = Uri.EscapeDataString(id);
        var path = type switch
        {
            "client" => $"clients/{escaped}",
            "asset" => $"assets/{escaped}",
            "document" => $"documents/{escaped}",
            "password" => $"passwords/{escaped}",
            "contact" when clientId is not null => $"clients/{Uri.EscapeDataString(clientId)}/contacts",
            "location" when clientId is not null => $"clients/{Uri.EscapeDataString(clientId)}/locations",
            _ => "",
        };
        return new Uri(Origin, path);
    }

    public override string ToString() => Origin.GetLeftPart(UriPartial.Authority);
}
