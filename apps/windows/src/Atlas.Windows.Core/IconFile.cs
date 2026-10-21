using System.Buffers.Binary;

namespace Atlas.Windows.Core;

/// <summary>One picture in an icon file: a square of <see cref="Size"/> pixels, as BGRA pixels or a PNG.</summary>
/// <param name="Bgra">Top row first, four bytes a pixel, alpha not premultiplied.</param>
public sealed record IconImage(int Size, byte[]? Bgra = null, byte[]? Png = null);

/// <summary>
/// Writes a Windows .ico file. Small sizes are stored as bitmaps, which everything that reads icons understands (the
/// tray, shortcuts, the title bar); 256 pixels is stored as a PNG, as Windows expects at that size.
/// </summary>
public static class IconFile
{
    public static byte[] Write(IReadOnlyList<IconImage> images)
    {
        ArgumentNullException.ThrowIfNull(images);
        var bodies = images.Select(Body).ToList();
        using var file = new MemoryStream();
        var header = new byte[6 + 16 * images.Count];
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(2), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(4), (ushort)images.Count);
        var offset = header.Length;
        for (var i = 0; i < images.Count; i++)
        {
            var entry = header.AsSpan(6 + 16 * i, 16);
            var size = images[i].Size;
            // 256 is written as 0: the field is one byte.
            entry[0] = (byte)(size >= 256 ? 0 : size);
            entry[1] = (byte)(size >= 256 ? 0 : size);
            BinaryPrimitives.WriteUInt16LittleEndian(entry[4..], 1);
            BinaryPrimitives.WriteUInt16LittleEndian(entry[6..], 32);
            BinaryPrimitives.WriteUInt32LittleEndian(entry[8..], (uint)bodies[i].Length);
            BinaryPrimitives.WriteUInt32LittleEndian(entry[12..], (uint)offset);
            offset += bodies[i].Length;
        }
        file.Write(header);
        foreach (var body in bodies)
            file.Write(body);
        return file.ToArray();
    }

    private static byte[] Body(IconImage image)
    {
        if (image.Size is < 1 or > 256)
            throw new ArgumentOutOfRangeException(nameof(image), "Icons are 1 to 256 pixels square.");
        if (image.Png is { } png)
            return png;
        var size = image.Size;
        var pixels = image.Bgra ?? throw new ArgumentException("An icon picture needs pixels or a PNG.", nameof(image));
        if (pixels.Length != size * size * 4)
            throw new ArgumentException("The pixels don't match the size.", nameof(image));
        // A BITMAPINFOHEADER, the rows bottom first, then a transparency mask (all clear: the alpha channel decides).
        var maskRow = (size + 31) / 32 * 4;
        var body = new byte[40 + pixels.Length + maskRow * size];
        var info = body.AsSpan();
        BinaryPrimitives.WriteUInt32LittleEndian(info, 40);
        BinaryPrimitives.WriteInt32LittleEndian(info[4..], size);
        // Twice the height: the picture and its mask.
        BinaryPrimitives.WriteInt32LittleEndian(info[8..], size * 2);
        BinaryPrimitives.WriteUInt16LittleEndian(info[12..], 1);
        BinaryPrimitives.WriteUInt16LittleEndian(info[14..], 32);
        BinaryPrimitives.WriteUInt32LittleEndian(info[20..], (uint)(pixels.Length + maskRow * size));
        var row = size * 4;
        for (var y = 0; y < size; y++)
            pixels.AsSpan((size - 1 - y) * row, row).CopyTo(body.AsSpan(40 + y * row));
        return body;
    }
}
