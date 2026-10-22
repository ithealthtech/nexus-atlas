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
    private const string Pine = "c-pine";
    private const string Cedar = "c-cedar";
    private static readonly string Now = DateTime.UtcNow.AddHours(-3).ToString("O");

    private static readonly object[] Clients =
    [
        new { id = Cedar, name = "Cedar Ridge Credit Union", type = "Customer", status = "active" },
        new { id = Harbor, name = "Harbor Dental Group", type = "Customer", status = "active" },
        new { id = Northline, name = "Northline Architecture", type = "Customer", status = "active" },
        new { id = Pine, name = "Pinecrest Veterinary", type = "Prospect", status = "prospect" },
    ];

    private static object Pw(
        string id,
        string client,
        string clientName,
        string name,
        string user,
        string url,
        bool totp,
        string kind = "login",
        bool reason = false,
        string category = "other",
        int strength = 4,
        int reused = 1,
        int? breaches = 0,
        string? folder = null) =>
        new
        {
            id, clientId = client, clientName, kind, name, username = user, url, hasTotp = totp, hasNotes = false,
            requireReason = reason, canReveal = true, restricted = false, updatedAt = Now, updatedByName = "Alex Rivera",
            version = 1, folderId = (string?)null, folderName = folder, rotationDays = (int?)null,
            category, strength, reused, breachCount = breaches, favorite = id == "p-m365",
        };

    private static readonly object[] Passwords =
    [
        Pw("p-m365", Harbor, "Harbor Dental Group", "Microsoft 365 global admin", "admin@harbordental.demo", "https://admin.microsoft.com", true, category: "cloud", folder: "Cloud admins"),
        Pw("p-fw", Harbor, "Harbor Dental Group", "HDG-FW-01 admin", "admin", "https://10.20.0.1", false, category: "network", strength: 3, folder: "Network"),
        Pw("p-wifi", Harbor, "Harbor Dental Group", "Front desk Wi-Fi", "HDG-Guest", "", false, category: "wifi", strength: 2, reused: 3),
        Pw("p-core", Cedar, "Cedar Ridge Credit Union", "Core switch enable", "manager", "", false, reason: true, category: "network", strength: 1, breaches: 2),
        Pw("p-vpn", Cedar, "Cedar Ridge Credit Union", "Site-to-site VPN pre-shared key", "", "", false, reason: true, category: "remote"),
        Pw("p-nas", Northline, "Northline Architecture", "NLA-NAS-01 admin", "nla-admin", "https://10.30.0.20:5001", true, category: "server", strength: 3),
        Pw("p-autodesk", Northline, "Northline Architecture", "Autodesk account", "it@northlinearch.demo", "https://manage.autodesk.com", true, category: "vendor"),
    ];

    private static readonly object[] Layouts =
    [
        new
        {
            id = "l-config", name = "Configurations", icon = "server",
            fields = new object[]
            {
                new { key = "type", label = "Type", type = "select", required = true, options = new[] { "Server", "Workstation", "Firewall", "Switch", "Storage" } },
                new { key = "hostname", label = "Hostname", type = "text" },
                new { key = "ip", label = "IP address", type = "ip" },
                new { key = "manufacturer", label = "Manufacturer", type = "text" },
                new { key = "model", label = "Model", type = "text" },
                new { key = "serial", label = "Serial number", type = "text" },
                new { key = "os", label = "Operating system", type = "text" },
                new { key = "warranty", label = "Warranty expires", type = "date" },
                new { key = "screenconnect", label = "ScreenConnect session", type = "text" },
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
        new { id, clientId = client, clientName, layoutId = layout, layoutName, name, status = "active", fields, notes = "", updatedAt = Now, updatedByName = "Alex Rivera", version = 1 };

    private static readonly object[] Assets =
    [
        Asset("a-dc", Harbor, "Harbor Dental Group", "l-config", "Configurations", "HDG-DC-01",
            new { type = "Server", hostname = "hdg-dc-01.harbor.local", ip = "10.20.0.10", manufacturer = "Dell", model = "PowerEdge T350", serial = "7HX2K93", os = "Windows Server 2022", warranty = "2027-03-31" }),
        Asset("a-fw", Harbor, "Harbor Dental Group", "l-config", "Configurations", "HDG-FW-01",
            new { type = "Firewall", ip = "10.20.0.1", manufacturer = "Fortinet", model = "FortiGate 60F", serial = "FGT60FTK2209", os = "FortiOS 7.4.4", screenconnect = "6f1c2a9e-4b7d-4e2a-9c31-0d5b8e7f4a12" }),
        Asset("a-domain", Harbor, "Harbor Dental Group", "l-domain", "Domains", "harbordental.demo", new { registrar = "Cloudflare", expires = "2026-10-28" }),
        Asset("a-nas", Northline, "Northline Architecture", "l-config", "Configurations", "NLA-NAS-01",
            new { type = "Storage", ip = "10.30.0.20", manufacturer = "Synology", model = "RS1221+", serial = "2290QWR8N1", os = "DSM 7.2" }),
    ];

    private static readonly object[] Documents =
    [
        new { id = "d-reboot", clientId = Harbor, clientName = "Harbor Dental Group", title = "Firewall reboot procedure", status = "current", updatedAt = Now, updatedByName = "Alex Rivera" },
        new { id = "d-onboard", clientId = (string?)null, clientName = (string?)null, title = "New client onboarding checklist", status = "needs_review", updatedAt = Now, updatedByName = "Sam Ortiz" },
    ];

    // Everything a document can hold, so the screenshots show each kind drawn.
    private static readonly object OnboardContent = new
    {
        type = "doc",
        content = new object[]
        {
            new { type = "paragraph", content = new object[] { new { type = "text", text = "Work through this in the first week. Anything that can't be done yet goes on the client's quick note." } } },
            new
            {
                type = "blockquote",
                content = new object[]
                {
                    new
                    {
                        type = "paragraph",
                        content = new object[]
                        {
                            new { type = "text", text = "Never", marks = new object[] { new { type = "bold" } } },
                            new { type = "text", text = " take admin passwords by email. Use a " },
                            new { type = "text", text = "one-time share link", marks = new object[] { new { type = "highlight" } } },
                            new { type = "hardBreak" },
                            new { type = "text", text = "and store them in Atlas the same day. See " },
                            new { type = "text", text = "the security policy", marks = new object[] { new { type = "link", attrs = new { href = "https://example.com/security-policy" } } } },
                            new { type = "text", text = "." },
                        },
                    },
                },
            },
            new { type = "heading", attrs = new { level = 2 }, content = new object[] { new { type = "text", text = "First visit" } } },
            new
            {
                type = "taskList",
                content = new object[]
                {
                    ChecklistItem(true, "Signed agreement and primary contact on file"),
                    ChecklistItem(true, "Admin credentials collected and stored in Atlas"),
                    ChecklistItem(false, "Network diagram drawn and attached"),
                    ChecklistItem(false, "Backups checked: last good restore test"),
                },
            },
            new { type = "heading", attrs = new { level = 2 }, content = new object[] { new { type = "text", text = "Agent install" } } },
            new
            {
                type = "paragraph",
                content = new object[]
                {
                    new { type = "text", text = "Run this on each server " },
                    new { type = "text", text = "as an administrator", marks = new object[] { new { type = "italic" } } },
                    new { type = "text", text = ", then check " },
                    new { type = "text", text = "Get-Service ITSPlatform", marks = new object[] { new { type = "code" } } },
                    new { type = "text", text = " says " },
                    new { type = "text", text = "Running", marks = new object[] { new { type = "bold" } } },
                    new { type = "text", text = ". The old agent's name was " },
                    new { type = "text", text = "LTService", marks = new object[] { new { type = "strike" } } },
                    new { type = "text", text = "." },
                },
            },
            new
            {
                type = "codeBlock",
                attrs = new { language = "powershell" },
                content = new object[] { new { type = "text", text = "msiexec /i AgentSetup.msi /qn TOKEN=$env:ATLAS_SITE_TOKEN\nGet-Service ITSPlatform | Select-Object Status, StartType" } },
            },
            new { type = "heading", attrs = new { level = 3 }, content = new object[] { new { type = "text", text = "Standard VLANs" } } },
            new
            {
                type = "table",
                content = new object[]
                {
                    new { type = "tableRow", content = new object[] { Cell("tableHeader", "VLAN"), Cell("tableHeader", "Subnet"), Cell("tableHeader", "Use") } },
                    new { type = "tableRow", content = new object[] { Cell("tableCell", "10"), Cell("tableCell", "10.x.0.0/24"), Cell("tableCell", "Servers and network gear") } },
                    new { type = "tableRow", content = new object[] { Cell("tableCell", "20"), Cell("tableCell", "10.x.20.0/24"), Cell("tableCell", "Staff computers and printers") } },
                    new { type = "tableRow", content = new object[] { Cell("tableCell", "30"), Cell("tableCell", "10.x.30.0/24"), Cell("tableCell", "Guest Wi-Fi, internet only") } },
                },
            },
            new { type = "horizontalRule" },
            new
            {
                type = "orderedList",
                attrs = new { start = 1 },
                content = new object[]
                {
                    new { type = "listItem", content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "Book the 30-day review." } } } } },
                    new
                    {
                        type = "listItem",
                        content = new object[]
                        {
                            new { type = "paragraph", content = new object[] { new { type = "text", text = "Send the welcome pack:" } } },
                            new
                            {
                                type = "bulletList",
                                content = new object[]
                                {
                                    new { type = "listItem", content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "How to reach the help desk" } } } } },
                                    new { type = "listItem", content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "What we monitor, and what we don't" } } } } },
                                },
                            },
                        },
                    },
                },
            },
        },
    };

    private static object ChecklistItem(bool done, string text) =>
        new { type = "taskItem", attrs = new { @checked = done }, content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text } } } } };

    private static object Cell(string type, string text) =>
        new { type, content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text } } } } };

    private static readonly object RebootContent = new
    {
        type = "doc",
        content = new object[]
        {
            new { type = "paragraph", content = new object[] { new { type = "text", text = "Reboot outside practice hours (after 6 PM or Sunday). Dentrix runs on HDG-DC-01 and needs the firewall for its cloud backup." } } },
            new { type = "heading", attrs = new { level = 2 }, content = new object[] { new { type = "text", text = "Before you start" } } },
            new
            {
                type = "taskList",
                content = new object[]
                {
                    new { type = "taskItem", attrs = new { @checked = false }, content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "Tell the office manager (Dana Morales)" } } } } },
                    new { type = "taskItem", attrs = new { @checked = false }, content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "Confirm last night's backup succeeded" } } } } },
                },
            },
            new { type = "heading", attrs = new { level = 2 }, content = new object[] { new { type = "text", text = "Steps" } } },
            new
            {
                type = "orderedList",
                attrs = new { start = 1 },
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

// The vault as you change it in the preview: the made-up entries to start with, then whatever is added or edited.
    private readonly List<Dictionary<string, object?>> passwords = [.. Passwords.Select(Mutable)];
    private readonly List<Dictionary<string, object?>> assets = [.. Assets.Select(Mutable)];
    private readonly List<Dictionary<string, object?>> people = [.. Contacts.Select(Mutable)];
    private readonly List<Dictionary<string, object?>> sites = [.. Locations.Select(Mutable)];
    private readonly List<Dictionary<string, object?>> docs = [.. Documents.Select(d => DocumentFor(Prop(d, "id")!)!)];

    private object[] Docs() => [.. docs.Where(d => !(d.TryGetValue("archived", out var a) && a is true)).Cast<object>()];

    // Adding, changing, and archiving documents in the preview.
    private async Task<HttpResponseMessage?> ChangeDocumentsAsync(HttpRequestMessage request, string tail, CancellationToken cancellationToken)
    {
        if (request.Method == HttpMethod.Get || !(tail == "documents" || tail.StartsWith("documents/", StringComparison.Ordinal)))
            return null;
        var raw = await request.Content!.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var body = JsonDocument.Parse(raw.Length > 0 ? raw : "{}").RootElement;
        static string Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        if (tail == "documents")
        {
            var clientId = body.TryGetProperty("clientId", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
            var entry = new Dictionary<string, object?>
            {
                ["id"] = $"d-new-{++added}",
                ["clientId"] = clientId,
                ["clientName"] = clientId is null ? null : Prop(Clients.First(x => Prop(x, "id") == clientId), "name"),
                ["title"] = Text(body, "title"),
                ["status"] = Text(body, "status"),
                ["updatedAt"] = DateTime.UtcNow.ToString("O"),
                ["updatedByName"] = "Alex Rivera",
                ["version"] = 1,
                ["canEdit"] = true,
                ["content"] = JsonSerializer.Deserialize<object>(body.GetProperty("content").GetRawText()),
            };
            docs.Add(entry);
            return new HttpResponseMessage(HttpStatusCode.Created) { Content = Json(entry) };
        }
        var one = System.Text.RegularExpressions.Regex.Match(tail, "^documents/([^/]+)(/archive)?$");
        var found = one.Success ? docs.FirstOrDefault(d => (string?)d["id"] == one.Groups[1].Value) : null;
        if (found is null)
            return null;
        if (one.Groups[2].Success)
        {
            found["archived"] = true;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(found) };
        }
        if (body.GetProperty("version").GetInt32() != (int)found["version"]!)
            return new HttpResponseMessage(HttpStatusCode.Conflict) { Content = Json(new { error = "Someone saved this document while you were editing it.", code = "conflict" }) };
        found["title"] = Text(body, "title");
        found["status"] = Text(body, "status");
        if (body.TryGetProperty("content", out var content))
            found["content"] = JsonSerializer.Deserialize<object>(content.GetRawText());
        found["version"] = (int)found["version"]! + 1;
        found["updatedAt"] = DateTime.UtcNow.ToString("O");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(found) };
    }

    // Adding, changing, and deleting contacts and locations in the preview.
    private async Task<HttpResponseMessage?> ChangePeopleAsync(HttpRequestMessage request, string tail, CancellationToken cancellationToken)
    {
        if (request.Method == HttpMethod.Get)
            return null;
        var adding = System.Text.RegularExpressions.Regex.Match(tail, "^clients/([^/]+)/(contacts|locations)$");
        var one = System.Text.RegularExpressions.Regex.Match(tail, "^(contacts|locations)/([^/]+)$");
        if (!adding.Success && !one.Success)
            return null;
        var kind = adding.Success ? adding.Groups[2].Value : one.Groups[1].Value;
        var list = kind == "contacts" ? people : sites;
        var raw = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var body = JsonDocument.Parse(raw.Length > 0 ? raw : "{}").RootElement;
        Dictionary<string, object?> entry;
        if (adding.Success)
        {
            entry = new Dictionary<string, object?> { ["id"] = $"{kind[..2]}-new-{++added}", ["clientId"] = adding.Groups[1].Value };
            list.Add(entry);
        }
        else
        {
            var found = list.FirstOrDefault(e => (string?)e["id"] == one.Groups[2].Value);
            if (found is null)
                return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = Json(new { error = "That isn't here any more." }) };
            if (request.Method == HttpMethod.Delete)
            {
                list.Remove(found);
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(new { ok = true }) };
            }
            entry = found;
        }
        foreach (var property in body.EnumerateObject())
            entry[property.Name] = property.Value.ValueKind switch
            {
                JsonValueKind.String => property.Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            };
        // Only one primary per client, as in Atlas.
        if (entry.TryGetValue("primary", out var primary) && primary is true)
            foreach (var other in list.Where(e => e != entry && (string?)e["clientId"] == (string?)entry["clientId"]))
                other["primary"] = false;
        return new HttpResponseMessage(adding.Success ? HttpStatusCode.Created : HttpStatusCode.OK) { Content = Json(entry) };
    }

    private object[] Things() => [.. assets.Cast<object>()];

    // Adding, changing, and archiving assets in the preview.
    private async Task<HttpResponseMessage?> ChangeAssetsAsync(HttpRequestMessage request, string tail, CancellationToken cancellationToken)
    {
        if (request.Method == HttpMethod.Get)
            return null;
        var adding = System.Text.RegularExpressions.Regex.Match(tail, "^clients/([^/]+)/assets$");
        var one = System.Text.RegularExpressions.Regex.Match(tail, "^assets/([^/]+)(/archive)?$");
        if (!adding.Success && !one.Success)
            return null;
        var raw = await request.Content!.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var body = JsonDocument.Parse(raw.Length > 0 ? raw : "{}").RootElement;
        static string Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        object? Fields() => body.TryGetProperty("fields", out var v) ? JsonSerializer.Deserialize<Dictionary<string, object?>>(v.GetRawText()) : null;
        if (adding.Success)
        {
            var clientId = adding.Groups[1].Value;
            var layoutId = Text(body, "layoutId");
            var layoutName = Prop(Layouts.First(l => Prop(l, "id") == layoutId), "name")!;
            var entry = Mutable(Asset($"a-new-{++added}", clientId, Prop(Clients.First(c => Prop(c, "id") == clientId), "name")!, layoutId, layoutName, Text(body, "name"), Fields() ?? new { }));
            entry["status"] = Text(body, "status");
            entry["notes"] = Text(body, "notes");
            assets.Add(entry);
            return new HttpResponseMessage(HttpStatusCode.Created) { Content = Json(entry) };
        }
        var found = assets.FirstOrDefault(a => (string?)a["id"] == one.Groups[1].Value);
        if (found is null)
            return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = Json(new { error = "That asset isn't here any more." }) };
        if (one.Groups[2].Success)
        {
            assets.Remove(found);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(found) };
        }
        if (body.GetProperty("version").GetInt32() != (int)found["version"]!)
            return new HttpResponseMessage(HttpStatusCode.Conflict) { Content = Json(new { error = "Someone saved this asset while you were editing it.", code = "conflict" }) };
        found["name"] = Text(body, "name");
        found["status"] = Text(body, "status");
        found["notes"] = Text(body, "notes");
        found["fields"] = Fields();
        found["version"] = (int)found["version"]! + 1;
        found["updatedAt"] = DateTime.UtcNow.ToString("O");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(found) };
    }
    private int added;

    private static Dictionary<string, object?> Mutable(object item) =>
        item.GetType().GetProperties().ToDictionary(p => p.Name, p => p.GetValue(item));

    private object[] Vault() => [.. passwords.Cast<object>()];

    private async Task<HttpResponseMessage?> ChangeVaultAsync(HttpRequestMessage request, string tail, CancellationToken cancellationToken)
    {
        var raw = request.Content is null ? "{}" : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        JsonElement Body() => JsonDocument.Parse(raw.Length > 0 ? raw : "{}").RootElement;
        static string Text(JsonElement body, string name) => body.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";

        var adding = System.Text.RegularExpressions.Regex.Match(tail, "^clients/([^/]+)/passwords$");
        if (request.Method == HttpMethod.Post && adding.Success)
        {
            var body = Body();
            var clientId = adding.Groups[1].Value;
            var entry = Mutable(Pw($"p-new-{++added}", clientId, Prop(Clients.First(c => Prop(c, "id") == clientId), "name")!,
                Text(body, "name"), Text(body, "username"), Text(body, "url"), Text(body, "totp").Length > 0));
            passwords.Add(entry);
            return new HttpResponseMessage(HttpStatusCode.Created) { Content = Json(entry) };
        }
        var one = System.Text.RegularExpressions.Regex.Match(tail, "^passwords/([^/]+)(/archive)?$");
        if (!one.Success || request.Method == HttpMethod.Get)
            return null;
        var found = passwords.FirstOrDefault(p => (string?)p["id"] == one.Groups[1].Value);
        if (found is null)
            return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = Json(new { error = "That password isn't here any more." }) };
        if (one.Groups[2].Success)
        {
            passwords.Remove(found);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(found) };
        }
        var change = Body();
        if (change.GetProperty("version").GetInt32() != (int)found["version"]!)
            return new HttpResponseMessage(HttpStatusCode.Conflict) { Content = Json(new { error = "Someone saved this password while you were editing it.", code = "conflict" }) };
        foreach (var field in new[] { "name", "username", "url" })
            if (change.TryGetProperty(field, out var value))
                found[field] = value.GetString();
        if (change.TryGetProperty("totp", out var totp))
            found["hasTotp"] = totp.GetString()!.Length > 0;
        found["version"] = (int)found["version"]! + 1;
        found["updatedAt"] = DateTime.UtcNow.ToString("O");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(found) };
    }

    // The quick notes, which the preview lets you edit: text and version, by client.
    private readonly Dictionary<string, (string Text, int Version)> notes = new()
    {
        [Harbor] = ("Three offices. Practice management runs on-prem (Dentrix): never reboot HDG-DC-01 before 6 PM.", 3),
        [Northline] = ("", 0),
        [Cedar] = ("Every password reveal needs a ticket number.", 1),
        [Pine] = ("Quote sent for managed backup and Microsoft 365.", 1),
    };

    // The client list carries each client's quick note, hours, and your access, as Atlas's does.
    private object[] ClientList() =>
    [
        .. Clients.Select(c =>
        {
            var detail = Mutable(ClientDetail(Prop(c, "id")!));
            detail["updatedAt"] = DateTime.UtcNow.AddDays(Prop(c, "id") == Harbor ? -1 : -9).ToString("O");
            return (object)detail;
        }),
    ];

    private static readonly object[] Expirations =
    [
        new { kind = "asset", id = "a-domain", title = "harbordental.demo", label = "Domain · Expires", clientId = Harbor, clientName = "Harbor Dental Group", date = "2026-10-28", daysLeft = 13 },
        new { kind = "password", id = "p-m365", title = "Microsoft 365 global admin", label = "Password rotation", clientId = Harbor, clientName = "Harbor Dental Group", date = "2026-10-20", daysLeft = 5 },
        new { kind = "password", id = "p-core", title = "Core switch enable", label = "Password rotation", clientId = Cedar, clientName = "Cedar Ridge Credit Union", date = "2026-10-11", daysLeft = -4 },
        new { kind = "asset", id = "a-dc", title = "HDG-DC-01", label = "Warranty expires", clientId = Harbor, clientName = "Harbor Dental Group", date = "2026-12-01", daysLeft = 47 },
        new { kind = "document", id = "d-reboot", title = "Firewall reboot procedure", label = "Review due", clientId = Harbor, clientName = "Harbor Dental Group", date = "2026-11-04", daysLeft = 20 },
    ];

    private object ClientDetail(string id)
    {
        var entry = Clients.First(c => Prop(c, "id") == id);
        var (name, type, status) = (Prop(entry, "name"), Prop(entry, "type"), Prop(entry, "status"));
        var (text, version) = notes[id];
        return new
        {
            id, name, type, status, notes = text, notesVersion = version,
            notesUpdatedAt = version > 0 ? Now : null, notesUpdatedByName = version > 0 ? "Alex Rivera" : null,
            hours = id == Harbor ? "Mon–Fri 7:30–5:00, Sat 8–12" : "Mon–Fri 8–5",
            maintenanceWindow = id == Harbor ? "Sundays 10 PM – 2 AM" : "",
            requireRevealReason = id == Cedar, access = "edit_passwords",
        };
    }

    private static readonly object[] Contacts =
    [
        new { id = "ct-dana", clientId = Harbor, name = "Dana Morales", title = "Office manager", email = "dana@harbordental.demo", phone = "(919) 555-0142", mobile = "", notes = "", primary = true },
        new { id = "ct-raj", clientId = Harbor, name = "Dr. Raj Patel", title = "Owner", email = "raj@harbordental.demo", phone = "", mobile = "(919) 555-0177", notes = "", primary = false },
        new { id = "ct-lee", clientId = Northline, name = "Morgan Lee", title = "Principal", email = "morgan@northlinearch.demo", phone = "(919) 555-0109", mobile = "", notes = "", primary = true },
    ];

    private static readonly object[] Locations =
    [
        new { id = "lo-main", clientId = Harbor, name = "Main office", address = "410 Harbor St", city = "Raleigh", region = "NC", postalCode = "27601", country = "US", phone = "(919) 555-0142", notes = "", primary = true },
        new { id = "lo-cary", clientId = Harbor, name = "Cary office", address = "22 Kildaire Farm Rd", city = "Cary", region = "NC", postalCode = "27511", country = "US", phone = "", notes = "", primary = false },
    ];

    // ---------- archived items, history, related items, and files ----------
    private readonly List<Dictionary<string, object?>> archivedPasswords =
        [Mutable(Pw("p-oldvpn", Cedar, "Cedar Ridge Credit Union", "Old VPN admin", "vpnadmin", "", false, category: "remote"))];

    private readonly List<Dictionary<string, object?>> archivedAssets = [];

    private static object Ref(string type, string id, string title, string subtitle) =>
        new { type, id, title, subtitle, clientId = Harbor, clientName = "Harbor Dental Group", note = "" };

    private static readonly Dictionary<string, object[]> Related = new()
    {
        ["asset:a-fw"] = [Ref("password", "p-fw", "HDG-FW-01 admin", "admin"), Ref("document", "d-reboot", "Firewall reboot procedure", "Document")],
        ["password:p-fw"] = [Ref("asset", "a-fw", "HDG-FW-01", "Configurations")],
        ["document:d-reboot"] = [Ref("asset", "a-fw", "HDG-FW-01", "Configurations")],
    };

    private static readonly Dictionary<string, object[]> Files = new()
    {
        ["asset:a-dc"] = [new { id = "f-quote", filename = "Dell warranty quote.pdf", size = 48213L, uploadedByName = "Alex Rivera", createdAt = Now, contentType = "application/pdf" }],
        ["password:p-fw"] = [new { id = "f-conf", filename = "HDG-FW-01 backup.conf", size = 18034L, uploadedByName = "Alex Rivera", createdAt = Now, contentType = "text/plain" }],
    };

    private async Task<HttpResponseMessage?> ExtrasAsync(HttpRequestMessage request, string tail, string? client, bool archivedList, CancellationToken cancellationToken)
    {
        static HttpResponseMessage Ok(object body) => new(HttpStatusCode.OK) { Content = Json(body) };
        static HttpResponseMessage Bytes(string text) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.UTF8.GetBytes(text)) };
        var get = request.Method == HttpMethod.Get;
        if (get && archivedList)
        {
            object[]? list = tail switch
            {
                "passwords" => [.. archivedPasswords.Cast<object>()],
                "assets" => [.. archivedAssets.Cast<object>()],
                "documents" => [.. docs.Where(d => d.TryGetValue("archived", out var a) && a is true).Cast<object>()],
                _ => null,
            };
            return list is null ? null : Ok(Filter(list, client));
        }
        var archive = System.Text.RegularExpressions.Regex.Match(tail, "^(passwords|assets|documents)/([^/]+)/archive$");
        if (archive.Success && request.Method == HttpMethod.Post)
        {
            var raw = await request.Content!.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var restoring = raw.Contains("\"archived\":false", StringComparison.Ordinal);
            var id = archive.Groups[2].Value;
            if (archive.Groups[1].Value == "documents")
            {
                var doc = docs.FirstOrDefault(d => (string?)d["id"] == id);
                if (doc is null)
                    return null;
                doc["archived"] = !restoring;
                return Ok(doc);
            }
            var (live, gone) = archive.Groups[1].Value == "passwords" ? (passwords, archivedPasswords) : (assets, archivedAssets);
            var (from, to) = restoring ? (gone, live) : (live, gone);
            var found = from.FirstOrDefault(e => (string?)e["id"] == id);
            if (found is null)
                return null;
            from.Remove(found);
            to.Add(found);
            return Ok(found);
        }
        var history = System.Text.RegularExpressions.Regex.Match(tail, "^passwords/([^/]+)/history(/[^/]+/reveal)?$");
        if (history.Success)
        {
            if (history.Groups[2].Success)
                return Ok(new { value = "Harbor-FW-2025!", expiresIn = (int?)null });
            object[] versions = history.Groups[1].Value == "p-fw"
                ?
                [
                    new { id = "h-2", changedByName = "Alex Rivera", createdAt = DateTime.UtcNow.AddDays(-30).ToString("O") },
                    new { id = "h-1", changedByName = "Sam Ortiz", createdAt = DateTime.UtcNow.AddDays(-200).ToString("O") },
                ]
                : [];
            return Ok(versions);
        }
        var item = System.Text.RegularExpressions.Regex.Match(tail, "^items/(password|asset|document)/([^/]+)/(relations|attachments)$");
        if (item.Success && get)
        {
            var key = $"{item.Groups[1].Value}:{item.Groups[2].Value}";
            var table = item.Groups[3].Value == "relations" ? Related : Files;
            return Ok(table.TryGetValue(key, out var rows) ? rows : Array.Empty<object>());
        }
        var passwordFiles = System.Text.RegularExpressions.Regex.Match(tail, "^passwords/([^/]+)/attachments(/[^/]+/download)?$");
        if (passwordFiles.Success)
            return passwordFiles.Groups[2].Success
                ? Bytes("# HDG-FW-01 configuration backup (preview)\n")
                : Ok(Files.TryGetValue($"password:{passwordFiles.Groups[1].Value}", out var rows) ? rows : Array.Empty<object>());
        if (get && System.Text.RegularExpressions.Regex.IsMatch(tail, "^attachments/[^/]+/content$"))
            return Bytes("%PDF-1.4 (preview)\n");
        return null;
    }

    // A 128-pixel orange square with "ID" on it, standing in for an organization's icon.
    private const string PreviewIcon = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAFGklEQVR42u2cX2hbVRzHv+fe/E+a1rR0A+umc2wWRTco6KxOUFSYRWTCVvYiCr7Y4cuUjgllyEAEHZU9CGU+KIKj0mrRMXEoTCnr6Cxjf7rN1rGu1djYmbikSW+Se68Pvm3WntR05J7z/TzfpO35fc73d+7tPQcghBBCiI6I2/nDUp0xl0O+NM1HckIJAVjw2hdCsPB6iyBYeL1FECy83iIYLL53qcbYGyy+3hIIFl7vlmCw+HqngcHi6y2BwSHTG4OzX+8UMFh8vSUwWHy9JeAagGsAzn6dU4AJwATg7Nc5BZgATADOfp1TgAnABCAUgFAA9n891wFMACYAoQCEAhAKQCgAoQCEAhAKQCgAoQCEAhAKQCgAoQCEAhAKQCgAoQCEAhA18NXSL5M4dAFm05olr8v0PInSxGjVvm9RHBtuyYJbWoCbS8PJzMJJJ2H/9jPK0+MoXxmD/cc1CqBuPpoQwQhEMALEEjBX33vLJXZqCqVz32NhuB+lS8OA67IF6ITZvBahp15GQ88xJHrPIfz0qxD+EAXQVYbYKweR6D2DYFsHBdC2cyTuRHzPZ4h3HYYIhCmArgQf24mG/d/CiDdRAG1vs+7ZhPp9QxDRBgqgrQRrH0R890eAELwNrEWyfV2wZy7eNDJBGHUJiFgCZmML/K3t8K1vW/YKP7DpGYS37Ubh6CEKUGvYMxelHiwJfxCBtg5EXngDvjUPVPxzoi/ugzXcDyczyxbgRdySBevkANJ7H8WND16CW8hW9HkRjiGyfS/XAN43wYU1Moj0W1th/3q5oo+Gtu6CiNRTACVaR3ISmQPPwUkn5VMgGEHo8U4KoApOZhY3Du4CykX5BWENPSWkAFWgNHkaheOH5QVobf/nH0wUQB3yX/XCLVlyF5t++O5+iAIo1QrSSVgjg/L33+s2UwDlWsH5E9LXmqvWUQDVKI7/ID/wjS0UQLk2MDcNt5CTG/iGVRRASQlyf0o+DwhTABVxs3NyAvgpgJoCOI7shRRARYxYQq7+xTwFUFOAO+QEkFwsUgAPIUJRiGi99B0DBVAM/4YtgJAb0lrZUUQBqilAa7v0teVr5ymAWvkvKtoMUpocpQAqEdj8LMyW++TiP3WVawDVZn/k+T3Sl1unhvhCiEpEOl6Hf+Mj8gIM91MAZRZ+G7cgunO/fO8f/xHlqbMUQJW+X989CJjy2yvyQ++DG0O83vL9QYS3dSG6owcwTOnPFceOoXj2Owrg2cIHIwi270B0e3fFL3S4hSxyH78J7g2sQczV6+EWb3qh0+eHUdcII94Eo+kuBO5/Av4NDwO+AJa9/zA1RQFqkbrX+lb0+/OD78Ia+QLcHq4hhW8+xPznB8BTwqDf/sH5/reR//I98Jg4zXCy15Hr64J1+ih4TqBuu4ZPDiD3STecv1LgQZH6vAiI4pnjmB94B+VffgJPCtWE8vQFFEe/xsKJT2GnroJHxaqGXYZbXIBrzcPJ/A57bgZ2cgLlK2MoTYzCuT7j+T/xlmOrUp0xl5VXl+YjOcHnAIQCEApAKAChABSAUABCARa7TyTqPgNgAhAKQAEIBeA6QM/+zwQgiwvAFFB/9jMByH8LwBRQe/YzAcjSAjAF1J390glACdQsfkUtgBKoV3yuAUhlAjAF1Jr9y0oASqBO8YF/2RdQCdxD4N3CV2UNwDTwdvGrsgikBN4t/v9uAWwJ3i38ighAEbxT+BUVgCLUfuFviwAUgusqQgghhNQmfwMFvbi39KnpEAAAAABJRU5ErkJggg==";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await Task.Delay(60, cancellationToken).ConfigureAwait(false);
        var path = request.RequestUri!.AbsolutePath;
        var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);
        var client = query["client"];
        var tail = path[(path.IndexOf("/api/v1/", StringComparison.Ordinal) + 8)..];
        if (await ExtrasAsync(request, tail, client, query["archived"] == "true", cancellationToken).ConfigureAwait(false) is { } extra)
            return extra;
        if (await ChangeVaultAsync(request, tail, cancellationToken).ConfigureAwait(false) is { } changed)
            return changed;
        if (await ChangeAssetsAsync(request, tail, cancellationToken).ConfigureAwait(false) is { } changedAsset)
            return changedAsset;
        if (await ChangePeopleAsync(request, tail, cancellationToken).ConfigureAwait(false) is { } changedPerson)
            return changedPerson;
        if (await ChangeDocumentsAsync(request, tail, cancellationToken).ConfigureAwait(false) is { } changedDocument)
            return changedDocument;
        // The organization's own icon (its favicon), so the preview shows the app taking it.
        if (tail == "branding/app-icon")
        {
            var picture = new ByteArrayContent(Convert.FromBase64String(PreviewIcon));
            picture.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = picture };
        }
        if (tail.EndsWith("/password-folders", StringComparison.Ordinal))
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(Array.Empty<object>()) };
        var clientPage = System.Text.RegularExpressions.Regex.Match(tail, "^clients/([^/]+)(/contacts|/locations)?$");
        if (clientPage.Success && notes.ContainsKey(clientPage.Groups[1].Value))
        {
            var id = clientPage.Groups[1].Value;
            if (clientPage.Groups[2].Value == "/contacts")
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(Filter([.. people.Cast<object>()], id)) };
            if (clientPage.Groups[2].Value == "/locations")
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(Filter([.. sites.Cast<object>()], id)) };
            if (request.Method == HttpMethod.Patch)
            {
                var edit = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken).ConfigureAwait(false)).RootElement;
                if (edit.GetProperty("notesVersion").GetInt32() != notes[id].Version)
                    return new HttpResponseMessage(HttpStatusCode.Conflict) { Content = Json(new { error = "Someone else changed the quick note while you were editing it.", code = "conflict" }) };
                notes[id] = (edit.GetProperty("notes").GetString() ?? "", notes[id].Version + 1);
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(ClientDetail(id)) };
        }
        if (request.Method == HttpMethod.Put || request.Method == HttpMethod.Delete)
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = Json(new { favorite = request.Method == HttpMethod.Put }) };
        object? body = tail switch
        {
            "native/session" => Session(),
            "clients" => ClientList(),
            "passwords" => Filter(Vault(), client),
            "assets" => Filter(Things(), client),
            "documents" => Filter(Docs(), client),
            "layouts" => Layouts,
            "favorites" => Favorites,
            "expirations" => Expirations,
            "search" => Search(query["q"] ?? ""),
            _ when tail.StartsWith("passwords/", StringComparison.Ordinal) && tail.EndsWith("/reveal", StringComparison.Ordinal) =>
                (await request.Content!.ReadAsStringAsync(cancellationToken).ConfigureAwait(false)).Contains("\"totp\"")
                    ? new { value = "482193", expiresIn = (int?)18 }
                    : new { value = "c7Hq-29Lm-Vx4r-Np8e", expiresIn = (int?)null },
            _ when tail.StartsWith("passwords/", StringComparison.Ordinal) => Find([.. Vault(), .. archivedPasswords.Cast<object>()], tail[10..]),
            _ when tail.StartsWith("assets/", StringComparison.Ordinal) => Find([.. Things(), .. archivedAssets.Cast<object>()], tail[7..]),
            _ when tail.StartsWith("documents/", StringComparison.Ordinal) => Find([.. docs.Cast<object>()], tail[10..]),
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
        scopes = new[] { "read", "write", "reveal" },
        screenConnect = new { url = "https://itdoneright.screenconnect.demo", group = "All Machines" },
    };

    private static object[] Filter(object[] items, string? client) =>
        client is null ? items : items.Where(i => Prop(i, "clientId") == client).ToArray();

    private static object? Find(object[] items, string id) => items.FirstOrDefault(i => Prop(i, "id") == id);

    private static Dictionary<string, object?>? DocumentFor(string id)
    {
        var doc = Find(Documents, id);
        if (doc is null)
            return null;
        // Keeps each field as written (a string stays a string), so lookups by id find it.
        var copy = Mutable(doc);
        copy["content"] = id switch { "d-reboot" => RebootContent, "d-onboard" => OnboardContent, _ => new { type = "doc", content = Array.Empty<object>() } };
        copy["version"] = 1;
        copy["canEdit"] = true;
        return copy;
    }

    private object[] Search(string q) =>
        Vault().Concat(Things()).Concat(Docs())
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
        item is IDictionary<string, object?> fields
            ? fields.TryGetValue(name, out var value) ? value as string : null
            : item.GetType().GetProperty(name)?.GetValue(item) as string;

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static StringContent Json(object body) => new(JsonSerializer.Serialize(body, Web), Encoding.UTF8, "application/json");
}
