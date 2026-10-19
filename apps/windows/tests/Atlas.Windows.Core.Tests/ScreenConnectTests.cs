using System.Text.Json;
using Atlas.Windows.Core;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public class ScreenConnectTests
{
    private static readonly ScreenConnectInfo Instance = new("https://itdoneright.screenconnect.com/", "All Machines");

    private static readonly LayoutInfo Layout = new("l-config", "Configurations", "server",
    [
        new LayoutField("hostname", "Hostname", "text"),
        new LayoutField("sc", "ScreenConnect session", "text"),
    ]);

    private static AssetSummary Asset(string name, object fields) =>
        new("a-1", "c-1", "Harbor Dental Group", "l-config", "Configurations", name, "active",
            JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(fields))!, "", "2026-10-19T00:00:00Z");

    [Fact]
    public void Joins_the_session_when_the_asset_records_its_ID()
    {
        var asset = Asset("HDG-DC-01", new { hostname = "hdg-dc-01.harbor.local", sc = "6F1C2A9E-4B7D-4E2A-9C31-0D5B8E7F4A12" });
        Assert.Equal(
            "https://itdoneright.screenconnect.com/Host#Access/All%20Machines//6f1c2a9e-4b7d-4e2a-9c31-0d5b8e7f4a12/Join",
            Instance.LinkFor(asset, Layout)!.AbsoluteUri);
    }

    [Fact]
    public void Takes_the_session_ID_out_of_a_pasted_ScreenConnect_link()
    {
        var asset = Asset("HDG-DC-01", new { sc = "https://itdoneright.screenconnect.com/Host#Access/All Machines//6f1c2a9e-4b7d-4e2a-9c31-0d5b8e7f4a12" });
        Assert.Equal("6f1c2a9e-4b7d-4e2a-9c31-0d5b8e7f4a12", ScreenConnectInfo.SessionIdOf(asset, Layout));
    }

    [Fact]
    public void Otherwise_searches_for_the_host_name_without_its_domain()
    {
        var asset = Asset("Front desk PC", new { hostname = "hdg-frontdesk-02.harbor.local" });
        Assert.Null(ScreenConnectInfo.SessionIdOf(asset, Layout));
        Assert.Equal(
            "https://itdoneright.screenconnect.com/Host#Access/All%20Machines/hdg-frontdesk-02",
            Instance.LinkFor(asset, Layout)!.AbsoluteUri);
    }

    [Fact]
    public void Falls_back_to_the_asset_name_and_ignores_IDs_in_unrelated_fields()
    {
        var asset = Asset("HDG-FW-01", new { serial = "6f1c2a9e-4b7d-4e2a-9c31-0d5b8e7f4a12" });
        Assert.Null(ScreenConnectInfo.SessionIdOf(asset, Layout));
        Assert.Equal("HDG-FW-01", ScreenConnectInfo.NameToFind(asset, Layout));
    }

    [Fact]
    public void Only_opens_a_secure_address() =>
        Assert.Null(new ScreenConnectInfo("http://itdoneright.screenconnect.com", "All Machines").LinkFor(Asset("X", new { }), Layout));

    [Fact]
    public async Task The_preview_offers_ScreenConnect_with_the_session()
    {
        using var client = new AtlasClient(PreviewServer.Address, new PreviewServer());
        client.UseToken(PreviewServer.Token);
        var session = await client.GetSessionAsync(TestContext.Current.CancellationToken);
        Assert.Equal("https://itdoneright.screenconnect.demo", session.ScreenConnect!.Url);
        var firewall = await client.GetAssetAsync("a-fw", TestContext.Current.CancellationToken);
        Assert.EndsWith("/Join", session.ScreenConnect.LinkFor(firewall, null)!.AbsoluteUri, StringComparison.Ordinal);
    }
}
