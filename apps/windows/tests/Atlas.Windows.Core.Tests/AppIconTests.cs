using System.Buffers.Binary;
using System.Net;
using Atlas.Windows.Core;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public class AppIconTests
{
    [Fact]
    public void Writes_an_icon_file_Windows_can_read()
    {
        // A 2-pixel bitmap (blue, green / red, clear) and a 256-pixel PNG.
        byte[] pixels = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0];
        byte[] png = [0x89, (byte)'P', (byte)'N', (byte)'G', 1, 2, 3];
        var file = IconFile.Write([new IconImage(2, Bgra: pixels), new IconImage(256, Png: png)]);

        Assert.Equal<byte>([0, 0, 1, 0, 2, 0], file[..6]);
        var small = file.AsSpan(6, 16);
        var large = file.AsSpan(22, 16);
        Assert.Equal((2, 2, 32), ((int)small[0], (int)small[1], (int)BinaryPrimitives.ReadUInt16LittleEndian(small[6..])));
        // 256 is written as 0.
        Assert.Equal((0, 0), ((int)large[0], (int)large[1]));

        var bitmapAt = (int)BinaryPrimitives.ReadUInt32LittleEndian(small[12..]);
        var bitmapLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(small[8..]);
        Assert.Equal(38, bitmapAt);
        // Header, pixels, and a mask of one 4-byte row per line.
        Assert.Equal(40 + 16 + 4 * 2, bitmapLength);
        var bitmap = file.AsSpan(bitmapAt, bitmapLength);
        Assert.Equal(2, BinaryPrimitives.ReadInt32LittleEndian(bitmap[4..]));
        Assert.Equal(4, BinaryPrimitives.ReadInt32LittleEndian(bitmap[8..]));
        // Bottom row first.
        Assert.Equal(pixels[8..16], bitmap.Slice(40, 8).ToArray());
        Assert.Equal(pixels[..8], bitmap.Slice(48, 8).ToArray());

        var pngAt = (int)BinaryPrimitives.ReadUInt32LittleEndian(large[12..]);
        Assert.Equal(bitmapAt + bitmapLength, pngAt);
        Assert.Equal(png, file[pngAt..]);
    }

    [Fact]
    public void Refuses_pictures_that_dont_fit()
    {
        Assert.Throws<ArgumentException>(() => IconFile.Write([new IconImage(2, Bgra: new byte[3])]));
        Assert.Throws<ArgumentOutOfRangeException>(() => IconFile.Write([new IconImage(300, Png: [1])]));
    }

    [Fact]
    public async Task Fetches_the_icon_only_when_it_has_changed()
    {
        var ct = TestContext.Current.CancellationToken;
        var server = new IconServer();
        using var client = new AtlasClient(AtlasAddress.Parse("https://atlas.example.com"), server);

        var first = await client.GetAppIconAsync(null, ct);
        Assert.Equal<byte>([1, 2, 3], first.Picture!);
        Assert.Equal("\"v1\"", first.ETag);
        Assert.Equal("https://atlas.example.com/api/v1/branding/app-icon", server.Asked);

        Assert.True((await client.GetAppIconAsync("\"v1\"", ct)).IsUnchanged);

        server.HasIcon = false;
        var none = await client.GetAppIconAsync("\"v1\"", ct);
        Assert.Null(none.Picture);
        Assert.False(none.IsUnchanged);
    }

    private sealed class IconServer : HttpMessageHandler
    {
        public bool HasIcon { get; set; } = true;
        public string? Asked { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Asked = request.RequestUri!.ToString();
            if (!HasIcon)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            if (request.Headers.IfNoneMatch.ToString() == "\"v1\"")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotModified));
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([1, 2, 3]) };
            response.Headers.ETag = new System.Net.Http.Headers.EntityTagHeaderValue("\"v1\"");
            return Task.FromResult(response);
        }
    }
}
