using System.Text;
using Atlas.Windows.Core;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public class ItemExtrasTests
{
    private static AtlasClient Preview()
    {
        var client = new AtlasClient(PreviewServer.Address, new PreviewServer());
        client.UseToken(PreviewServer.Token);
        return client;
    }

    [Fact]
    public async Task Lists_a_passwords_earlier_versions_and_reveals_one()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = Preview();
        var versions = await client.ListPasswordHistoryAsync("p-fw", ct);
        Assert.Equal(["Alex Rivera", "Sam Ortiz"], versions.Select(v => v.ChangedByName));
        Assert.Equal("Harbor-FW-2025!", (await client.RevealOldPasswordAsync("p-fw", versions[0].Id, cancellationToken: ct)).Value);
        Assert.Empty(await client.ListPasswordHistoryAsync("p-m365", ct));
    }

    [Fact]
    public async Task Shows_what_an_item_is_linked_to()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = Preview();
        var related = await client.ListRelatedAsync("asset", "a-fw", ct);
        Assert.Equal([("password", "p-fw"), ("document", "d-reboot")], related.Select(r => (r.Type, r.Id)));
        Assert.Empty(await client.ListRelatedAsync("asset", "a-nas", ct));
    }

    [Fact]
    public async Task Lists_and_downloads_files_on_assets_and_passwords()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = Preview();
        var quote = Assert.Single(await client.ListAttachmentsAsync("asset", "a-dc", ct));
        Assert.Equal(("Dell warranty quote.pdf", 48213L), (quote.Filename, quote.Size));
        Assert.StartsWith("%PDF", Encoding.UTF8.GetString(await client.DownloadAttachmentAsync("asset", "a-dc", quote.Id, cancellationToken: ct)), StringComparison.Ordinal);
        var backup = Assert.Single(await client.ListAttachmentsAsync("password", "p-fw", ct));
        Assert.Contains("configuration backup", Encoding.UTF8.GetString(await client.DownloadAttachmentAsync("password", "p-fw", backup.Id, cancellationToken: ct)), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Archived_items_list_separately_and_can_be_restored()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = Preview();
        Assert.Contains(await client.ListArchivedPasswordsAsync(cancellationToken: ct), p => p.Id == "p-oldvpn");
        await client.ArchivePasswordAsync("p-oldvpn", archived: false, cancellationToken: ct);
        Assert.DoesNotContain(await client.ListArchivedPasswordsAsync(cancellationToken: ct), p => p.Id == "p-oldvpn");
        Assert.Contains(await client.ListPasswordsAsync(cancellationToken: ct), p => p.Id == "p-oldvpn");

        await client.ArchiveAssetAsync("a-nas", cancellationToken: ct);
        Assert.Contains(await client.ListArchivedAssetsAsync(cancellationToken: ct), a => a.Id == "a-nas");
        await client.ArchiveAssetAsync("a-nas", archived: false, cancellationToken: ct);
        Assert.Contains(await client.ListAssetsAsync(cancellationToken: ct), a => a.Id == "a-nas");

        await client.ArchiveDocumentAsync("d-onboard", cancellationToken: ct);
        Assert.Contains(await client.ListArchivedDocumentsAsync(cancellationToken: ct), d => d.Id == "d-onboard");
        await client.ArchiveDocumentAsync("d-onboard", archived: false, cancellationToken: ct);
        Assert.Contains(await client.ListDocumentsAsync(cancellationToken: ct), d => d.Id == "d-onboard");
    }
}
