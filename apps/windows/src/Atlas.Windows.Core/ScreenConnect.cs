using System.Net;
using System.Text.RegularExpressions;

namespace Atlas.Windows.Core;

/// <summary>
/// The organization's ScreenConnect (set in Atlas under Import &amp; export), and the link Connect opens for a device:
/// its session, joined, when the asset records the session ID; otherwise the machine list searched for its name.
/// </summary>
public sealed partial record ScreenConnectInfo(string Url, string Group)
{
    /// <summary>Where Connect goes for this asset, or null unless ScreenConnect's address is a secure one.</summary>
    public Uri? LinkFor(AssetSummary asset, LayoutInfo? layout)
    {
        if (!Uri.TryCreate(Url, UriKind.Absolute, out var root) || root.Scheme != Uri.UriSchemeHttps)
            return null;
        var group = Uri.EscapeDataString(Group.Length > 0 ? Group : "All Machines");
        // ScreenConnect's host page reads #Access/<group>/<search>/<session>/<action>.
        var fragment = SessionIdOf(asset, layout) is { } session
            ? $"Access/{group}//{session}/Join"
            : $"Access/{group}/{Uri.EscapeDataString(NameToFind(asset, layout))}";
        return new Uri($"{root.GetLeftPart(UriPartial.Path).TrimEnd('/')}/Host#{fragment}");
    }

    /// <summary>
    /// The device's ScreenConnect session ID, from a field named for it (ScreenConnect, Control session, session ID)
    /// holding a session GUID on its own or inside a pasted ScreenConnect link.
    /// </summary>
    public static string? SessionIdOf(AssetSummary asset, LayoutInfo? layout)
    {
        foreach (var (key, value) in asset.Fields)
        {
            if (value.ValueKind != System.Text.Json.JsonValueKind.String)
                continue;
            var label = layout?.Fields.FirstOrDefault(f => f.Key == key)?.Label ?? "";
            if (!SessionField().IsMatch($"{key} {label}"))
                continue;
            if (Session().Match(value.GetString() ?? "") is { Success: true } found)
                return found.Value.ToLowerInvariant();
        }
        return null;
    }

    /// <summary>The name ScreenConnect knows the machine by: its host or computer name (without the domain), else the asset's name.</summary>
    public static string NameToFind(AssetSummary asset, LayoutInfo? layout)
    {
        foreach (var (key, value) in asset.Fields)
        {
            if (value.ValueKind != System.Text.Json.JsonValueKind.String || value.GetString() is not { Length: > 0 } text)
                continue;
            var label = layout?.Fields.FirstOrDefault(f => f.Key == key)?.Label ?? "";
            if (!HostField().IsMatch($"{key} {label}"))
                continue;
            text = text.Trim();
            return IPAddress.TryParse(text, out _) ? text : text.Split('.')[0];
        }
        return asset.Name;
    }

    [GeneratedRegex(@"screen.?connect|connectwise.?control|control.?session|session.?id", RegexOptions.IgnoreCase)]
    private static partial Regex SessionField();

    [GeneratedRegex(@"host.?name|computer.?name|device.?name|machine.?name|\bfqdn\b", RegexOptions.IgnoreCase)]
    private static partial Regex HostField();

    [GeneratedRegex(@"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOptions.IgnoreCase)]
    private static partial Regex Session();
}
