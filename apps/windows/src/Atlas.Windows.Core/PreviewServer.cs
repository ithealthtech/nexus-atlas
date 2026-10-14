using System.Net;
using System.Text;
using System.Text.Json;

namespace Atlas.Windows.Core;

/// <summary>
/// A stand-in Atlas with made-up clients, for `--preview`: the build starts the app against it to take screenshots,
/// so the window can be checked without a server. It never touches the network, and has nothing real in it.
/// </summary>
public sealed class PreviewServer : HttpMessageHandler
{
    public static readonly AtlasAddress Address = AtlasAddress.Parse("https://atlas.preview.invalid");
    public const string Token = "preview";

    private const string Harbor = "c-harbor";
    private const string Northline = "c-northline";
    private const string Cedar = "c-cedar";
    private static readonly string Now = DateTime.UtcNow.AddHours(-3).ToString("O");

    private static readonly object[] Clients =
    [
        new { id = Cedar, name = "Cedar Ridge Credit Union", type = "Customer", status = "active" },
        new { id = Harbor, name = "Harbor Dental Group", type = "Customer", status = "active" },
        new { id = Northline, name = "Northline Architecture", type = "Customer", status = "active" },
    ];

    private static object Pw(string id, string client, string clientName, string name, string user, string url, bool totp, string kind = "login", bool reason = false) =>
        new
        {
            id, clientId = client, clientName, kind, name, username = user, url, hasTotp = totp, hasNotes = false,
            requireReason = reason, canReveal = true, restricted = false, updatedAt = Now, updatedByName = "Alex Rivera",
        };

    private static readonly object[] Passwords =
    [
        Pw("p-m365", Harbor, "Harbor Dental Group", "Microsoft 365 global admin", "admin@harbordental.demo", "https://admin.microsoft.com", true),
        Pw("p-fw", Harbor, "Harbor Dental Group", "HDG-FW-01 admin", "admin", "https://10.20.0.1", false),
        Pw("p-wifi", Harbor, "Harbor Dental Group", "Front desk Wi-Fi", "HDG-Guest", "", false),
        Pw("p-core", Cedar, "Cedar Ridge Credit Union", "Core switch enable", "manager", "", false, reason: true),
        Pw("p-vpn", Cedar, "Cedar Ridge Credit Union", "Site-to-site VPN pre-shared key", "", "", false, reason: true),
        Pw("p-nas", Northline, "Northline Architecture", "NLA-NAS-01 admin", "nla-admin", "https://10.30.0.20:5001", true),
        Pw("p-autodesk", Northline, "Northline Architecture", "Autodesk account", "it@northlinearch.demo", "https://manage.autodesk.com", true),
    ];

    private static readonly object[] Layouts =
    [
        new
        {
            id = "l-config", name = "Configurations", icon = "server",
            fields = new object[]
            {
                new { key = "type", label = "Type", type = "select" },
                new { key = "hostname", label = "Hostname", type = "text" },
                new { key = "ip", label = "IP address", type = "ip" },
                new { key = "manufacturer", label = "Manufacturer", type = "text" },
                new { key = "model", label = "Model", type = "text" },
                new { key = "serial", label = "Serial number", type = "text" },
                new { key = "os", label = "Operating system", type = "text" },
                new { key = "warranty", label = "Warranty expires", type = "date" },
            },
        },
        new
        {
            id = "l-domain", name = "Domains", icon = "globe",
            fields = new object[]
            {
                new { key = "registrar", label = "Registrar", type = "text" },
                new { key = "expires", label = "Expires", type = "date" },
            },
        },
    ];

    private static object Asset(string id, string client, string clientName, string layout, string layoutName, string name, object fields) =>
        new { id, clientId = client, clientName, layoutId = layout, layoutName, name, status = "active", fields, notes = "", updatedAt = Now, updatedByName = "Alex Rivera" };

    private static readonly object[] Assets =
    [
        Asset("a-dc", Harbor, "Harbor Dental Group", "l-config", "Configurations", "HDG-DC-01",
            new { type = "Server", hostname = "hdg-dc-01.harbor.local", ip = "10.20.0.10", manufacturer = "Dell", model = "PowerEdge T350", serial = "7HX2K93", os = "Windows Server 2022", warranty = "2027-03-31" }),
        Asset("a-fw", Harbor, "Harbor Dental Group", "l-config", "Configurations", "HDG-FW-01",
            new { type = "Firewall", ip = "10.20.0.1", manufacturer = "Fortinet", model = "FortiGate 60F", serial = "FGT60FTK2209", os = "FortiOS 7.4.4" }),
        Asset("a-domain", Harbor, "Harbor Dental Group", "l-domain", "Domains", "harbordental.demo", new { registrar = "Cloudflare", expires = "2026-10-28" }),
        Asset("a-nas", Northline, "Northline Architecture", "l-config", "Configurations", "NLA-NAS-01",
            new { type = "Storage", ip = "10.30.0.20", manufacturer = "Synology", model = "RS1221+", serial = "2290QWR8N1", os = "DSM 7.2" }),
    ];

    private static readonly object[] Documents =
    [
        new { id = "d-reboot", clientId = Harbor, clientName = "Harbor Dental Group", title = "Firewall reboot procedure", status = "current", updatedAt = Now, updatedByName = "Alex Rivera" },
        new { id = "d-onboard", clientId = (string?)null, clientName = (string?)null, title = "New client onboarding checklist", status = "current", updatedAt = Now, updatedByName = "Alex Rivera" },
    ];

    private static readonly object RebootContent = new
    {
        type = "doc",
        content = new object[]
        {
            new { type = "paragraph", content = new object[] { new { type = "text", text = "Reboot outside practice hours (after 6 PM or Sunday). Dentrix runs on HDG-DC-01 and needs the firewall for its cloud backup." } } },
            new { type = "heading", content = new object[] { new { type = "text", text = "Before you start" } } },
            new
            {
                type = "taskList",
                content = new object[]
                {
                    new { type = "taskItem", attrs = new { @checked = false }, content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "Tell the office manager (Dana Morales)" } } } } },
                    new { type = "taskItem", attrs = new { @checked = false }, content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "Confirm last night's backup succeeded" } } } } },
                },
            },
            new { type = "heading", content = new object[] { new { type = "text", text = "Steps" } } },
            new
            {
                type = "orderedList",
                content = new object[]
                {
                    new { type = "listItem", content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "Sign in to the FortiGate at https://10.20.0.1 with HDG-FW-01 admin." } } } } },
                    new { type = "listItem", content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "System → Settings → Reboot. It takes about three minutes." } } } } },
                    new { type = "listItem", content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "Check the site-to-site VPN and Dentrix cloud sync come back." } } } } },
                },
            },
        },
    };

    private static readonly object[] Favorites =
    [
        new { type = "password", id = "p-m365", name = "Microsoft 365 global admin", clientId = Harbor, clientName = "Harbor Dental Group" },
        new { type = "asset", id = "a-dc", name = "HDG-DC-01", clientId = Harbor, clientName = "Harbor Dental Group" },
        new { type = "password", id = "p-core", name = "Core switch enable", clientId = Cedar, clientName = "Cedar Ridge Credit Union" },
        new { type = "document", id = "d-reboot", name = "Firewall reboot procedure", clientId = Harbor, clientName = "Harbor Dental Group" },
    ];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await Task.Delay(60, cancellationToken).ConfigureAwait(false);
        var path = request.RequestUri!.AbsolutePath;
        var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);
        var client = query["client"];
        var tail = path[(path.IndexOf("/api/v1/", StringComparison.Ordinal) + 8)..];
        object? body = tail switch
        {
            "native/session" => Session(),
            "clients" => Clients,
            "passwords" => Filter(Passwords, client),
            "assets" => Filter(Assets, client),
            "documents" => Filter(Documents, client),
            "layouts" => Layouts,
            "favorites" => Favorites,
            "expirations" => Array.Empty<object>(),
            "search" => Search(query["q"] ?? ""),
            _ when tail.StartsWith("passwords/", StringComparison.Ordinal) && tail.EndsWith("/reveal", StringComparison.Ordinal) =>
                (await request.Content!.ReadAsStringAsync(cancellationToken).ConfigureAwait(false)).Contains("\"totp\"")
                    ? new { value = "482193", expiresIn = (int?)18 }
                    : new { value = "c7Hq-29Lm-Vx4r-Np8e", expiresIn = (int?)null },
            _ when tail.StartsWith("passwords/", StringComparison.Ordinal) => Find(Passwords, tail[10..]),
            _ when tail.StartsWith("assets/", StringComparison.Ordinal) => Find(Assets, tail[7..]),
            _ when tail.StartsWith("documents/", StringComparison.Ordinal) => DocumentFor(tail[10..]),
            _ => null,
        };
        if (body is null)
            return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = Json(new { error = "Not in the preview." }) };
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(body) };
    }

    private static object Session() => new
    {
        user = new { name = "Alex Rivera", email = "alex@itdoneright.demo" },
        organization = new { id = "o-1", name = "IT Done Right" },
        deviceName = Environment.MachineName,
        scopes = new[] { "read", "reveal" },
    };

    private static object[] Filter(object[] items, string? client) =>
        client is null ? items : items.Where(i => Prop(i, "clientId") == client).ToArray();

    private static object? Find(object[] items, string id) => items.FirstOrDefault(i => Prop(i, "id") == id);

    private static Dictionary<string, object?>? DocumentFor(string id)
    {
        var doc = Find(Documents, id);
        if (doc is null)
            return null;
        var element = JsonSerializer.SerializeToElement(doc);
        var copy = JsonSerializer.Deserialize<Dictionary<string, object?>>(element.GetRawText())!;
        copy["content"] = id == "d-reboot" ? RebootContent : new { type = "doc", content = Array.Empty<object>() };
        return copy;
    }

    private static object[] Search(string q) =>
        Passwords.Concat(Assets).Concat(Documents)
            .Where(i => (Prop(i, "name") ?? Prop(i, "title") ?? "").Contains(q, StringComparison.OrdinalIgnoreCase))
            .Select(i => new
            {
                type = Prop(i, "kind") is not null ? "password" : Prop(i, "layoutId") is not null ? "asset" : "document",
                id = Prop(i, "id"),
                title = Prop(i, "name") ?? Prop(i, "title"),
                subtitle = Prop(i, "clientName") ?? "Knowledge base",
                clientId = Prop(i, "clientId"),
                clientName = Prop(i, "clientName"),
                snippet = "",
            })
            .ToArray<object>();

    private static string? Prop(object item, string name) =>
        item.GetType().GetProperty(name)?.GetValue(item) as string;

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static StringContent Json(object body) => new(JsonSerializer.Serialize(body, Web), Encoding.UTF8, "application/json");
}
